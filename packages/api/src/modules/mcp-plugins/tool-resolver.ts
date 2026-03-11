import type { ToolDefinition, GroupMemberEntry } from '@synapse/shared';
import type { NormalizedMcpToolResult } from '@synapse/shared/types';

const MCP_TOOL_NAMESPACE_SEPARATOR = '__';
import { query } from '../../infrastructure/database/index.js';
import { resolveInstallationConfig } from './config-resolver.js';
import { getOrCreateInstance, getMcpVersion, McpInstance } from './instance-manager.js';
import { logToolCall } from './audit.js';
import { callRelayTool } from './relay-manager.js';
import { normalizeMcpToolResult } from './result-normalizer.js';

export interface ResolvedMcpTools {
  tools: ToolDefinition[];
  executor: (toolName: string, input: Record<string, unknown>) => Promise<NormalizedMcpToolResult>;
  mcpVersion: number;
  refresh: () => Promise<{ tools: ToolDefinition[]; mcpVersion: number }>;
  setTurnId: (turnId: string, round?: number) => void;
}

interface ResolveParams {
  actorId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
  groupId?: string;
  groupMembers?: GroupMemberEntry[];
}

/**
 * Core tool resolution logic — shared by initial resolve and refresh.
 * Queries DB, de-duplicates, creates instances, returns namespaced tools.
 * Handles both regular MCP plugins AND relay plugins (transport='relay') in one unified query.
 */
async function resolveTools(
  params: ResolveParams,
  instances: Map<string, McpInstance>,
): Promise<ToolDefinition[]> {
  const { actorId, workspaceId, sessionId, userId, groupId, groupMembers } = params;

  const scopeIds = [workspaceId];
  if (userId) scopeIds.push(userId);
  scopeIds.push(actorId);
  if (groupId) scopeIds.push(groupId);

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
         WHEN 'group' THEN 1
         WHEN 'actor' THEN 2
         WHEN 'user' THEN 3
         WHEN 'workspace' THEN 4
       END`,
    [workspaceId, scopeIds]
  );

  if (result.rows.length === 0) {
    return [];
  }

  // De-duplicate by plugin_id — most specific scope wins (group > actor > user > workspace)
  const seenPlugins = new Set<string>();
  let installations: typeof result.rows = [];
  for (const row of result.rows) {
    if (!seenPlugins.has(row.plugin_id)) {
      seenPlugins.add(row.plugin_id);
      installations.push(row);
    }
  }

  // User scope post-filter: only allow when exactly 1 user in the group AND that user matches scope_id
  const groupUsers = groupMembers?.filter(m => m.type === 'user') ?? [];
  installations = installations.filter(inst => {
    if (inst.scope_type === 'user') {
      // Outside group context: allow if userId matches scope_id (already filtered by SQL)
      if (!groupId) return true;
      // In group: must have exactly 1 user, and that user must be the scope target
      if (groupUsers.length !== 1) return false;
      if (groupUsers[0].id !== inst.scope_id) return false;
    }
    return true;
  });

  const allTools: ToolDefinition[] = [];

  for (const install of installations) {
    try {
      if (install.transport === 'relay') {
        // Relay plugin — create lightweight instance from entry_point metadata
        const { relayId, serverName } = JSON.parse(install.entry_point);

        const namespace = `${install.org_slug}${MCP_TOOL_NAMESPACE_SEPARATOR}${install.plugin_slug}`;

        // Parse tools from manifest
        const tools: ToolDefinition[] = Array.isArray(install.tools_manifest)
          ? install.tools_manifest
          : JSON.parse(install.tools_manifest || '[]');

        const relayInstance: McpInstance = {
          pluginId: install.plugin_id,
          pluginSlug: install.plugin_slug,
          orgSlug: install.org_slug,
          transport: 'relay',
          scope: install.lifecycle_scope,
          scopeId: install.scope_id,
          workspaceId,
          configHash: `relay:${relayId}:${serverName}`,
          tools,
          execute: async (toolName: string, input: Record<string, unknown>) => {
            return callRelayTool(relayId, serverName, toolName, input);
          },
          shutdown: async () => { /* relay connection managed independently */ },
          lastUsed: Date.now(),
          createdAt: Date.now(),
        };

        const namespacedTools = tools.map(tool => ({
          ...tool,
          name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
          description: `[${install.org_slug}/${install.plugin_slug}] ${tool.description}`,
        }));

        allTools.push(...namespacedTools);
        instances.set(namespace, relayInstance);
      } else {
        // Regular plugin (builtin, http, stdio)
        const resolved = await resolveInstallationConfig(install.install_id);

        let scopeId: string;
        switch (install.lifecycle_scope) {
          case 'workspace': scopeId = workspaceId; break;
          case 'user': scopeId = userId || sessionId; break;
          case 'actor': scopeId = actorId; break;
          case 'group': scopeId = groupId || sessionId; break;
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
      }
    } catch (error: any) {
      console.error(`[MCP ToolResolver] Failed to initialize plugin ${install.org_slug}/${install.plugin_slug}:`, error.message);
    }
  }

  return allTools;
}

/**
 * Resolve all available MCP tools for an actor session.
 * Unified entry point — handles regular plugins AND relay plugins
 * through a single mcp_installations query.
 */
export async function resolveMcpToolsForActor(params: {
  actorId: string;
  workspaceId: string;
  sessionId: string;
  userId?: string;
  groupId?: string;
  groupMembers?: GroupMemberEntry[];
}): Promise<ResolvedMcpTools> {
  const { actorId, workspaceId, sessionId, userId } = params;

  // Read current MCP version
  const mcpVersion = await getMcpVersion(workspaceId);

  // Mutable state — shared by executor and refresh
  const instances: Map<string, McpInstance> = new Map();

  // Single unified resolveTools — no separate resolveRelayTools
  const allTools = await resolveTools(params, instances);

  // Build unified executor — references the mutable `instances` Map.
  let currentTurnId: string | undefined;
  let currentRound: number | undefined;
  const setTurnId = (turnId: string, round?: number) => { currentTurnId = turnId; currentRound = round; };

  const executor = async (namespacedToolName: string, input: Record<string, unknown>): Promise<NormalizedMcpToolResult> => {
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
    let rawOutput: unknown;
    let isError = false;
    let errorMessage: string | undefined;

    try {
      rawOutput = await instance.execute(toolName, input);
      return await normalizeMcpToolResult(rawOutput, workspaceId);
    } catch (error: any) {
      isError = true;
      errorMessage = error.message;
      throw error;
    } finally {
      const isRelay = instance.transport === 'relay';
      let relayId: string | undefined;
      if (isRelay && instance.configHash.startsWith('relay:')) {
        const relayParts = instance.configHash.split(':');
        if (relayParts.length >= 2) relayId = relayParts[1];
      }
      logToolCall({
        workspaceId,
        sessionId,
        turnId: currentTurnId,
        round: currentRound,
        actorId,
        userId,
        pluginId: instance.pluginId,
        relayId,
        toolName: namespacedToolName,
        toolType: isRelay ? 'relay' : 'mcp_plugin',
        input,
        output: typeof rawOutput === 'string' ? rawOutput : rawOutput ? JSON.stringify(rawOutput) : undefined,
        isError,
        errorMessage,
        durationMs: Date.now() - startTime,
        transport: instance.transport,
        instanceKey: `${instance.pluginId}:${instance.scope}:${instance.scopeId}`,
      });
    }
  };

  // Refresh function — re-queries DB, rebuilds instances map
  const refresh = async (): Promise<{ tools: ToolDefinition[]; mcpVersion: number }> => {
    const newVersion = await getMcpVersion(workspaceId);
    instances.clear();
    const newTools = await resolveTools(params, instances);
    return { tools: newTools, mcpVersion: newVersion };
  };

  return { tools: allTools, executor, mcpVersion, refresh, setTurnId };
}
