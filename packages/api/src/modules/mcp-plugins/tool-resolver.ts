import { randomUUID } from "crypto";
import type { RelayHiddenToolBinding, ToolDefinition } from "@synapse/shared";
import type { NormalizedMcpToolResult } from "@synapse/shared/types";
import {
  buildActorConversationContextId,
  lookupResources,
  type AuthzSubject,
} from "../../infrastructure/authz/index.js";
import { query } from "../../infrastructure/database/index.js";
import { resolveInstallationConfig } from "./config-resolver.js";
import {
  getMcpVersion,
  getOrCreateInstance,
  type McpInstance,
} from "./instance-manager.js";
import { logToolCall } from "./audit.js";
import {
  callRelayTool,
  closeRelayRuntimeSession,
  getConnectedRelaySessionId,
  getRelayExposureCatalog,
  openRelayRuntimeSession,
} from "./relay-manager.js";
import { normalizeMcpToolResult } from "./result-normalizer.js";

const MCP_TOOL_NAMESPACE_SEPARATOR = "__";

export interface ResolvedMcpTools {
  tools: ToolDefinition[];
  executor: (toolName: string, input: Record<string, unknown>) => Promise<NormalizedMcpToolResult>;
  mcpVersion: number;
  refresh: () => Promise<{ tools: ToolDefinition[]; mcpVersion: number }>;
  setTurnId: (turnId: string, round?: number) => void;
  shutdown: () => Promise<void>;
}

interface ResolveParams {
  actorId: string;
  workspaceId: string;
  sessionId: string;
  conversationId: string;
  userId?: string;
}

export interface ResolvedRelayToolTarget {
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  visibleToolName: string;
  runtimeSessionId?: string;
}

type VisiblePluginRow = {
  installation_id: string;
  installation_status: "active" | "disabled" | "error" | "archived";
  catalog_item_id: string;
  item_slug: string;
  publisher_slug: string;
  transport: "builtin" | "stdio" | "http" | "relay";
  entry_point: string | null;
  tool_manifest: unknown;
  reuse_scope: "turn" | "workspace" | "conversation" | "actor" | "actor_conversation" | "user" | null;
};

type VisibleRelayExposureRow = {
  exposure_id: string;
  exposure_stable_key: string;
  exposure_display_name: string;
  exposure_updated_at: string;
  device_id: string;
  device_display_name: string;
};

type RelayToolRuntimeContext = {
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  visibleToolName: string;
  runtimeSessionId: string;
};

const activeRelayToolContexts = new Map<string, RelayToolRuntimeContext>();

function buildRelayToolContextKey(sessionId: string, namespacedToolName: string) {
  return `${sessionId}:${namespacedToolName}`;
}

function setRelayToolRuntimeContext(
  sessionId: string,
  namespacedToolName: string,
  context: RelayToolRuntimeContext,
) {
  activeRelayToolContexts.set(
    buildRelayToolContextKey(sessionId, namespacedToolName),
    context,
  );
}

function getRelayToolRuntimeContext(
  sessionId: string,
  namespacedToolName: string,
) {
  return activeRelayToolContexts.get(
    buildRelayToolContextKey(sessionId, namespacedToolName),
  );
}

function clearRelayToolRuntimeContexts(sessionId: string) {
  const prefix = `${sessionId}:`;
  for (const key of activeRelayToolContexts.keys()) {
    if (key.startsWith(prefix)) {
      activeRelayToolContexts.delete(key);
    }
  }
}

function buildRelayBinaryMetadata(
  context: RelayToolRuntimeContext,
  namespacedToolName: string,
): Record<string, unknown> {
  return {
    source: {
      kind: "relay_mcp",
      deviceId: context.deviceId,
      deviceDisplayName: context.deviceDisplayName,
      exposureId: context.exposureId,
      exposureStableKey: context.exposureStableKey,
      exposureDisplayName: context.exposureDisplayName,
      runtimeSessionId: context.runtimeSessionId,
      visibleToolName: context.visibleToolName,
      namespacedToolName,
    },
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function buildVisibilitySubjects(params: ResolveParams) {
  const subjects: AuthzSubject[] = [
    {
      type: "actor",
      id: params.actorId,
    },
  ];

  if (params.userId) {
    subjects.push({
      type: "user",
      id: params.userId,
    });
  }

  if (params.actorId && params.conversationId) {
    subjects.push({
      type: "actor_conversation",
      id: buildActorConversationContextId(params.actorId, params.conversationId),
    });
  }

  return subjects;
}

function publicReuseScope(scope: VisiblePluginRow["reuse_scope"]) {
  switch (scope) {
    case "actor":
      return "actor_global";
    case "turn":
    case "workspace":
    case "conversation":
    case "actor_conversation":
    case "user":
      return scope;
    default:
      return "conversation";
  }
}

function resolveReuseOwnerKey(
  scope: ReturnType<typeof publicReuseScope>,
  params: ResolveParams,
  turnOwnerKey: string,
) {
  switch (scope) {
    case "workspace":
      return params.workspaceId;
    case "conversation":
      return params.conversationId;
    case "actor_global":
      return params.actorId;
    case "actor_conversation":
      return `${params.actorId}:${params.conversationId}`;
    case "user":
      return params.userId
        ? `workspace:${params.workspaceId}:user:${params.userId}`
        : params.conversationId;
    case "turn":
      return turnOwnerKey;
    default:
      return params.conversationId;
  }
}

function manifestToolToDefinition(tool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}): ToolDefinition {
  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined;
  const properties =
    inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
      ? ((inputSchema.properties as Record<string, unknown> | undefined) || {})
      : {};
  const required =
    inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)
      ? ((inputSchema.required as string[] | undefined) || [])
      : [];

  return {
    name: tool.name,
    description: tool.description || "",
    parameters: {
      type: "object",
      properties: properties as ToolDefinition["parameters"]["properties"],
      required,
    },
  };
}

function sanitizeNamespaceSegment(value: string, fallback: string) {
  const normalized = value
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

function buildPluginNamespace(
  plugin: Pick<VisiblePluginRow, "installation_id" | "publisher_slug" | "item_slug">,
  duplicateBaseNamespaces: Set<string>,
) {
  const publisher = plugin.publisher_slug || "plugin";
  const basePluginSlug = plugin.item_slug || "plugin";
  const baseNamespace = `${publisher}${MCP_TOOL_NAMESPACE_SEPARATOR}${basePluginSlug}`;
  if (!duplicateBaseNamespaces.has(baseNamespace)) {
    return baseNamespace;
  }

  const installationSuffix = sanitizeNamespaceSegment(
    plugin.installation_id.slice(0, 8),
    "install",
  );
  return `${publisher}${MCP_TOOL_NAMESPACE_SEPARATOR}${basePluginSlug}_${installationSuffix}`;
}

async function createRelayBaseInstance(params: {
  pluginId: string;
  installationId: string;
  pluginSlug: string;
  orgSlug: string;
  scope: string;
  scopeId: string;
  workspaceId: string;
  deviceId: string;
  exposureId: string;
  exposureStableKey: string;
  key: string;
  configHash: string;
}): Promise<McpInstance> {
  let runtimeSessionId: string | undefined;
  let relaySessionId: string | undefined;

  const ensureRuntimeSession = async () => {
    const currentRelaySessionId = getConnectedRelaySessionId(params.deviceId);
    if (!currentRelaySessionId) {
      runtimeSessionId = undefined;
      relaySessionId = undefined;
      throw new Error(`Relay device ${params.deviceId} is not connected`);
    }

    if (
      runtimeSessionId &&
      relaySessionId &&
      relaySessionId === currentRelaySessionId
    ) {
      return runtimeSessionId;
    }

    runtimeSessionId = await openRelayRuntimeSession({
      deviceId: params.deviceId,
      exposureId: params.exposureId,
      exposureStableKey: params.exposureStableKey,
    });
    relaySessionId = currentRelaySessionId;
    return runtimeSessionId;
  };

  return {
    pluginId: params.pluginId,
    installationId: params.installationId,
    pluginSlug: params.pluginSlug,
    orgSlug: params.orgSlug,
    transport: "relay",
    scope: params.scope,
    scopeId: params.scopeId,
    workspaceId: params.workspaceId,
    configHash: params.configHash,
    tools: [],
    execute: async (toolName, input) => {
      const runtimeSession = await ensureRuntimeSession();
      const relayCatalog = getRelayExposureCatalog(
        params.deviceId,
        params.exposureId,
      );
      if (!relayCatalog) {
        throw new Error(
          `Relay exposure ${params.exposureId} is not currently connected`,
        );
      }
      const toolBinding = relayCatalog.tools.find(
        (tool) => tool.visible.name === toolName,
      );
      if (!toolBinding) {
        throw new Error(`Relay binding missing for tool ${toolName}`);
      }
      return callRelayTool({
        deviceId: params.deviceId,
        exposureId: params.exposureId,
        visibleToolName: toolBinding.visible.name,
        binding: toolBinding.binding,
        args: input,
        runtimeSessionId: runtimeSession,
      });
    },
    executeWithBinding: async (toolName, input, binding) => {
      const runtimeSession = await ensureRuntimeSession();
      return callRelayTool({
        deviceId: params.deviceId,
        exposureId: params.exposureId,
        visibleToolName: toolName,
        binding: binding as RelayHiddenToolBinding,
        args: input,
        runtimeSessionId: runtimeSession,
      });
    },
    ensureRuntimeSession,
    getRuntimeSessionId: () => runtimeSessionId,
    shutdown: async () => {
      const activeRuntimeSessionId = runtimeSessionId;
      runtimeSessionId = undefined;
      relaySessionId = undefined;
      if (activeRuntimeSessionId) {
        await closeRelayRuntimeSession({
          deviceId: params.deviceId,
          runtimeSessionId: activeRuntimeSessionId,
        }).catch(() => {});
      }
    },
    lastUsed: Date.now(),
    createdAt: Date.now(),
    idleTtlMs: 0,
    maxAgeMs: undefined,
  };
}

function buildRelayScopedInstance(params: {
  baseInstance: McpInstance;
  tools: ToolDefinition[];
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  sessionId: string;
  namespace: string;
  bindingMap: Map<string, { binding: RelayHiddenToolBinding; visibleToolName: string }>;
}): McpInstance {
  return {
    ...params.baseInstance,
    tools: params.tools,
    execute: async (toolName, input) => {
      const toolBinding = params.bindingMap.get(toolName);
      if (!toolBinding) {
        throw new Error(`Relay binding missing for tool ${toolName}`);
      }
      const runtimeSessionId = params.baseInstance.ensureRuntimeSession
        ? await params.baseInstance.ensureRuntimeSession()
        : undefined;
      if (runtimeSessionId) {
        setRelayToolRuntimeContext(
          params.sessionId,
          `${params.namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${toolName}`,
          {
            deviceId: params.deviceId,
            deviceDisplayName: params.deviceDisplayName,
            exposureId: params.exposureId,
            exposureStableKey: params.exposureStableKey,
            exposureDisplayName: params.exposureDisplayName,
            visibleToolName: toolBinding.visibleToolName,
            runtimeSessionId,
          },
        );
      }
      if (params.baseInstance.executeWithBinding) {
        return params.baseInstance.executeWithBinding(
          toolName,
          input,
          toolBinding.binding,
        );
      }
      return params.baseInstance.execute(toolName, input);
    },
  };
}

async function loadVisiblePlugins(params: ResolveParams) {
  const subjects = buildVisibilitySubjects(params);
  const visibleInstallationIds = new Set<string>();

  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources({
        resourceType: "plugin_installation",
        permission: "use",
        subject,
      }),
    ),
  );

  for (const ids of lookups) {
    for (const id of ids) {
      visibleInstallationIds.add(id);
    }
  }

  if (visibleInstallationIds.size === 0) {
    return [] as VisiblePluginRow[];
  }

  const result = await query<VisiblePluginRow>(
    `SELECT
       installation.id AS installation_id,
       installation.status AS installation_status,
       installation.catalog_item_id,
       item.slug AS item_slug,
       publisher.slug AS publisher_slug,
       spec.transport,
       spec.entry_point,
       spec.tool_manifest,
       installation.reuse_scope
     FROM plugin_installations installation
     JOIN catalog_items item
       ON item.id = installation.catalog_item_id
     JOIN publishers publisher
       ON publisher.id = item.publisher_id
     JOIN plugin_package_version_specs spec
       ON spec.catalog_version_id = installation.catalog_version_id
     WHERE installation.id = ANY($1::uuid[])
       AND installation.workspace_id = $2
       AND installation.status = 'active'
     ORDER BY installation.updated_at DESC`,
    [Array.from(visibleInstallationIds), params.workspaceId],
  );
  return result.rows;
}

async function loadVisibleRelayExposures(params: ResolveParams) {
  const subjects = buildVisibilitySubjects(params);
  const visibleExposureIds = new Set<string>();

  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources({
        resourceType: "relay_exposure",
        permission: "invoke",
        subject,
      }),
    ),
  );

  for (const ids of lookups) {
    for (const id of ids) {
      visibleExposureIds.add(id);
    }
  }

  if (visibleExposureIds.size === 0) {
    return [] as VisibleRelayExposureRow[];
  }

  const result = await query<VisibleRelayExposureRow>(
    `SELECT
       exposure.id AS exposure_id,
       exposure.stable_key AS exposure_stable_key,
       exposure.display_name AS exposure_display_name,
       exposure.updated_at AS exposure_updated_at,
       device.id AS device_id,
       device.display_name AS device_display_name
     FROM relay_exposures exposure
     INNER JOIN relay_devices device
       ON device.id = exposure.device_id
     WHERE exposure.id = ANY($1::uuid[])
       AND device.workspace_id = $2
     ORDER BY exposure.updated_at DESC`,
    [Array.from(visibleExposureIds), params.workspaceId],
  );

  return result.rows;
}

async function resolveTools(
  params: ResolveParams,
  instances: Map<string, McpInstance>,
  turnOwnerKey: string,
) {
  const [visiblePlugins, visibleRelayExposures] = await Promise.all([
    loadVisiblePlugins(params),
    loadVisibleRelayExposures(params),
  ]);
  const tools: ToolDefinition[] = [];
  const duplicateBaseNamespaces = new Set<string>();
  const namespaceCounts = new Map<string, number>();

  for (const plugin of visiblePlugins) {
    const baseNamespace = `${plugin.publisher_slug || "plugin"}${MCP_TOOL_NAMESPACE_SEPARATOR}${plugin.item_slug || "plugin"}`;
    const nextCount = (namespaceCounts.get(baseNamespace) || 0) + 1;
    namespaceCounts.set(baseNamespace, nextCount);
    if (nextCount > 1) {
      duplicateBaseNamespaces.add(baseNamespace);
    }
  }

  for (const plugin of visiblePlugins) {
    if (!plugin.reuse_scope) {
      continue;
    }

    const namespace = buildPluginNamespace(plugin, duplicateBaseNamespaces);

    try {
      if (plugin.transport === "relay") {
        const entry = JSON.parse(plugin.entry_point || "{}") as {
          deviceId?: string;
          exposureId?: string;
        };
        if (!entry.deviceId || !entry.exposureId) {
          throw new Error(`Relay plugin ${namespace} is missing relay entry point metadata`);
        }

        const relayCatalog = getRelayExposureCatalog(entry.deviceId, entry.exposureId);
        if (!relayCatalog) {
          throw new Error(`Relay exposure ${entry.exposureId} is not currently connected`);
        }

        const bindingMap = new Map<string, { binding: any; visibleToolName: string }>();
        const relayTools = relayCatalog.tools.map((tool) => {
          bindingMap.set(tool.visible.name, {
            binding: tool.binding,
            visibleToolName: tool.visible.name,
          });
          return manifestToolToDefinition({
            name: tool.visible.name,
            description: tool.visible.description,
            inputSchema: tool.visible.inputSchema,
          });
        });

        const reuseScope = publicReuseScope(plugin.reuse_scope);
        const scopeId = resolveReuseOwnerKey(reuseScope, params, turnOwnerKey);
        const baseRelayInstance = await getOrCreateInstance({
          pluginId: plugin.catalog_item_id,
          installationId: plugin.installation_id,
          pluginSlug: plugin.item_slug,
          orgSlug: plugin.publisher_slug || "plugin",
          transport: "relay",
          entryPoint: plugin.entry_point || "",
          scope: reuseScope,
          scopeId,
          config: {
            deviceId: entry.deviceId,
            exposureId: entry.exposureId,
            exposureStableKey: relayCatalog.exposureStableKey,
          },
          workspaceId: params.workspaceId,
          factory: async ({ key, configHash }) =>
            createRelayBaseInstance({
              pluginId: plugin.catalog_item_id,
              installationId: plugin.installation_id,
              pluginSlug: plugin.item_slug,
              orgSlug: plugin.publisher_slug || "plugin",
              scope: reuseScope,
              scopeId,
              workspaceId: params.workspaceId,
              deviceId: entry.deviceId!,
              exposureId: entry.exposureId!,
              exposureStableKey: relayCatalog.exposureStableKey,
              key,
              configHash,
            }),
        });
        const relayInstance = buildRelayScopedInstance({
          baseInstance: baseRelayInstance,
          tools: relayTools,
          deviceId: entry.deviceId,
          deviceDisplayName: relayCatalog.deviceDisplayName,
          exposureId: entry.exposureId,
          exposureStableKey: relayCatalog.exposureStableKey,
          exposureDisplayName: relayCatalog.exposureDisplayName,
          sessionId: params.sessionId,
          namespace,
          bindingMap,
        });

        const namespacedTools = relayTools.map((tool) => ({
          ...tool,
          name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
          description: `[${plugin.publisher_slug || "plugin"}/${plugin.item_slug}] ${tool.description}`,
        }));

        tools.push(...namespacedTools);
        instances.set(namespace, relayInstance);
        continue;
      }

      const resolved = await resolveInstallationConfig(plugin.installation_id);
      const reuseScope = publicReuseScope(plugin.reuse_scope);
      const runtimeInstance = await getOrCreateInstance({
        pluginId: plugin.catalog_item_id,
        installationId: resolved.installationId,
        pluginSlug: plugin.item_slug,
        orgSlug: plugin.publisher_slug || "plugin",
        transport: plugin.transport,
        entryPoint: plugin.entry_point || "",
        scope: reuseScope,
        scopeId: resolveReuseOwnerKey(reuseScope, params, turnOwnerKey),
        config: resolved.config,
        workspaceId: params.workspaceId,
      });

      const manifest = asArray<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
      }>(plugin.tool_manifest);
      const namespacedTools = (
        runtimeInstance.tools.length > 0
          ? runtimeInstance.tools
          : manifest.map(manifestToolToDefinition)
      ).map((tool) => ({
        ...tool,
        name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
        description: `[${plugin.publisher_slug || "plugin"}/${plugin.item_slug}] ${tool.description}`,
      }));

      tools.push(...namespacedTools);
      instances.set(namespace, runtimeInstance);
    } catch (error: any) {
      console.error(
        `[MCP ToolResolver] Failed to initialize plugin ${plugin.publisher_slug || "plugin"}/${plugin.item_slug}:`,
        error.message,
      );
    }
  }

  for (const exposure of visibleRelayExposures) {
    const relayCatalog = getRelayExposureCatalog(exposure.device_id, exposure.exposure_id);
    if (!relayCatalog) {
      continue;
    }

    const exposureSlug = sanitizeNamespaceSegment(
      exposure.exposure_stable_key,
      `exposure_${exposure.exposure_id.slice(0, 8)}`,
    );
    const namespace = `relay${MCP_TOOL_NAMESPACE_SEPARATOR}${exposureSlug}_${exposure.exposure_id.slice(0, 8)}`;
    const relayTools = relayCatalog.tools.map((tool) =>
      manifestToolToDefinition({
        name: tool.visible.name,
        description: tool.visible.description,
        inputSchema: tool.visible.inputSchema,
      }),
    );
    const bindingMap = new Map<string, { binding: RelayHiddenToolBinding; visibleToolName: string }>();
    for (const tool of relayCatalog.tools) {
      bindingMap.set(tool.visible.name, {
        binding: tool.binding,
        visibleToolName: tool.visible.name,
      });
    }
    const baseRelayInstance = await getOrCreateInstance({
      pluginId: exposure.exposure_id,
      installationId: exposure.exposure_id,
      pluginSlug: exposureSlug,
      orgSlug: "relay",
      transport: "relay",
      entryPoint: JSON.stringify({
        deviceId: exposure.device_id,
        exposureId: exposure.exposure_id,
      }),
      scope: "conversation",
      scopeId: params.conversationId,
      config: {
        deviceId: exposure.device_id,
        exposureId: exposure.exposure_id,
        exposureStableKey: relayCatalog.exposureStableKey,
      },
      workspaceId: params.workspaceId,
      factory: async ({ key, configHash }) =>
        createRelayBaseInstance({
          pluginId: exposure.exposure_id,
          installationId: exposure.exposure_id,
          pluginSlug: exposureSlug,
          orgSlug: "relay",
          scope: "conversation",
          scopeId: params.conversationId,
          workspaceId: params.workspaceId,
          deviceId: exposure.device_id,
          exposureId: exposure.exposure_id,
          exposureStableKey: relayCatalog.exposureStableKey,
          key,
          configHash,
        }),
    });
    const relayInstance = buildRelayScopedInstance({
      baseInstance: baseRelayInstance,
      tools: relayTools,
      deviceId: exposure.device_id,
      deviceDisplayName: exposure.device_display_name,
      exposureId: exposure.exposure_id,
      exposureStableKey: relayCatalog.exposureStableKey,
      exposureDisplayName: exposure.exposure_display_name,
      sessionId: params.sessionId,
      namespace,
      bindingMap,
    });

    const namespacedTools = relayTools.map((tool) => ({
      ...tool,
      name: `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.name}`,
      description: `[relay/${exposure.device_display_name}/${exposure.exposure_display_name}] ${tool.description}`,
    }));

    tools.push(...namespacedTools);
    instances.set(namespace, relayInstance);
  }

  return tools;
}

export async function resolveMcpToolsForActor(
  params: ResolveParams,
): Promise<ResolvedMcpTools> {
  const mcpVersion = await getMcpVersion(params.workspaceId);
  const turnOwnerKey = `session:${params.sessionId}:turn:${randomUUID()}`;
  const instances = new Map<string, McpInstance>();
  clearRelayToolRuntimeContexts(params.sessionId);
  const allTools = await resolveTools(
    params,
    instances,
    turnOwnerKey,
  );

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

    const orgSlug = parts[0]!;
    const pluginSlug = parts[1]!;
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
      const relayContext =
        instance.transport === "relay"
          ? getRelayToolRuntimeContext(params.sessionId, namespacedToolName)
          : undefined;
      return await normalizeMcpToolResult(
        rawOutput,
        params.workspaceId,
        relayContext
          ? { binaryMetadata: buildRelayBinaryMetadata(relayContext, namespacedToolName) }
          : undefined,
      );
    } catch (error: any) {
      isError = true;
      errorMessage = error.message;
      throw error;
    } finally {
      const durationMs = Date.now() - startTime;
      const output =
        rawOutput === undefined
          ? undefined
          : typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput);

      await logToolCall({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        turnId: currentTurnId,
        round: currentRound,
        actorId: params.actorId,
        userId: params.userId,
        pluginId: instance.pluginId,
        toolName: namespacedToolName,
        toolType: instance.transport === "relay" ? "relay" : "mcp_plugin",
        input,
        output,
        isError,
        errorMessage,
        durationMs,
        transport: instance.transport,
        instanceKey: namespace,
      }).catch((logError) => {
        console.error("[MCP ToolResolver] Failed to log tool call:", logError);
      });
    }
  };

  const refresh = async () => {
    const nextVersion = await getMcpVersion(params.workspaceId);
    clearRelayToolRuntimeContexts(params.sessionId);
    const refreshedTools = await resolveTools(
      params,
      instances,
      turnOwnerKey,
    );
    return {
      tools: refreshedTools,
      mcpVersion: nextVersion,
    };
  };

  const shutdown = async () => {
    clearRelayToolRuntimeContexts(params.sessionId);
    const turnScopedInstances = Array.from(instances.values()).filter(
      (instance) =>
        instance.scope === "turn" && instance.scopeId === turnOwnerKey,
    );
    await Promise.allSettled(
      turnScopedInstances.map((instance) => instance.shutdown()),
    );
  };

  return {
    tools: allTools,
    executor,
    mcpVersion,
    refresh,
    setTurnId,
    shutdown,
  };
}

export async function resolveRelayTargetForNamespacedTool(
  params: ResolveParams & { namespacedToolName: string },
): Promise<ResolvedRelayToolTarget | null> {
  const activeContext = getRelayToolRuntimeContext(
    params.sessionId,
    params.namespacedToolName,
  );
  if (activeContext) {
    return { ...activeContext };
  }

  const visibleExposures = await loadVisibleRelayExposures(params);

  for (const exposure of visibleExposures) {
    const relayCatalog = getRelayExposureCatalog(
      exposure.device_id,
      exposure.exposure_id,
    );
    if (!relayCatalog) {
      continue;
    }

    const exposureSlug = sanitizeNamespaceSegment(
      exposure.exposure_stable_key,
      `exposure_${exposure.exposure_id.slice(0, 8)}`,
    );
    const namespace = `relay${MCP_TOOL_NAMESPACE_SEPARATOR}${exposureSlug}_${exposure.exposure_id.slice(0, 8)}`;

    for (const tool of relayCatalog.tools) {
      const namespacedToolName = `${namespace}${MCP_TOOL_NAMESPACE_SEPARATOR}${tool.visible.name}`;
      if (namespacedToolName !== params.namespacedToolName) {
        continue;
      }
      return {
        deviceId: exposure.device_id,
        deviceDisplayName: exposure.device_display_name,
        exposureId: exposure.exposure_id,
        exposureStableKey: exposure.exposure_stable_key,
        exposureDisplayName: exposure.exposure_display_name,
        visibleToolName: tool.visible.name,
      };
    }
  }

  return null;
}
