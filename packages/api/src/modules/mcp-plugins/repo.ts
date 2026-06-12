/**
 * mcp-plugins module repo.
 *
 * The only mcp-plugins service-facing file (besides mijia/repo.ts) allowed to
 * import the db client + `sql` (guard-layering r8/r1/r2). It owns the module's
 * raw queries and returns camelCase domain records, KEEPING Date objects (time
 * serialization belongs to presenters — guard r3). Raw `sql` fragments that
 * reference snake_case / enum-cast Postgres are kept verbatim because they
 * intentionally bypass the CamelCasePlugin.
 */

import { sql } from "kysely"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  SUBJECT_KIND,
  maskAllowsConversationType,
  redactSecrets,
  resolveNarrowedConversationTypeMask,
  type PluginSpecTransport,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { buildConversationCapabilitySubjects } from "../access/subject-resolution.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { getWorkspaceCapabilityConversationTypePolicyMap } from "../capabilities/conversation-type-policies.js"
import { PLUGIN_INSTALLATION_LIVE_STATUSES } from "./live-status.js"

// ---------------------------------------------------------------------------
// audit.ts queries
// ---------------------------------------------------------------------------

export type ToolCallAuditLogRecord = {
  id: string
  conversationId: string
  sessionId: string | null
  turnId: string
  actorId: string | null
  providerCallId: string | null
  toolName: string
  sourceKind: string
  sourceSnapshot: unknown
  pluginInstallationId: string | null
  deviceToolId: string | null
  normalizedInput: Record<string, unknown>
  status: string
  createdAt: Date
  completedAt: Date | null
  isError: boolean | null
  errorMessage: string | null
  resultMetadata: unknown
}

export async function listToolCallAuditLogs(
  workspaceId: string,
  filters?: {
    pluginId?: string
    sessionId?: string
    actorId?: string
    limit?: number
    before?: string
  }
): Promise<ToolCallAuditLogRecord[]> {
  const limit = Math.min(filters?.limit || 50, 200)
  let statement = db
    .selectFrom("toolCalls as tc")
    .innerJoin("conversations as c", "c.id", "tc.conversationId")
    .innerJoin("turns as t", "t.id", "tc.turnId")
    .leftJoin("pluginInstallations as pi", "pi.id", "tc.pluginInstallationId")
    .leftJoin("toolResults as tr", (join) =>
      join.onRef("tr.toolCallId", "=", "tc.id").on("tr.resultIndex", "=", 0)
    )
    .select([
      "tc.id",
      "tc.conversationId",
      "tc.sessionId",
      "tc.turnId",
      "t.actorId",
      "tc.providerCallId",
      "tc.toolName",
      "tc.sourceKind",
      "tc.sourceSnapshot",
      "tc.pluginInstallationId",
      "tc.deviceToolId",
      "tc.normalizedInput",
      "tc.status",
      "tc.createdAt",
      "tc.completedAt",
      "tr.isError",
      "tr.errorMessage",
      "tr.metadata as resultMetadata",
    ])
    .where("c.workspaceId", "=", workspaceId)

  if (filters?.sessionId) {
    statement = statement.where("tc.sessionId", "=", filters.sessionId)
  }
  if (filters?.actorId) {
    statement = statement.where("t.actorId", "=", filters.actorId)
  }
  if (filters?.pluginId) {
    statement = statement.where((eb) =>
      eb.or([
        eb("tc.pluginInstallationId", "=", filters.pluginId!),
        eb("pi.catalogItemId", "=", filters.pluginId!),
      ])
    )
  }
  if (filters?.before) {
    statement = statement.where("tc.createdAt", "<", new Date(filters.before))
  }

  const rows = await statement
    .orderBy("tc.createdAt", "desc")
    .limit(limit)
    .execute()
  return rows.map((row) => ({
    ...row,
    normalizedInput: redactSecrets(
      row.normalizedInput as Record<string, unknown>
    ),
  })) as ToolCallAuditLogRecord[]
}

export async function listRuntimeEventAuditLogs(
  workspaceId: string,
  filters?: {
    eventType?: string
    pluginId?: string
    limit?: number
    before?: string
  }
) {
  const limit = Math.min(filters?.limit || 50, 200)
  let statement = db
    .selectFrom("runtimeEvents")
    .selectAll()
    .where("workspaceId", "=", workspaceId)

  if (filters?.eventType) {
    statement = statement.where("eventType", "=", filters.eventType)
  }
  if (filters?.pluginId) {
    statement = statement.where(
      sql<boolean>`payload->>'pluginId' = ${filters.pluginId}`
    )
  }
  if (filters?.before) {
    statement = statement.where("createdAt", "<", new Date(filters.before))
  }

  return statement.orderBy("createdAt", "desc").limit(limit).execute()
}

// ---------------------------------------------------------------------------
// config-resolver.ts query
// ---------------------------------------------------------------------------

export interface InstallationConfigRow {
  catalogItemId: string
  configData: unknown
  defaultConfig: unknown
  configSchema: unknown
}

export async function findInstallationConfigRow(
  installationId: string
): Promise<InstallationConfigRow | undefined> {
  return (
    db
      // Live predicate (review F16): exclude tombstoned AND non-live status
      // (archived) installs — same definition as plugin_installations_live /
      // manifest liveValues. Read the base table (not the _live view) so the NOT
      // NULL column types are preserved (views type every column nullable).
      .selectFrom("pluginInstallations as installation")
      .innerJoin("workspaceApps as app", "app.id", "installation.id")
      .innerJoin(
        "pluginPackageVersionSpecs as spec",
        "spec.catalogVersionId",
        "installation.catalogVersionId"
      )
      .select([
        "installation.catalogItemId",
        "installation.configData",
        "spec.defaultConfig",
        "spec.configSchema",
      ])
      .where("installation.id", "=", installationId)
      .where("app.deletedAt", "is", null)
      .where("app.status", "in", PLUGIN_INSTALLATION_LIVE_STATUSES)
      .limit(1)
      .executeTakeFirst()
  )
}

// ---------------------------------------------------------------------------
// tool-resolver.ts queries + subject builders
// ---------------------------------------------------------------------------

export type VisiblePluginRow = {
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

export type VisibleAccessBindingRow = {
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

type VisibilitySubjectParams = {
  workspaceId: string
  workspaceMemberId?: string | null
  actorId?: string | null
  remoteAgentId?: string | null
  conversationId?: string | null
  sessionId?: string | null
}

async function buildVisibilitySubjects(params: VisibilitySubjectParams) {
  return buildConversationCapabilitySubjects(db, {
    workspaceId: params.workspaceId,
    workspaceMemberId: params.workspaceMemberId,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
  })
}

export async function buildPluginVisibilitySubjectIds(
  params: VisibilitySubjectParams
) {
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

function isConversationTypeAllowed(
  mask: number,
  params: { conversationKind?: "direct" | "group"; isImConversation?: boolean }
) {
  return maskAllowsConversationType(
    mask,
    params.conversationKind,
    params.isImConversation ?? false
  )
}

function accessBindingMatchesContext(
  row: VisibleAccessBindingRow,
  params: {
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
  }
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
        params.actorId != null &&
        row.actor_id === params.actorId &&
        (!row.conversation_id || row.conversation_id === params.conversationId)
      )
    case "remote_agent":
      return (
        params.remoteAgentId != null &&
        row.remote_agent_id === params.remoteAgentId &&
        (!row.conversation_id || row.conversation_id === params.conversationId)
      )
  }
}

export type LoadVisiblePluginRowsParams = VisibilitySubjectParams & {
  conversationId: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
}

export async function loadVisiblePluginRows(
  params: LoadVisiblePluginRowsParams
): Promise<VisiblePluginRow[]> {
  const { subjectIds, runtimeScopeSubjectIds } =
    await buildPluginVisibilitySubjectIds(params)
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
