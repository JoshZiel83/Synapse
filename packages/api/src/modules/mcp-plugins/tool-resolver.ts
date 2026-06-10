import { randomUUID } from "crypto"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  MCP_SERVER_TRANSPORTS,
  SUBJECT_KIND,
  maskAllowsConversationType,
  resolveNarrowedConversationTypeMask,
  pluginToolId,
  toPublicOrigin,
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
import { db } from "../../infrastructure/database/kysely.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { buildConversationCapabilitySubjects } from "../access/subject-resolution.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import { resolveInstallationConfig } from "./config-resolver.js"
import {
  getOrCreateInstance,
  type McpExecutionContext,
  type McpInstance,
} from "./instance-manager.js"
import { getMcpVersion } from "./runtime-version.js"
import { normalizeMcpToolResult } from "./result-normalizer.js"
import { upsertAccessSubject } from "../access/subject-registry.js"

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
  refresh: () => Promise<{
    tools: ProjectedToolDefinition[]
    mcpVersion: number
  }>
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
  // Remote agents pick up workspace-shared resources plus an extra
  // conversation-target grant pass.
  actorId?: string
  remoteAgentId?: string
}

type VisiblePluginRow = {
  installationId: string
  ownerWorkspaceId: string
  installationStatus: "active" | "disabled" | "error" | "archived"
  catalogItemId: string
  itemSlug: string
  publisherSlug: string
  transport: PluginSpecTransport
  entryPoint: string | null
  toolManifest: unknown
  reuseScope: "turn" | "session" | "workspace" | "conversation" | "actor" | null
  conversationTypeMaskOverride: number | null
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
    | "remote_agent"
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
  created_at: Date | null
  revoked_at: Date | null
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
    instance.transport === "builtin"
      ? "in_process"
      : (instance.transport as "stdio" | "http" | "sse")
  const binding: ToolRef["binding"] =
    transport === "in_process"
      ? { transport: "in_process", dispatch: "callable" }
      : {
          transport,
          instanceKey: `${instance.installationId}:${instance.configHash}:${instance.scope}:${instance.scopeId}`,
        }
  return {
    toolId: pluginToolId(instance.installationId, upstreamToolName),
    source: {
      kind: "plugin",
      installationId: instance.installationId,
      upstreamToolName,
      // Durable display fields so post-purge audit shows a readable name.
      publisherSlug: instance.orgSlug,
      itemSlug: instance.pluginSlug,
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

async function buildVisibilitySubjectIds(params: ResolveParams) {
  const subjects = await buildVisibilitySubjects(params)
  const subjectIds = await Promise.all(
    subjects.map((subject) =>
      upsertAccessSubject(db, {
        kind:
          subject.type === "workspace"
            ? SUBJECT_KIND.WORKSPACE
            : subject.type === "workspace_member"
              ? SUBJECT_KIND.WORKSPACE_MEMBER
              : subject.type === "actor"
                ? SUBJECT_KIND.ACTOR
                : SUBJECT_KIND.REMOTE_AGENT,
        ...(subject.type === "workspace" ? { workspaceId: subject.id } : {}),
        ...(subject.type === "workspace_member"
          ? { memberId: subject.id }
          : {}),
        ...(subject.type === "actor" ? { actorId: subject.id } : {}),
        ...(subject.type === "remote_agent"
          ? { remoteAgentId: subject.id }
          : {}),
      } as any)
    )
  )

  let conversationSubjectId: string | null = null
  if (params.conversationId) {
    conversationSubjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.CONVERSATION,
      conversationId: params.conversationId,
    })
    subjectIds.push(conversationSubjectId)
  }

  return {
    subjectIds,
    runtimeScopeSubjectIds: conversationSubjectId
      ? [conversationSubjectId]
      : [],
  }
}

function publicReuseScope(scope: VisiblePluginRow["reuseScope"]) {
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
      return (
        params.actorId !== undefined &&
        row.actor_id === params.actorId &&
        (!row.conversation_id || row.conversation_id === params.conversationId)
      )
    case "remote_agent":
      return (
        params.remoteAgentId !== undefined &&
        row.remote_agent_id === params.remoteAgentId &&
        (!row.conversation_id || row.conversation_id === params.conversationId)
      )
  }
}

async function loadVisibleAccessBindings(params: { resourceIds: string[] }) {
  if (params.resourceIds.length === 0) {
    return new Map<string, VisibleAccessBindingRow[]>()
  }

  const rows = await db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select([
      "app_grant.id",
      "app_grant.workspaceId",
      "app_grant.workspaceAppId as resourceId",
      "app_grant.conversationTypeMaskOverride",
      "app_grant.status",
      "app_grant.createdByWorkspaceMemberId",
      "app_grant.reason",
      "app_grant.createdAt",
      "app_grant.revokedAt",
      "subj.kind as subjectKind",
      "subj.workspaceId as subjectWorkspaceIdViaJoin",
      "subj.workspaceMemberId as subjectWorkspaceMemberIdViaJoin",
      "subj.actorId as subjectActorIdViaJoin",
      "subj.remoteAgentId as subjectRemoteAgentIdViaJoin",
      "subj.conversationId as subjectConversationIdViaJoin",
      "scope.kind as scopeKind",
      "scope.conversationId as scopeConversationIdViaJoin",
    ])
    .where("app_grant.workspaceAppId", "in", params.resourceIds)
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .execute()

  const map = new Map<string, VisibleAccessBindingRow[]>()
  for (const rawRow of rows) {
    const row = rawRow as typeof rawRow & {
      subjectKind?: string | null
      subjectWorkspaceIdViaJoin?: string | null
      subjectWorkspaceMemberIdViaJoin?: string | null
      subjectActorIdViaJoin?: string | null
      subjectRemoteAgentIdViaJoin?: string | null
      subjectConversationIdViaJoin?: string | null
      scopeKind?: string | null
      scopeConversationIdViaJoin?: string | null
    }
    let target_type: VisibleAccessBindingRow["target_type"] | null
    switch (row.subjectKind) {
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
    if (target_type === null) {
      // Unknown subject kind — fail closed by dropping the row entirely.
      continue
    }
    const subjectActorId = row.subjectActorIdViaJoin ?? null
    const subjectRemoteAgentId = row.subjectRemoteAgentIdViaJoin ?? null
    const subjectConversationId =
      row.scopeConversationIdViaJoin ?? row.subjectConversationIdViaJoin ?? null
    const visible: VisibleAccessBindingRow = {
      id: row.id,
      workspace_id: row.workspaceId,
      resource_type: "plugin_installation",
      resource_id: row.resourceId,
      target_type,
      subject_workspace_id: row.subjectWorkspaceIdViaJoin ?? null,
      subject_workspace_member_id: row.subjectWorkspaceMemberIdViaJoin ?? null,
      subject_actor_id: subjectActorId,
      subject_remote_agent_id: subjectRemoteAgentId,
      subject_conversation_id: subjectConversationId,
      conversation_type_mask_override: row.conversationTypeMaskOverride,
      status: row.status,
      created_by_workspace_member_id: row.createdByWorkspaceMemberId,
      reason: row.reason,
      metadata: {},
      created_at: row.createdAt ? new Date(row.createdAt) : null,
      revoked_at: row.revokedAt ? new Date(row.revokedAt) : null,
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

async function loadVisiblePlugins(params: ResolveParams) {
  const { subjectIds, runtimeScopeSubjectIds } =
    await buildVisibilitySubjectIds(params)
  const visibleInstallationIds = new Set<string>()
  const grantRows = await db
    .selectFrom("workspaceAppGrants as app_grant")
    .select("app_grant.workspaceAppId")
    .distinct()
    .where("app_grant.status", "=", "active")
    .where("app_grant.subjectId", "in", subjectIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .where((eb) =>
      runtimeScopeSubjectIds.length > 0
        ? eb.or([
            eb("app_grant.scopeSubjectId", "is", null),
            eb("app_grant.scopeSubjectId", "in", runtimeScopeSubjectIds),
          ])
        : eb("app_grant.scopeSubjectId", "is", null)
    )
    .execute()

  for (const row of grantRows) {
    visibleInstallationIds.add(row.workspaceAppId)
  }

  if (visibleInstallationIds.size === 0) {
    return [] as VisiblePluginRow[]
  }

  const installationRows = await db
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .innerJoin("catalogItems as item", "item.id", "installation.catalogItemId")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisherId")
    .innerJoin(
      "pluginPackageVersionSpecs as spec",
      "spec.catalogVersionId",
      "installation.catalogVersionId"
    )
    .select([
      "installation.id as installationId",
      "app.workspaceId as ownerWorkspaceId",
      "app.status as installationStatus",
      "installation.catalogItemId",
      "item.slug as itemSlug",
      "publisher.slug as publisherSlug",
      "spec.transport",
      "spec.entryPoint",
      "spec.toolManifest",
      sql<number | null>`app.conversation_type_mask_override`.as(
        "conversationTypeMaskOverride"
      ),
      "installation.reuseScope",
    ])
    .where("installation.id", "in", Array.from(visibleInstallationIds))
    .where("app.status", "=", "active")
    .where("app.deletedAt", "is", null)
    .orderBy("installation.updatedAt", "desc")
    .execute()

  const [bindingsByInstallationId, workspacePolicyMap] = await Promise.all([
    loadVisibleAccessBindings({
      resourceIds: installationRows.map((row) => row.installationId),
    }),
    getWorkspaceCapabilityConversationTypePolicyMap(
      installationRows.map((row) => row.ownerWorkspaceId)
    ),
  ])

  return installationRows.filter((row) => {
    const workspaceConversationTypeMask =
      workspacePolicyMap.get(row.ownerWorkspaceId)?.plugin_installation ||
      DEFAULT_CONVERSATION_TYPE_MASK
    const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
      workspaceConversationTypeMask,
      row.conversationTypeMaskOverride
    )
    const matchingBindings = (
      bindingsByInstallationId.get(row.installationId) || []
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
    if (!plugin.reuseScope) {
      continue
    }

    // Narrow to runtime-startable server transports before forwarding to
    // getOrCreateInstance.
    if (
      !(MCP_SERVER_TRANSPORTS as readonly string[]).includes(plugin.transport)
    ) {
      continue
    }
    const serverTransport = plugin.transport as McpServerTransport

    try {
      const resolved = await resolveInstallationConfig(plugin.installationId)
      const reuseScope = publicReuseScope(plugin.reuseScope)
      const runtimeInstance = await getOrCreateInstance({
        pluginId: plugin.catalogItemId,
        installationId: resolved.installationId,
        pluginSlug: plugin.itemSlug,
        orgSlug: plugin.publisherSlug || "plugin",
        transport: serverTransport,
        entryPoint: plugin.entryPoint || "",
        scope: reuseScope,
        scopeId: resolveReuseOwnerKey(reuseScope, params, turnOwnerKey),
        config: resolved.config,
        workspaceId: plugin.ownerWorkspaceId,
      })

      const manifest = asArray<{
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
      }>(plugin.toolManifest)
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
          description: `[${plugin.publisherSlug || "plugin"}/${plugin.itemSlug}] ${tool.description}`,
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
        `[MCP ToolResolver] Failed to initialize plugin ${plugin.publisherSlug || "plugin"}/${plugin.itemSlug}`
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

  const setTurnId = (_turnId: string, _round?: number) => {}

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

    const origin: ToolResultOrigin = toPublicOrigin(ref)

    try {
      const rawOutput = await instance.execute(
        upstreamToolName,
        input,
        executionContext
      )
      return await normalizeMcpToolResult(rawOutput, params.workspaceId, {
        origin,
      })
    } catch (error: any) {
      if (error && typeof error === "object" && !error.origin) {
        try {
          error.origin = origin
        } catch {}
      }
      throw error
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
