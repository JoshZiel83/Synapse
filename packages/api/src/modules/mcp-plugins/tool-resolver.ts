import { randomUUID } from "crypto"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  MCP_SERVER_TRANSPORTS,
  maskAllowsConversationType,
  resolveNarrowedConversationTypeMask,
  pluginToolId,
  type McpServerTransport,
  type PluginSpecTransport,
  type ToolDefinition,
  type ProjectedToolDefinition,
  type ToolRef,
  type ToolResultOrigin,
} from "@synapse/shared"
import type {
  NormalizedMcpToolResult,
  RuntimeActorContext,
} from "@synapse/shared/types"
import { sql } from "kysely"
import { lookupResources } from "../access/evaluator.js"
import { ACCESS_ACTIONS } from "../access/actions.js"
import { db } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { loadAccessBindingRowsForResources } from "../access/binding-storage.js"
import { buildConversationCapabilitySubjects } from "../access/subject-resolution.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import { resolveInstallationConfig } from "./config-resolver.js"
import {
  getOrCreateInstance,
  type McpExecutionContext,
  type McpInstance,
} from "./instance-manager.js"
import { getMcpVersion } from "./runtime-version.js"
import { logToolCall } from "./audit.js"
import { normalizeMcpToolResult } from "./result-normalizer.js"

const log = createLogger("mcp.tool-resolver")

/**
 * Routed tool surface returned by the resolver.
 *
 * `tools` carries Layer-A identity (each tool has a mandatory `ref`).
 * `executor` is keyed by the deterministic `toolId` (NOT the wire name) — the
 * surface (chat / reverse-MCP) maps wireName→toolId via its own NameRegistry
 * before invoking. This is what removes the `split("__")` name-parsing.
 */
export interface ResolvedMcpTools {
  tools: ProjectedToolDefinition[]
  executor: (
    toolId: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ) => Promise<NormalizedMcpToolResult>
  mcpVersion: number
  refresh: () => Promise<{ tools: ProjectedToolDefinition[]; mcpVersion: number }>
  setTurnId: (turnId: string, round?: number) => void
  shutdown: () => Promise<void>
}

/** A plugin tool's per-turn dispatch entry, keyed by its deterministic toolId. */
interface PluginDispatchEntry {
  instance: McpInstance
  upstreamToolName: string
  ref: ToolRef
}

interface ResolveParams extends Omit<RuntimeActorContext, "actorId"> {
  conversationId: string
  // Exactly one of actorId / remoteAgentId is set for a given resolver call.
  // Actors flow through the original conversation_actor_context grant path;
  // remote_agents pick up workspace-shared resources plus an extra
  // conversation-target grant pass (since they have no actor identity and
  // therefore can't be evaluated against actor / actor_in_conversation grants).
  actorId?: string
  remoteAgentId?: string
}

type VisiblePluginRow = {
  installation_id: string
  owner_workspace_id: string
  installation_status: "active" | "disabled" | "error" | "archived"
  catalog_item_id: string
  item_slug: string
  publisher_slug: string
  transport: PluginSpecTransport
  entry_point: string | null
  tool_manifest: unknown
  reuse_scope:
    | "turn"
    | "session"
    | "workspace"
    | "conversation"
    | "actor"
    | null
  conversation_type_mask_override: number | null
}

type VisibleAccessBindingRow = {
  id: string
  workspace_id: string
  resource_type: "plugin_installation"
  resource_id: string
  target_type:
    | "workspace"
    | "workspace_member"
    | "conversation"
    | "actor"
    | "actor_in_conversation"
    | "remote_agent"
    | "remote_agent_in_conversation"
  subject_workspace_id: string | null
  subject_workspace_member_id: string | null
  subject_actor_id: string | null
  subject_remote_agent_id: string | null
  subject_conversation_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  created_by_workspace_member_id: string | null
  reason: string | null
  metadata: unknown
  created_at: string | Date | null
  revoked_at: string | Date | null
  actor_id: string | null
  remote_agent_id: string | null
  conversation_id: string | null
}

/**
 * Build a plugin ToolRef from an instance + its upstream (bare) tool name.
 * The deterministic toolId (`plugin:<installationId>:<upstreamToolName>`) is the
 * routing key; `binding` carries route-only coordinates (never serialized out).
 */
function buildPluginToolRef(
  instance: McpInstance,
  upstreamToolName: string
): ToolRef {
  const transport: ToolRef["binding"]["transport"] =
    instance.transport === "builtin" ? "in_process" : (instance.transport as
      | "stdio"
      | "http"
      | "sse")
  const binding: ToolRef["binding"] =
    transport === "in_process"
      ? { transport: "in_process", dispatch: "callable" }
      : { transport, instanceKey: `${instance.installationId}:${instance.configHash}:${instance.scope}:${instance.scopeId}` }
  return {
    toolId: pluginToolId(instance.installationId, upstreamToolName),
    source: {
      kind: "plugin",
      installationId: instance.installationId,
      upstreamToolName,
    },
    binding,
    identity: {
      stableKey: `plugin/${instance.orgSlug}/${instance.pluginSlug}/${upstreamToolName}`,
    },
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

async function buildVisibilitySubjects(params: ResolveParams) {
  return buildConversationCapabilitySubjects(db, {
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
  })
}

function publicReuseScope(scope: VisiblePluginRow["reuse_scope"]) {
  return scope || "conversation"
}

function isConversationTypeAllowed(
  mask: number,
  params: Pick<ResolveParams, "conversationKind" | "isImConversation">
) {
  return maskAllowsConversationType(
    mask,
    params.conversationKind,
    params.isImConversation ?? false
  )
}

function accessBindingMatchesContext(
  row: VisibleAccessBindingRow,
  params: Pick<
    ResolveParams,
    "actorId" | "conversationId" | "workspaceMemberId" | "remoteAgentId"
  >
) {
  switch (row.target_type) {
    case "workspace":
      return true
    case "workspace_member":
      return (
        !!params.workspaceMemberId &&
        row.subject_workspace_member_id === params.workspaceMemberId
      )
    case "conversation":
      return row.conversation_id === params.conversationId
    case "actor":
      return params.actorId !== undefined && row.actor_id === params.actorId
    case "actor_in_conversation":
      return (
        params.actorId !== undefined &&
        row.actor_id === params.actorId &&
        row.conversation_id === params.conversationId
      )
    case "remote_agent":
      return (
        params.remoteAgentId !== undefined &&
        row.remote_agent_id === params.remoteAgentId
      )
    case "remote_agent_in_conversation":
      return (
        params.remoteAgentId !== undefined &&
        row.remote_agent_id === params.remoteAgentId &&
        row.conversation_id === params.conversationId
      )
  }
}

async function loadVisibleAccessBindings(params: {
  resourceType: "plugin_installation"
  resourceIds: string[]
}) {
  if (params.resourceIds.length === 0) {
    return new Map<string, VisibleAccessBindingRow[]>()
  }

  // P3: route through binding-storage's central row loader. The returned
  // AccessBindingRow already carries target_type + subject_*_id (reconstructed
  // from the access_subjects JOIN). VisibleAccessBindingRow surfaces a few
  // extra denormalized fields — `actor_id` / `conversation_id` mirror the
  // subject side, `metadata` is intentionally an empty object — so we map
  // them on after the load.
  const rows = await loadAccessBindingRowsForResources(db, {
    resourceType: params.resourceType,
    resourceIds: params.resourceIds,
  })

  const map = new Map<string, VisibleAccessBindingRow[]>()
  for (const rawRow of rows) {
    const row = rawRow as typeof rawRow & {
      subject_kind?: string | null
      subject_workspace_id_via_join?: string | null
      subject_workspace_member_id_via_join?: string | null
      subject_actor_id_via_join?: string | null
      subject_remote_agent_id_via_join?: string | null
      subject_conversation_id_via_join?: string | null
      scope_kind?: string | null
      scope_conversation_id_via_join?: string | null
    }
    let target_type: VisibleAccessBindingRow["target_type"] | null
    if (row.subject_kind === "actor" && row.scope_kind === "conversation") {
      target_type = "actor_in_conversation"
    } else if (
      row.subject_kind === "remote_agent" &&
      row.scope_kind === "conversation"
    ) {
      target_type = "remote_agent_in_conversation"
    } else {
      switch (row.subject_kind) {
        case "workspace":
          target_type = "workspace"
          break
        case "workspace_member":
          target_type = "workspace_member"
          break
        case "conversation":
          target_type = "conversation"
          break
        case "actor":
          target_type = "actor"
          break
        case "remote_agent":
          target_type = "remote_agent"
          break
        default:
          target_type = null
      }
    }
    if (target_type === null) {
      // Unknown subject kind — fail closed by dropping the row entirely.
      continue
    }
    const subjectActorId = row.subject_actor_id_via_join ?? null
    const subjectRemoteAgentId = row.subject_remote_agent_id_via_join ?? null
    const subjectConversationId =
      row.scope_conversation_id_via_join ??
      row.subject_conversation_id_via_join ??
      null
    const visible: VisibleAccessBindingRow = {
      id: row.id,
      workspace_id: row.workspace_id,
      resource_type: params.resourceType,
      resource_id: row.resource_id,
      target_type,
      subject_workspace_id: row.subject_workspace_id_via_join ?? null,
      subject_workspace_member_id:
        row.subject_workspace_member_id_via_join ?? null,
      subject_actor_id: subjectActorId,
      subject_remote_agent_id: subjectRemoteAgentId,
      subject_conversation_id: subjectConversationId,
      conversation_type_mask_override: row.conversation_type_mask_override,
      status: row.status,
      created_by_workspace_member_id: row.created_by_workspace_member_id,
      reason: row.reason,
      metadata: {},
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      actor_id: subjectActorId,
      remote_agent_id: subjectRemoteAgentId,
      conversation_id: subjectConversationId,
    }
    const entries = map.get(visible.resource_id) || []
    entries.push(visible)
    map.set(visible.resource_id, entries)
  }
  return map
}

function resolveReuseOwnerKey(
  scope: ReturnType<typeof publicReuseScope>,
  params: ResolveParams,
  turnOwnerKey: string
) {
  switch (scope) {
    case "workspace":
      return `workspace:${params.workspaceId}`
    case "conversation":
      return `conversation:${params.conversationId}`
    case "actor":
      // Reuse key follows the principal: real actor for an actor-driven turn,
      // remote_agent for a remote-agent-driven one. Both partition cleanly
      // and never collide because actor IDs and remote_agent IDs come from
      // disjoint tables / UUID space anyway, but the prefix makes audit
      // traces unambiguous.
      return params.actorId
        ? `actor:${params.actorId}`
        : `remote_agent:${params.remoteAgentId ?? "unknown"}`
    case "session":
      return `session:${params.sessionId}`
    case "turn":
      return turnOwnerKey
    default:
      return `conversation:${params.conversationId}`
  }
}

function manifestToolToDefinition(tool: {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}): ToolDefinition {
  const inputSchema = tool.inputSchema as Record<string, unknown> | undefined
  const properties =
    inputSchema &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema)
      ? (inputSchema.properties as Record<string, unknown> | undefined) || {}
      : {}
  const required =
    inputSchema &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema)
      ? (inputSchema.required as string[] | undefined) || []
      : []

  return {
    name: tool.name,
    description: tool.description || "",
    parameters: {
      type: "object",
      properties: properties as ToolDefinition["parameters"]["properties"],
      required,
    },
  }
}

async function loadConversationTargetedResourceIds(params: {
  resourceType: "plugin_installation"
  conversationId: string
}): Promise<string[]> {
  // Discover grants that target a whole conversation ("any participant in
  // conversation X can use resource Y"). The standard subject machinery only
  // surfaces these when the caller has a conversation_actor_context subject,
  // which actors get for free. Remote agents do not have a
  // conversation_actor_context row, so we have to ask the bindings table
  // directly. Workspace-scoped grants are still discovered via the normal
  // lookupResources({type:'workspace'}) path; this helper only fills the
  // conversation-target gap.
  const column = "plugin_installation_id"
  const result = await db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .select(sql<string>`binding.${sql.raw(column)}::text`.as("resource_id"))
    .where("binding.resource_type", "=", params.resourceType)
    .where("binding.status", "=", "active")
    .where("subj.kind", "=", "conversation")
    .where("subj.conversation_id", "=", params.conversationId)
    .where(sql<boolean>`binding.${sql.raw(column)} IS NOT NULL`)
    .distinct()
    .execute()
  return result.map((row) => row.resource_id)
}

async function loadVisiblePlugins(params: ResolveParams) {
  const subjects = await buildVisibilitySubjects(params)
  const visibleInstallationIds = new Set<string>()

  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupResources(db, {
        resourceType: ACCESS_ACTIONS["plugin_installation.use"].resourceType,
        permission: ACCESS_ACTIONS["plugin_installation.use"].permission,
        subject,
      })
    )
  )

  for (const ids of lookups) {
    for (const id of ids) {
      visibleInstallationIds.add(id)
    }
  }

  // Remote-agent flow has no actor identity, so the subject machinery cannot
  // surface conversation-target plugin grants. Backfill from a direct query.
  if (params.remoteAgentId && !params.actorId && params.conversationId) {
    const extra = await loadConversationTargetedResourceIds({
      resourceType: "plugin_installation",
      conversationId: params.conversationId,
    })
    for (const id of extra) visibleInstallationIds.add(id)
  }

  if (visibleInstallationIds.size === 0) {
    return [] as VisiblePluginRow[]
  }

  const rows = await db
    .selectFrom("plugin_installations as installation")
    .innerJoin(
      "catalog_items as item",
      "item.id",
      "installation.catalog_item_id"
    )
    .innerJoin("publishers as publisher", "publisher.id", "item.publisher_id")
    .innerJoin(
      "plugin_package_version_specs as spec",
      "spec.catalog_version_id",
      "installation.catalog_version_id"
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
        "conversation_type_mask_override"
      ),
      "installation.reuse_scope",
    ])
    .where("installation.id", "in", Array.from(visibleInstallationIds))
    .where("installation.status", "=", "active")
    .where("installation.deleted_at", "is", null)
    .orderBy("installation.updated_at", "desc")
    .execute()

  const [bindingsByInstallationId, workspacePolicyMap] = await Promise.all([
    loadVisibleAccessBindings({
      resourceType: "plugin_installation",
      resourceIds: rows.map((row) => row.installation_id),
    }),
    getWorkspaceCapabilityConversationTypePolicyMap(
      rows.map((row) => row.owner_workspace_id)
    ),
  ])

  return rows.filter((row) => {
    const workspaceConversationTypeMask =
      workspacePolicyMap.get(row.owner_workspace_id)?.plugin_installation ||
      DEFAULT_CONVERSATION_TYPE_MASK
    const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
      workspaceConversationTypeMask,
      row.conversation_type_mask_override
    )
    const matchingBindings = (
      bindingsByInstallationId.get(row.installation_id) || []
    ).filter(
      (binding) =>
        accessBindingMatchesContext(binding, params) &&
        isConversationTypeAllowed(
          resolveNarrowedConversationTypeMask(
            instanceConversationTypeMask,
            binding.conversation_type_mask_override
          ),
          params
        )
    )
    return matchingBindings.length > 0
  }) as VisiblePluginRow[]
}

async function resolveTools(
  params: ResolveParams,
  dispatch: Map<string, PluginDispatchEntry>,
  turnOwnerKey: string
) {
  const visiblePlugins = await loadVisiblePlugins(params)
  const tools: ProjectedToolDefinition[] = []

  for (const plugin of visiblePlugins) {
    if (!plugin.reuse_scope) {
      continue
    }

    // Narrow to runtime-startable server transports. The catalog spec column
    // also allows "device", which is served by the separate device-exposure
    // path, not the instance-manager — never forward it to getOrCreateInstance.
    if (
      !(MCP_SERVER_TRANSPORTS as readonly string[]).includes(plugin.transport)
    ) {
      continue
    }
    const serverTransport = plugin.transport as McpServerTransport

    try {
      const resolved = await resolveInstallationConfig(plugin.installation_id)
      const reuseScope = publicReuseScope(plugin.reuse_scope)
      const runtimeInstance = await getOrCreateInstance({
        pluginId: plugin.catalog_item_id,
        installationId: resolved.installationId,
        pluginSlug: plugin.item_slug,
        orgSlug: plugin.publisher_slug || "plugin",
        transport: serverTransport,
        entryPoint: plugin.entry_point || "",
        scope: reuseScope,
        scopeId: resolveReuseOwnerKey(reuseScope, params, turnOwnerKey),
        config: resolved.config,
        workspaceId: plugin.owner_workspace_id,
      })

      const manifest = asArray<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>(plugin.tool_manifest)
      const upstreamTools =
        runtimeInstance.tools.length > 0
          ? runtimeInstance.tools
          : manifest.map((tool) => manifestToolToDefinition(tool))

      for (const tool of upstreamTools) {
        const ref = buildPluginToolRef(runtimeInstance, tool.name)
        // The plugin attribution that used to be baked into the name now lives
        // on the ref; keep the bracketed description hint for the model.
        const projected: ProjectedToolDefinition = {
          ...tool,
          description: `[${plugin.publisher_slug || "plugin"}/${plugin.item_slug}] ${tool.description}`,
          ref,
        }
        tools.push(projected)
        dispatch.set(ref.toolId, {
          instance: runtimeInstance,
          upstreamToolName: tool.name,
          ref,
        })
      }
    } catch (error: any) {
      log.error(
        { err: error.message },
        `[MCP ToolResolver] Failed to initialize plugin ${plugin.publisher_slug || "plugin"}/${plugin.item_slug}`
      )
    }
  }

  return tools
}

export async function resolveMcpToolsForActor(
  params: ResolveParams
): Promise<ResolvedMcpTools> {
  if (!params.actorId) {
    throw new Error(
      "resolveMcpToolsForActor requires actorId; call resolveMcpToolsForRemoteAgent for the remote-agent flow"
    )
  }
  return resolveMcpToolsCommon(params)
}

export async function resolveMcpToolsForRemoteAgent(
  params: Omit<ResolveParams, "actorId"> & {
    remoteAgentId: string
    conversationId: string
  }
): Promise<ResolvedMcpTools> {
  // actorId stays undefined; subject builder + accessBindingMatchesContext
  // already understand this discriminator and route through the workspace +
  // conversation-target grant paths only.
  return resolveMcpToolsCommon({ ...params, actorId: undefined })
}

async function resolveMcpToolsCommon(
  params: ResolveParams
): Promise<ResolvedMcpTools> {
  const mcpVersion = await getMcpVersion(params.workspaceId)
  const turnOwnerKey = `session:${params.sessionId}:turn:${randomUUID()}`
  const dispatch = new Map<string, PluginDispatchEntry>()
  const allTools = await resolveTools(params, dispatch, turnOwnerKey)

  let currentTurnId: string | undefined
  let currentRound: number | undefined
  const setTurnId = (turnId: string, round?: number) => {
    currentTurnId = turnId
    currentRound = round
  }

  const executor = async (
    toolId: string,
    input: Record<string, unknown>,
    executionContext?: McpExecutionContext
  ): Promise<NormalizedMcpToolResult> => {
    const entry = dispatch.get(toolId)
    if (!entry) {
      throw new Error(`No MCP instance found for toolId ${toolId}`)
    }
    const { instance, upstreamToolName, ref } = entry

    const startTime = Date.now()
    let rawOutput: unknown
    let isError = false
    let errorMessage: string | undefined

    // Legacy ToolResultOrigin (mcp_remote / callable_plugin) derived from the
    // ref's binding transport. Phase 4 converges NormalizedMcpToolResult.origin
    // onto the public projection; until then we emit the legacy shape so the
    // un-migrated ingest/normalizer types still line up.
    const origin: ToolResultOrigin =
      ref.binding.transport === "in_process"
        ? {
            kind: "callable_plugin",
            pluginKey: `${instance.orgSlug}/${instance.pluginSlug}`,
            pluginName: instance.pluginSlug,
          }
        : {
            kind: "mcp_remote",
            serverKey: `${instance.orgSlug}/${instance.pluginSlug}`,
            serverName: instance.pluginSlug,
          }

    try {
      rawOutput = await instance.execute(
        upstreamToolName,
        input,
        executionContext
      )
      return await normalizeMcpToolResult(rawOutput, params.workspaceId, {
        origin,
      })
    } catch (error: any) {
      isError = true
      errorMessage = error.message
      if (error && typeof error === "object" && !error.origin) {
        try {
          error.origin = origin
        } catch {}
      }
      throw error
    } finally {
      const durationMs = Date.now() - startTime
      const output =
        rawOutput === undefined
          ? undefined
          : typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput)

      await logToolCall({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        turnId: currentTurnId,
        round: currentRound,
        actorId: params.actorId,
        userId: params.userId,
        pluginId: instance.pluginId,
        toolName: upstreamToolName,
        toolType: "mcp_plugin",
        input,
        output,
        isError,
        errorMessage,
        durationMs,
        transport: instance.transport,
        instanceKey: toolId,
      }).catch((logError) => {
        log.error(
          { err: logError },
          "[MCP ToolResolver] Failed to log tool call"
        )
      })
    }
  }

  const refresh = async () => {
    const nextVersion = await getMcpVersion(params.workspaceId)
    dispatch.clear()
    const refreshedTools = await resolveTools(params, dispatch, turnOwnerKey)
    return {
      tools: refreshedTools,
      mcpVersion: nextVersion,
    }
  }

  const shutdown = async () => {
    const seen = new Set<McpInstance>()
    const turnScopedInstances: McpInstance[] = []
    for (const { instance } of dispatch.values()) {
      if (seen.has(instance)) continue
      seen.add(instance)
      if (instance.scope === "turn" && instance.scopeId === turnOwnerKey) {
        turnScopedInstances.push(instance)
      }
    }
    await Promise.allSettled(
      turnScopedInstances.map((instance) => instance.shutdown())
    )
  }

  return {
    tools: allTools,
    executor,
    mcpVersion,
    refresh,
    setTurnId,
    shutdown,
  }
}
