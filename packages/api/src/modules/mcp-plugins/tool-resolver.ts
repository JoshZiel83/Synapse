import { randomUUID } from "crypto";
import type { ToolDefinition } from "@synapse/shared";
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
import { callRelayTool, getRelayExposureCatalog } from "./relay-manager.js";
import { normalizeMcpToolResult } from "./result-normalizer.js";

const MCP_TOOL_NAMESPACE_SEPARATOR = "__";

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
        const relayInstance: McpInstance = {
          pluginId: plugin.catalog_item_id,
          installationId: plugin.installation_id,
          pluginSlug: plugin.item_slug,
          orgSlug: plugin.publisher_slug || "plugin",
          transport: "relay",
          scope: reuseScope,
          scopeId: resolveReuseOwnerKey(reuseScope, params, turnOwnerKey),
          workspaceId: params.workspaceId,
          configHash: `relay:${entry.deviceId}:${entry.exposureId}`,
          tools: relayTools,
          execute: async (toolName: string, input: Record<string, unknown>) => {
            const toolBinding = bindingMap.get(toolName);
            if (!toolBinding) {
              throw new Error(`Relay binding missing for tool ${toolName}`);
            }

            return callRelayTool({
              deviceId: entry.deviceId!,
              exposureId: entry.exposureId!,
              visibleToolName: toolBinding.visibleToolName,
              binding: toolBinding.binding,
              args: input,
            });
          },
          shutdown: async () => {},
          lastUsed: Date.now(),
          createdAt: Date.now(),
          idleTtlMs: 0,
          maxAgeMs: undefined,
        };

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

    const relayInstance: McpInstance = {
      pluginId: exposure.exposure_id,
      installationId: exposure.exposure_id,
      pluginSlug: exposureSlug,
      orgSlug: "relay",
      transport: "relay",
      scope: "conversation",
      scopeId: params.conversationId,
      workspaceId: params.workspaceId,
      configHash: `relay:${exposure.device_id}:${exposure.exposure_id}`,
      tools: relayTools,
      execute: async (toolName: string, input: Record<string, unknown>) => {
        const toolBinding = relayCatalog.tools.find(
          (tool) => tool.visible.name === toolName,
        );
        if (!toolBinding) {
          throw new Error(`Relay binding missing for tool ${toolName}`);
        }

        return callRelayTool({
          deviceId: exposure.device_id,
          exposureId: exposure.exposure_id,
          visibleToolName: toolBinding.visible.name,
          binding: toolBinding.binding,
          args: input,
        });
      },
      shutdown: async () => {},
      lastUsed: Date.now(),
      createdAt: Date.now(),
      idleTtlMs: 0,
      maxAgeMs: undefined,
    };

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
      return await normalizeMcpToolResult(rawOutput, params.workspaceId);
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

  return {
    tools: allTools,
    executor,
    mcpVersion,
    refresh,
    setTurnId,
  };
}
