import { randomUUID } from "crypto";
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  maskAllowsConversationType,
  resolveNarrowedConversationTypeMask,
  textBlocks,
  type RelayHiddenToolBinding,
  type ToolDefinition,
} from "@synapse/shared";
import type {
  NormalizedMcpToolResult,
  RuntimeActorContext,
} from "@synapse/shared/types";
import { sql } from "kysely";
import {
  lookupResources,
  type AuthzSubject,
} from "../../infrastructure/authz/index.js";
import { db } from "../../infrastructure/database/kysely.js";
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js";
import { getConversationActorContextBySessionId } from "../session/service.js";
import { resolveInstallationConfig } from "./config-resolver.js";
import {
  getOrCreateInstance,
  type McpExecutionContext,
  type McpInstance,
} from "./instance-manager.js";
import { getMcpVersion } from "./runtime-version.js";
import { logToolCall } from "./audit.js";
import {
  enqueueRelayToolTask,
  loadRelayExposureCatalogSnapshot,
  resolveRelayToolAuthorization,
} from "./relay-manager.js";
import {
  resolveRelayCapabilityConversationTypeMask,
  resolveRelayDeviceConversationTypeMask,
  resolveRelayGrantConversationTypeMask,
} from "./relay-policy.js";
import { normalizeMcpToolResult } from "./result-normalizer.js";

const MCP_TOOL_NAMESPACE_SEPARATOR = "__";
const RELAY_ASYNC_COMMANDLINE_TOOL_NAMES = new Set(["bash"]);

export interface ResolvedMcpTools {
  tools: ToolDefinition[];
  executor: (
    toolName: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext,
  ) => Promise<NormalizedMcpToolResult>;
  mcpVersion: number;
  refresh: () => Promise<{ tools: ToolDefinition[]; mcpVersion: number }>;
  setTurnId: (turnId: string, round?: number) => void;
  shutdown: () => Promise<void>;
}

interface ResolveParams extends RuntimeActorContext {
  conversationId: string;
}

export interface ResolvedRelayToolTarget {
  capabilityId: string;
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  visibleToolName: string;
  relayToolStableKey?: string;
  runtimeSessionId?: string;
}

type VisiblePluginRow = {
  installation_id: string;
  owner_workspace_id: string;
  installation_status: "active" | "disabled" | "error" | "archived";
  catalog_item_id: string;
  item_slug: string;
  publisher_slug: string;
  transport: "builtin" | "stdio" | "http" | "relay";
  entry_point: string | null;
  tool_manifest: unknown;
  reuse_scope: "turn" | "session" | "workspace" | "conversation" | "actor" | null;
  conversation_type_mask_override: number | null;
};

type VisibleRelayCapabilityRow = {
  capability_id: string;
  exposure_id: string;
  owner_workspace_id: string;
  exposure_stable_key: string;
  exposure_display_name: string;
  exposure_updated_at: string | Date | null;
  device_id: string;
  device_display_name: string;
  device_conversation_type_mask_override: number | null;
  capability_conversation_type_mask_override: number | null;
};

type VisibleAccessBindingRow = {
  id: string;
  workspace_id: string;
  resource_type: "plugin_installation" | "relay_capability";
  resource_id: string;
  target_type:
    | "workspace"
    | "conversation"
    | "actor"
    | "actor_in_conversation";
  subject_workspace_id: string | null;
  subject_workspace_member_id: string | null;
  subject_actor_id: string | null;
  subject_conversation_id: string | null;
  subject_conversation_actor_context_id: string | null;
  conversation_type_mask_override: number | null;
  granted_permissions: string[] | null;
  status: "active" | "revoked";
  created_by_workspace_member_id: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string | Date | null;
  revoked_at: string | Date | null;
  actor_id: string | null;
  conversation_id: string | null;
};

type RelayToolRuntimeContext = {
  capabilityId: string;
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  visibleToolName: string;
  relayToolStableKey?: string;
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

function normalizeBuiltinKind(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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
      relayCapabilityId: context.capabilityId,
      deviceId: context.deviceId,
      deviceDisplayName: context.deviceDisplayName,
      exposureId: context.exposureId,
      exposureStableKey: context.exposureStableKey,
      exposureDisplayName: context.exposureDisplayName,
      runtimeSessionId: context.runtimeSessionId,
      visibleToolName: context.visibleToolName,
      relayToolStableKey: context.relayToolStableKey,
      namespacedToolName,
    },
  };
}

function wantsAsyncRelayCommandlineExecution(
  toolName: string,
  input: Record<string, unknown>,
) {
  return (
    RELAY_ASYNC_COMMANDLINE_TOOL_NAMES.has(toolName) &&
    input.execution_mode === "async"
  );
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function buildVisibilitySubjects(params: ResolveParams) {
  const subjects: AuthzSubject[] = [
    {
      type: "actor",
      id: params.actorId,
    },
  ];

  const context = params.conversationActorContextId
    ? { id: params.conversationActorContextId }
    : await getConversationActorContextBySessionId(params.sessionId);
  if (context) {
    subjects.push({
      type: "conversation_actor_context",
      id: context.id,
    });
  }

  return subjects;
}

function publicReuseScope(scope: VisiblePluginRow["reuse_scope"]) {
  return scope || "conversation";
}

function isConversationTypeAllowed(
  mask: number,
  params: Pick<ResolveParams, "conversationKind" | "conversationBoundary">,
) {
  return maskAllowsConversationType(
    mask,
    params.conversationKind,
    params.conversationBoundary,
  );
}

function accessBindingMatchesContext(
  row: VisibleAccessBindingRow,
  params: Pick<ResolveParams, "actorId" | "conversationId">,
) {
  switch (row.target_type) {
    case "workspace":
      return true;
    case "conversation":
      return row.conversation_id === params.conversationId;
    case "actor":
      return row.actor_id === params.actorId;
    case "actor_in_conversation":
      return (
        row.actor_id === params.actorId &&
        row.conversation_id === params.conversationId
      );
  }
}

async function loadVisibleAccessBindings(params: {
  resourceType: "plugin_installation" | "relay_capability";
  resourceIds: string[];
}) {
  if (params.resourceIds.length === 0) {
    return new Map<string, VisibleAccessBindingRow[]>();
  }

  const resourceColumn =
    params.resourceType === "plugin_installation"
      ? "binding.plugin_installation_id"
      : "binding.relay_capability_id";
  const resourceIdSelect =
    params.resourceType === "plugin_installation"
      ? sql<string>`binding.plugin_installation_id::text`.as("resource_id")
      : sql<string>`binding.relay_capability_id::text`.as("resource_id");

  const rows = await db
    .selectFrom("resource_access_bindings as binding")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "binding.subject_conversation_actor_context_id",
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      resourceIdSelect,
      "binding.target_type",
      "binding.subject_workspace_id",
      "binding.subject_workspace_member_id",
      sql<string | null>`COALESCE(binding.subject_actor_id, cac.actor_id)`.as(
        "subject_actor_id",
      ),
      sql<string | null>`COALESCE(binding.subject_conversation_id, cac.conversation_id)`.as(
        "subject_conversation_id",
      ),
      "binding.subject_conversation_actor_context_id",
      "binding.conversation_type_mask_override",
      "binding.granted_permissions",
      "binding.status",
      "binding.created_by_workspace_member_id",
      "binding.reason",
      "binding.created_at",
      "binding.revoked_at",
      sql<string | null>`COALESCE(binding.subject_actor_id, cac.actor_id)`.as(
        "actor_id",
      ),
      sql<string | null>`COALESCE(binding.subject_conversation_id, cac.conversation_id)`.as(
        "conversation_id",
      ),
    ])
    .where("binding.resource_type", "=", params.resourceType)
    .where(resourceColumn, "in", params.resourceIds)
    .where("binding.status", "=", "active")
    .orderBy("binding.created_at", "desc")
    .execute() as VisibleAccessBindingRow[];

  const map = new Map<string, VisibleAccessBindingRow[]>();
  for (const row of rows) {
    const entries = map.get(row.resource_id) || [];
    entries.push(row);
    map.set(row.resource_id, entries);
  }
  return map;
}

function resolveReuseOwnerKey(
  scope: ReturnType<typeof publicReuseScope>,
  params: ResolveParams,
  turnOwnerKey: string,
) {
  switch (scope) {
    case "workspace":
      return `workspace:${params.workspaceId}`;
    case "conversation":
      return `conversation:${params.conversationId}`;
    case "actor":
      return `actor:${params.actorId}`;
    case "session":
      return `session:${params.sessionId}`;
    case "turn":
      return turnOwnerKey;
    default:
      return `conversation:${params.conversationId}`;
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

function buildRelayScopedInstance(params: {
  baseInstance: McpInstance;
  tools: ToolDefinition[];
  capabilityId: string;
  deviceId: string;
  deviceDisplayName: string;
  exposureId: string;
  exposureStableKey: string;
  exposureDisplayName: string;
  exposureMetadata: Record<string, unknown>;
  sessionId: string;
  namespace: string;
  bindingMap: Map<string, { binding: RelayHiddenToolBinding; visibleToolName: string }>;
}): McpInstance {
  return {
    ...params.baseInstance,
    tools: params.tools,
    execute: async (toolName, input, executionContext) => {
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
            capabilityId: params.capabilityId,
            deviceId: params.deviceId,
            deviceDisplayName: params.deviceDisplayName,
            exposureId: params.exposureId,
            exposureStableKey: params.exposureStableKey,
            exposureDisplayName: params.exposureDisplayName,
            visibleToolName: toolBinding.visibleToolName,
            relayToolStableKey: toolBinding.binding.stableKey,
            runtimeSessionId,
          },
        );
      }
      if (wantsAsyncRelayCommandlineExecution(toolBinding.visibleToolName, input)) {
        if (
          !executionContext?.sessionId ||
          !executionContext.conversationId ||
          !executionContext.actorId ||
          !executionContext.toolCallId ||
          !runtimeSessionId
        ) {
          throw new Error(
            "Async relay commandline tool calls require a session-backed actor tool call",
          );
        }

        const authorizationState = await resolveRelayToolAuthorization({
          workspaceId: params.baseInstance.workspaceId || "",
          relayCapabilityId: params.capabilityId,
          relayExposureId: params.exposureId,
          conversationId: executionContext.conversationId,
          actorId: executionContext.actorId,
          relayToolStableKey: toolBinding.binding.stableKey,
          relayToolName: toolBinding.visibleToolName,
          toolArguments: input,
          runtimeSessionId,
          exposureMetadata: params.exposureMetadata,
        });
        if (authorizationState.denialResult) {
          return authorizationState.denialResult as any;
        }

        const accepted = await enqueueRelayToolTask({
          workspaceId: params.baseInstance.workspaceId || "",
          conversationId: executionContext.conversationId,
          sessionId: executionContext.sessionId,
          requestedByActorId: executionContext.actorId,
          requestedByWorkspaceMemberId: executionContext.workspaceMemberId,
          turnId: executionContext.turnId,
          sourceToolCallId: executionContext.toolCallId,
          sourceToolName:
            executionContext.namespacedToolName || toolBinding.visibleToolName,
          relayCapabilityId: params.capabilityId,
          deviceId: params.deviceId,
          exposureId: params.exposureId,
          visibleToolName: toolBinding.visibleToolName,
          binding: toolBinding.binding,
          args: input,
          runtimeSessionId,
          authorization: authorizationState.authorization,
          deliveryPolicy: "online_only",
        });

        return {
          content: textBlocks(
            `Accepted async ${toolBinding.visibleToolName} request. The relay will execute it and wake you with the final result.`,
          ),
          structuredContent: {
            deferred: true,
            task: {
              taskId: accepted.taskId,
              status: "working",
              dispatchStatus: "queued",
              statusMessage: `Queued async ${toolBinding.visibleToolName} on the relay.`,
            },
            relayOperationId: accepted.operationId,
          },
        };
      }
      if (params.baseInstance.executeWithBinding) {
        return params.baseInstance.executeWithBinding(
          toolName,
          input,
          toolBinding.binding,
          executionContext,
        );
      }
      return params.baseInstance.execute(toolName, input, executionContext);
    },
  };
}

async function loadVisiblePlugins(params: ResolveParams) {
  const subjects = await buildVisibilitySubjects(params);
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

  const rows = await db
    .selectFrom("plugin_installations as installation")
    .innerJoin("catalog_items as item", "item.id", "installation.catalog_item_id")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisher_id")
    .innerJoin(
      "plugin_package_version_specs as spec",
      "spec.catalog_version_id",
      "installation.catalog_version_id",
    )
    .select([
      "installation.id as installation_id",
      "installation.workspace_id as owner_workspace_id",
      "installation.status as installation_status",
      "installation.catalog_item_id",
      "item.slug as item_slug",
      "publisher.slug as publisher_slug",
      "spec.transport",
      "spec.entry_point",
      "spec.tool_manifest",
      sql<number | null>`installation.conversation_type_mask_override`.as(
        "conversation_type_mask_override",
      ),
      "installation.reuse_scope",
    ])
    .where("installation.id", "in", Array.from(visibleInstallationIds))
    .where("installation.status", "=", "active")
    .orderBy("installation.updated_at", "desc")
    .execute();

  const [bindingsByInstallationId, workspacePolicyMap] = await Promise.all([
    loadVisibleAccessBindings({
      resourceType: "plugin_installation",
      resourceIds: rows.map((row) => row.installation_id),
    }),
    getWorkspaceCapabilityConversationTypePolicyMap(
      rows.map((row) => row.owner_workspace_id),
    ),
  ]);

  return rows.filter((row) => {
    const workspaceConversationTypeMask =
      workspacePolicyMap.get(row.owner_workspace_id)?.plugin_installation ||
      DEFAULT_CONVERSATION_TYPE_MASK;
    const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
      workspaceConversationTypeMask,
      row.conversation_type_mask_override,
    );
    const matchingBindings = (bindingsByInstallationId.get(row.installation_id) || []).filter(
      (binding) =>
        accessBindingMatchesContext(binding, params) &&
        isConversationTypeAllowed(
          resolveNarrowedConversationTypeMask(
            instanceConversationTypeMask,
            binding.conversation_type_mask_override,
          ),
          params,
        ),
    );
    return matchingBindings.length > 0;
  }) as VisiblePluginRow[];
}

async function loadVisibleRelayExposures(params: ResolveParams) {
  const subjects = await buildVisibilitySubjects(params);
  const visibleCapabilityIds = new Set<string>();

  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources({
        resourceType: "relay_capability",
        permission: "use",
        subject,
      }),
    ),
  );

  for (const ids of lookups) {
    for (const id of ids) {
      visibleCapabilityIds.add(id);
    }
  }

  if (visibleCapabilityIds.size === 0) {
    return [] as VisibleRelayCapabilityRow[];
  }

  const rows = await db
    .selectFrom("relay_capabilities as capability")
    .innerJoin("relay_exposures as exposure", "exposure.id", "capability.exposure_id")
    .innerJoin("relay_devices as device", "device.id", "exposure.device_id")
    .select([
      "capability.id as capability_id",
      "exposure.id as exposure_id",
      "device.workspace_id as owner_workspace_id",
      "exposure.stable_key as exposure_stable_key",
      "exposure.display_name as exposure_display_name",
      "exposure.updated_at as exposure_updated_at",
      "device.id as device_id",
      "device.title as device_display_name",
      sql<number | null>`device.conversation_type_mask_override`.as(
        "device_conversation_type_mask_override",
      ),
      sql<number | null>`capability.conversation_type_mask_override`.as(
        "capability_conversation_type_mask_override",
      ),
    ])
    .where("capability.id", "in", Array.from(visibleCapabilityIds))
    .where("capability.status", "=", "active")
    .where("exposure.runtime_status", "=", "healthy")
    .where(sql<boolean>`EXISTS (
      SELECT 1
      FROM relay_device_sessions session_row
      WHERE session_row.device_id = device.id
        AND session_row.status = 'active'
    )`)
    .orderBy("exposure.updated_at", "desc")
    .execute();

  const [bindingsByExposureId, workspacePolicyMap] = await Promise.all([
    loadVisibleAccessBindings({
      resourceType: "relay_capability",
      resourceIds: rows.map((row) => row.capability_id),
    }),
    getWorkspaceCapabilityConversationTypePolicyMap(
      rows.map((row) => row.owner_workspace_id),
    ),
  ]);

  return rows.filter((row) => {
    const workspaceConversationTypeMask =
      workspacePolicyMap.get(row.owner_workspace_id)?.relay_capability ||
      DEFAULT_CONVERSATION_TYPE_MASK;
    const deviceConversationTypeMask = resolveRelayDeviceConversationTypeMask(
      workspaceConversationTypeMask,
      row.device_conversation_type_mask_override,
    );
    const instanceConversationTypeMask = resolveRelayCapabilityConversationTypeMask(
      deviceConversationTypeMask,
      row.capability_conversation_type_mask_override,
    );
    const matchingBindings = (bindingsByExposureId.get(row.capability_id) || []).filter(
      (binding) =>
        accessBindingMatchesContext(binding, params) &&
        isConversationTypeAllowed(
          resolveRelayGrantConversationTypeMask(
            instanceConversationTypeMask,
            binding.conversation_type_mask_override,
          ),
          params,
        ),
    );
    return matchingBindings.length > 0;
  }) as VisibleRelayCapabilityRow[];
}

export async function listVisibleHealthyRelayCommandlineExposureMetadata(
  params: ResolveParams,
) {
  const exposures = await loadVisibleRelayExposures(params);
  const metadata: Record<string, unknown>[] = [];

  for (const exposure of exposures) {
    const relayCatalog = await loadRelayExposureCatalogSnapshot(
      exposure.device_id,
      exposure.exposure_id,
    );
    if (!relayCatalog || relayCatalog.runtimeStatus !== "healthy") {
      continue;
    }
    if (normalizeBuiltinKind(relayCatalog.metadata?.builtinKind) !== "commandline") {
      continue;
    }
    metadata.push(relayCatalog.metadata || {});
  }

  return metadata;
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

        const relayCatalog = await loadRelayExposureCatalogSnapshot(
          entry.deviceId,
          entry.exposureId,
        );
        if (!relayCatalog || relayCatalog.runtimeStatus !== "healthy") {
          throw new Error(`Relay exposure ${entry.exposureId} is not available`);
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
          workspaceId: plugin.owner_workspace_id,
        });
        const relayInstance = buildRelayScopedInstance({
          baseInstance: baseRelayInstance,
          tools: relayTools,
          capabilityId: plugin.installation_id,
          deviceId: entry.deviceId,
          deviceDisplayName: relayCatalog.deviceDisplayName,
          exposureId: entry.exposureId,
          exposureStableKey: relayCatalog.exposureStableKey,
          exposureDisplayName: relayCatalog.exposureDisplayName,
          exposureMetadata: relayCatalog.metadata,
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
        workspaceId: plugin.owner_workspace_id,
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
    const relayCatalog = await loadRelayExposureCatalogSnapshot(
      exposure.device_id,
      exposure.exposure_id,
    );
    if (!relayCatalog || relayCatalog.runtimeStatus !== "healthy") {
      continue;
    }

    const exposureSlug = sanitizeNamespaceSegment(
      exposure.exposure_stable_key,
      `exposure_${exposure.exposure_id.slice(0, 8)}`,
    );
    const builtinKind = normalizeBuiltinKind(relayCatalog.metadata?.builtinKind);
    const relayScope = builtinKind === "cua" ? "turn" : "conversation";
    const relayScopeId =
      relayScope === "turn" ? turnOwnerKey : params.conversationId;
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
      installationId: exposure.capability_id,
      pluginSlug: exposureSlug,
      orgSlug: "relay",
      transport: "relay",
      entryPoint: JSON.stringify({
        deviceId: exposure.device_id,
        exposureId: exposure.exposure_id,
      }),
      scope: relayScope,
      scopeId: relayScopeId,
      config: {
        deviceId: exposure.device_id,
        exposureId: exposure.exposure_id,
        exposureStableKey: relayCatalog.exposureStableKey,
      },
      workspaceId: exposure.owner_workspace_id,
    });
    const relayInstance = buildRelayScopedInstance({
      baseInstance: baseRelayInstance,
      tools: relayTools,
      capabilityId: exposure.capability_id,
      deviceId: exposure.device_id,
      deviceDisplayName: exposure.device_display_name,
      exposureId: exposure.exposure_id,
      exposureStableKey: relayCatalog.exposureStableKey,
      exposureDisplayName: exposure.exposure_display_name,
      exposureMetadata: relayCatalog.metadata,
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
    executionContext?: McpExecutionContext,
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
      rawOutput = await instance.execute(toolName, input, executionContext);
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
    const relayCatalog = await loadRelayExposureCatalogSnapshot(
      exposure.device_id,
      exposure.exposure_id,
    );
    if (!relayCatalog || relayCatalog.runtimeStatus !== "healthy") {
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
        capabilityId: exposure.capability_id,
        deviceId: exposure.device_id,
        deviceDisplayName: exposure.device_display_name,
        exposureId: exposure.exposure_id,
        exposureStableKey: exposure.exposure_stable_key,
        exposureDisplayName: exposure.exposure_display_name,
        visibleToolName: tool.visible.name,
        relayToolStableKey: tool.visible.stableKey,
      };
    }
  }

  return null;
}
