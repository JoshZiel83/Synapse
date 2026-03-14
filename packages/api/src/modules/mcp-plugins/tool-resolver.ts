import { randomUUID } from 'crypto';
import type { ToolDefinition } from '@synapse/shared';
import type { NormalizedMcpToolResult } from '@synapse/shared/types';
import type { CapabilityInstance, CapabilityPackageTool } from '@synapse/shared';

import { listAuthorizedCapabilityInstances } from '../capabilities/service.js';
import { resolveInstallationConfig } from './config-resolver.js';
import { getOrCreateInstance, getMcpVersion, type McpInstance } from './instance-manager.js';
import { logToolCall } from './audit.js';
import { callRelayTool } from './relay-manager.js';
import { normalizeMcpToolResult } from './result-normalizer.js';

const MCP_TOOL_NAMESPACE_SEPARATOR = '__';

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
  conversationId: string;
  userId?: string;
}

function dedupeInstances(instances: CapabilityInstance[]) {
  const seenPackages = new Set<string>();
  const deduped: CapabilityInstance[] = [];
  for (const instance of instances) {
    if (seenPackages.has(instance.packageId)) continue;
    seenPackages.add(instance.packageId);
    deduped.push(instance);
  }
  return deduped;
}

function resolveReuseOwnerKey(instance: CapabilityInstance, params: ResolveParams, turnOwnerKey: string) {
  switch (instance.reuseScope) {
    case 'workspace':
      return params.workspaceId;
    case 'conversation':
      return params.conversationId;
    case 'actor_global':
      return params.actorId;
    case 'actor_conversation':
      return `${params.actorId}:${params.conversationId}`;
    case 'user':
      return params.userId
        ? `workspace:${params.workspaceId}:user:${params.userId}`
        : params.conversationId;
    case 'turn':
      return turnOwnerKey;
    default:
      return params.conversationId;
  }
}

function manifestToolToDefinition(tool: CapabilityPackageTool): ToolDefinition {
  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;
  const properties =
    inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
      ? ((inputSchema.properties as Record<string, unknown> | undefined) || {})
      : {};
  const required =
    inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
      ? ((inputSchema.required as string[] | undefined) || [])
      : [];

  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: properties as ToolDefinition['parameters']['properties'],
      required,
    },
  };
}

async function resolveTools(
  params: ResolveParams,
  instances: Map<string, McpInstance>,
  turnOwnerKey: string,
): Promise<ToolDefinition[]> {
  const instancesToUse = dedupeInstances(
    await listAuthorizedCapabilityInstances({
      workspaceId: params.workspaceId,
      kind: 'plugin',
      actorId: params.actorId,
      conversationId: params.conversationId,
    }),
  );

  const allTools: ToolDefinition[] = [];

  for (const instance of instancesToUse) {
    const pkg = instance.package;
    const revision = instance.revision;
    if (!pkg || !revision || !revision.transport) {
      continue;
    }

    try {
      const namespace = `${pkg.publisher?.slug || 'plugin'}${MCP_TOOL_NAMESPACE_SEPARATOR}${pkg.slug}`;

      if (revision.transport === 'relay') {
        const { relayId, serverName } = JSON.parse(revision.entryPoint || '{}') as {
          relayId?: string;
          serverName?: string;
        };
        if (!relayId || !serverName) {
          throw new Error(`Relay plugin ${namespace} is missing relay entry point metadata`);
        }

        const tools = Array.isArray(revision.toolsManifest)
          ? revision.toolsManifest.map(manifestToolToDefinition)
          : [];
        const relayInstance: McpInstance = {
          pluginId: instance.packageId,
          pluginSlug: pkg.slug,
          orgSlug: pkg.publisher?.slug || 'plugin',
          transport: 'relay',
          scope: instance.reuseScope,
          scopeId: resolveReuseOwnerKey(instance, params, turnOwnerKey),
          workspaceId: params.workspaceId,
          configHash: `relay:${relayId}:${serverName}`,
          tools,
          execute: async (toolName: string, input: Record<string, unknown>) => {
            return callRelayTool(relayId, serverName, toolName, input);
          },
          shutdown: async () => {
            // Relay connection lifecycle is managed independently from per-turn tool resolution.
          },
          lastUsed: Date.now(),
          createdAt: Date.now(),
          idleTtlMs: instance.idleTtlMs ?? 0,
          maxAgeMs: instance.maxAgeMs ?? undefined,
        };

        const namespacedTools = tools.map((tool: ToolDefinition) => ({
          ...tool,
          name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
          description: `[${pkg.publisher?.slug || 'plugin'}/${pkg.slug}] ${tool.description}`,
        }));

        allTools.push(...namespacedTools);
        instances.set(namespace, relayInstance);
        continue;
      }

      const resolved = await resolveInstallationConfig(instance.id);
      const runtimeInstance = await getOrCreateInstance({
        pluginId: instance.packageId,
        pluginSlug: pkg.slug,
        orgSlug: pkg.publisher?.slug || 'plugin',
        transport: revision.transport,
        entryPoint: revision.entryPoint || '',
        scope: instance.reuseScope,
        scopeId: resolveReuseOwnerKey(instance, params, turnOwnerKey),
        config: resolved.config,
        workspaceId: params.workspaceId,
        idleTtlMs: instance.idleTtlMs ?? undefined,
        maxAgeMs: instance.maxAgeMs ?? undefined,
      });

      const namespacedTools = runtimeInstance.tools.map((tool: ToolDefinition) => ({
        ...tool,
        name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
        description: `[${pkg.publisher?.slug || 'plugin'}/${pkg.slug}] ${tool.description}`,
      }));

      allTools.push(...namespacedTools);
      instances.set(namespace, runtimeInstance);
    } catch (error: any) {
      console.error(
        `[MCP ToolResolver] Failed to initialize plugin ${instance.package?.publisher?.slug || 'plugin'}/${instance.package?.slug}:`,
        error.message,
      );
    }
  }

  return allTools;
}

export async function resolveMcpToolsForActor(params: ResolveParams): Promise<ResolvedMcpTools> {
  const { actorId, workspaceId, sessionId, userId } = params;
  const mcpVersion = await getMcpVersion(workspaceId);
  const turnOwnerKey = `session:${sessionId}:turn:${randomUUID()}`;
  const instances = new Map<string, McpInstance>();
  const allTools = await resolveTools(params, instances, turnOwnerKey);

  let currentTurnId: string | undefined;
  let currentRound: number | undefined;
  const setTurnId = (turnId: string, round?: number) => {
    currentTurnId = turnId;
    currentRound = round;
  };

  const executor = async (
    namespacedToolName: string,
    input: Record<string, unknown>,
  ): Promise<NormalizedMcpToolResult> => {
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
        output:
          typeof rawOutput === 'string'
            ? rawOutput
            : rawOutput
              ? JSON.stringify(rawOutput)
              : undefined,
        isError,
        errorMessage,
        durationMs: Date.now() - startTime,
        transport: instance.transport,
        instanceKey: `${instance.pluginId}:${instance.scope}:${instance.scopeId}`,
      });
    }
  };

  const refresh = async (): Promise<{ tools: ToolDefinition[]; mcpVersion: number }> => {
    const newVersion = await getMcpVersion(workspaceId);
    instances.clear();
    const newTools = await resolveTools(params, instances, turnOwnerKey);
    return { tools: newTools, mcpVersion: newVersion };
  };

  return { tools: allTools, executor, mcpVersion, refresh, setTurnId };
}
