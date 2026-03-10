import { ToolDefinition } from '@synapse/shared';

const MCP_TOOL_NAMESPACE_SEPARATOR = '__';
import { query } from '../../infrastructure/database/index.js';
import { resolveInstallationConfig } from './config-resolver.js';
import { getOrCreateInstance, getMcpVersion, McpInstance } from './instance-manager.js';
import { logToolCall } from './audit.js';
import { getConnectedRelayServers, callRelayTool } from './relay-manager.js';

export interface ResolvedMcpTools {
  tools: ToolDefinition[];
  executor: (toolName: string, input: Record<string, unknown>) => Promise<string | unknown[]>;
  mcpVersion: number;
  refresh: () => Promise<{ tools: ToolDefinition[]; mcpVersion: number }>;
  setTurnId: (turnId: string, round?: number) => void;
}

interface ResolveParams {
  actorId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
}

/**
 * Core tool resolution logic — shared by initial resolve and refresh.
 * Queries DB, de-duplicates, creates instances, returns namespaced tools.
 */
async function resolveTools(
  params: ResolveParams,
  instances: Map<string, McpInstance>,
): Promise<ToolDefinition[]> {
  const { actorId, workspaceId, sessionId, userId } = params;

  const scopeIds = [workspaceId];
  if (userId) scopeIds.push(userId);
  scopeIds.push(actorId);

  const result = await query(
    `SELECT i.id as install_id, i.plugin_id, i.scope_type, i.scope_id, i.lifecycle_scope, i.config_data,
            p.slug as plugin_slug, p.transport, p.entry_point, p.config_schema,
            p.tools_manifest,
            o.slug as org_slug
     FROM mcp_installations i
     JOIN mcp_plugins p ON p.id = i.plugin_id AND p.is_active = TRUE
     JOIN mcp_organizations o ON o.id = p.org_id
     WHERE i.workspace_id = $1
       AND i.is_enabled = TRUE
       AND i.scope_id = ANY($2)
     ORDER BY
       CASE i.scope_type
         WHEN 'actor' THEN 1
         WHEN 'user' THEN 2
         WHEN 'workspace' THEN 3
       END`,
    [workspaceId, scopeIds]
  );

  if (result.rows.length === 0) {
    return [];
  }

  // De-duplicate by plugin_id — most specific scope wins (actor > user > workspace)
  const seenPlugins = new Set<string>();
  const installations: typeof result.rows = [];
  for (const row of result.rows) {
    if (!seenPlugins.has(row.plugin_id)) {
      seenPlugins.add(row.plugin_id);
      installations.push(row);
    }
  }

  const allTools: ToolDefinition[] = [];

  for (const install of installations) {
    try {
      const resolved = await resolveInstallationConfig(install.install_id);

      let scopeId: string;
      switch (install.lifecycle_scope) {
        case 'workspace': scopeId = workspaceId; break;
        case 'user': scopeId = userId || sessionId; break;
        case 'actor': scopeId = actorId; break;
        case 'session': scopeId = sessionId; break;
        default: scopeId = sessionId;
      }

      const instance = await getOrCreateInstance({
        pluginId: install.plugin_id,
        pluginSlug: install.plugin_slug,
        orgSlug: install.org_slug,
        transport: install.transport,
        entryPoint: install.entry_point,
        scope: install.lifecycle_scope,
        scopeId,
        config: resolved.config,
        workspaceId,
      });

      const namespace = `${install.org_slug}${MCP_TOOL_NAMESPACE_SEPARATOR}${install.plugin_slug}`;
      const namespacedTools = instance.tools.map(tool => ({
        ...tool,
        name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
        description: `[${install.org_slug}/${install.plugin_slug}] ${tool.description}`,
      }));

      allTools.push(...namespacedTools);
      instances.set(namespace, instance);
    } catch (error: any) {
      console.error(`[MCP ToolResolver] Failed to initialize plugin ${install.org_slug}/${install.plugin_slug}:`, error.message);
    }
  }

  return allTools;
}

/**
 * Resolve relay tools from all connected relay agents for a workspace.
 * Creates lightweight McpInstance entries in the shared instances map so
 * the executor can dispatch tool calls to relays using the same namespace pattern.
 */
async function resolveRelayTools(
  params: ResolveParams,
  instances: Map<string, McpInstance>,
): Promise<ToolDefinition[]> {
  const { workspaceId, userId } = params;

  const relayServers = getConnectedRelayServers(workspaceId, userId);
  if (relayServers.length === 0) return [];

  // Also check which relay servers are enabled in DB
  const enabledResult = await query(
    `SELECT rs.relay_id, rs.name, rs.is_enabled
     FROM mcp_relay_servers rs
     JOIN mcp_relays r ON r.id = rs.relay_id
     WHERE r.workspace_id = $1`,
    [workspaceId]
  );
  const enabledMap = new Map<string, boolean>();
  for (const row of enabledResult.rows) {
    enabledMap.set(`${row.relay_id}:${row.name}`, row.is_enabled);
  }

  const allTools: ToolDefinition[] = [];

  for (const server of relayServers) {
    // Check if server is enabled
    const key = `${server.relayId}:${server.serverName}`;
    if (enabledMap.has(key) && !enabledMap.get(key)) continue;

    const relayPrefix = `relay_${server.relayId.slice(0, 8)}`;
    const namespace = `${relayPrefix}${MCP_TOOL_NAMESPACE_SEPARATOR}${server.serverName}`;

    // Create lightweight McpInstance for the relay server
    const relayInstance: McpInstance = {
      pluginId: `relay:${server.relayId}:${server.serverName}`,
      pluginSlug: server.serverName,
      orgSlug: relayPrefix,
      transport: 'relay',
      scope: 'workspace',
      scopeId: workspaceId,
      workspaceId,
      configHash: 'relay',
      tools: server.tools,
      execute: async (toolName: string, input: Record<string, unknown>) => {
        return callRelayTool(server.relayId, server.serverName, toolName, input);
      },
      shutdown: async () => { /* no-op for relay */ },
      lastUsed: Date.now(),
      createdAt: Date.now(),
    };

    const namespacedTools = server.tools.map(tool => ({
      ...tool,
      name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
      description: `[relay/${server.relayName}/${server.serverName}] ${tool.description}`,
    }));

    allTools.push(...namespacedTools);
    instances.set(namespace, relayInstance);
  }

  return allTools;
}

/**
 * Resolve all available MCP tools for an actor session.
 * Queries the unified mcp_installations table, de-duplicates by plugin_id
 * (most specific scope wins: actor > user > workspace).
 * Also resolves tools from connected relay agents.
 *
 * Session-scoped instances are managed by TTL (30 min) in instance-manager
 * and explicitly cleaned up on session cancellation/failure.
 */
export async function resolveMcpToolsForActor(params: {
  actorId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
}): Promise<ResolvedMcpTools> {
  const { actorId, workspaceId, sessionId, userId } = params;

  // Read current MCP version
  const mcpVersion = await getMcpVersion(workspaceId);

  // Mutable state — shared by executor and refresh
  const instances: Map<string, McpInstance> = new Map();

  // Resolve plugin tools + relay tools in parallel
  const [pluginTools, relayTools] = await Promise.all([
    resolveTools(params, instances),
    resolveRelayTools(params, instances),
  ]);
  const allTools = [...pluginTools, ...relayTools];

  // Build unified executor — references the mutable `instances` Map.
  // Created unconditionally so refresh() can add tools mid-session even if none exist initially.
  let currentTurnId: string | undefined;
  let currentRound: number | undefined;
  const setTurnId = (turnId: string, round?: number) => { currentTurnId = turnId; currentRound = round; };

  const executor = async (namespacedToolName: string, input: Record<string, unknown>): Promise<string | unknown[]> => {
    const parts = namespacedToolName.split(MCP_TOOL_NAMESPACE_SEPARATOR);
    if (parts.length < 3) {
      throw new Error(`Invalid namespaced tool name: ${namespacedToolName}`);
    }

    const orgSlug = parts[0];
    const pluginSlug = parts[1];
    const toolName = parts.slice(2).join(MCP_TOOL_NAMESPACE_SEPARATOR);
    const namespace = `${orgSlug}${MCP_TOOL_NAMESPACE_SEPARATOR}${pluginSlug}`;

    const instance = instances.get(namespace);
    if (!instance) {
      throw new Error(`No MCP instance found for ${namespace}`);
    }

    const startTime = Date.now();
    let output: string | unknown[] | undefined;
    let isError = false;
    let errorMessage: string | undefined;

    try {
      output = await instance.execute(toolName, input);
      return output;
    } catch (error: any) {
      isError = true;
      errorMessage = error.message;
      throw error;
    } finally {
      // Log all tool calls — relay, MCP plugin, etc.
      const isRelay = instance.transport === 'relay';
      let relayId: string | undefined;
      if (isRelay) {
        // Extract relay UUID from composite pluginId: "relay:{uuid}:{serverName}"
        const relayParts = instance.pluginId.split(':');
        if (relayParts.length >= 2) relayId = relayParts[1];
      }
      logToolCall({
        workspaceId,
        sessionId,
        turnId: currentTurnId,
        round: currentRound,
        actorId,
        userId,
        pluginId: isRelay ? null : instance.pluginId,
        relayId,
        toolName: namespacedToolName,
        toolType: isRelay ? 'relay' : 'mcp_plugin',
        input,
        output: typeof output === 'string' ? output : output ? JSON.stringify(output) : undefined,
        isError,
        errorMessage,
        durationMs: Date.now() - startTime,
        transport: instance.transport,
        instanceKey: `${instance.pluginId}:${instance.scope}:${instance.scopeId}`,
      });
    }
  };

  // Refresh function — re-queries DB + relay, rebuilds instances map
  const refresh = async (): Promise<{ tools: ToolDefinition[]; mcpVersion: number }> => {
    const newVersion = await getMcpVersion(workspaceId);
    instances.clear();
    const [newPluginTools, newRelayTools] = await Promise.all([
      resolveTools(params, instances),
      resolveRelayTools(params, instances),
    ]);
    return { tools: [...newPluginTools, ...newRelayTools], mcpVersion: newVersion };
  };

  return { tools: allTools, executor, mcpVersion, refresh, setTurnId };
}
