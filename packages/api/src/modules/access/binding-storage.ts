import {
  executeTakeFirst,
  db as defaultDb,
} from "../../infrastructure/database/kysely.js"
import type {
  KyselyDb,
  QueryExecutor,
  TableInsert,
} from "../../infrastructure/database/kysely.js"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
  type AccessSubjectRow,
} from "./subject-registry.js"
import type {
  AccessBindableResourceType,
  AccessGrantTarget,
} from "./bindings.js"

export type AccessBindingSource =
  | "manual"
  | "default_open"
  | "relay_auto"
  | "approval"
  | "system"

/**
 * P1b contract: only `subject_id` is written. The historical polymorphic
 * columns (`target_type`, `subject_workspace_id`, `subject_actor_id`,
 * `subject_conversation_id`, `subject_conversation_actor_context_id`) have
 * been dropped from `resource_access_bindings`. SELECT-side code JOINs
 * `access_subjects` to reconstruct equivalent fields when needed
 * (see `accessSubjectRowToGrantTarget` below).
 *
 * Callers should already be in a transaction so that the access_subjects
 * upsert and the binding insert commit atomically.
 */
export async function buildResourceAccessBindingInsertValues(
  db: KyselyDb,
  input: {
    workspaceId: string
    resourceType: AccessBindableResourceType
    resourceId: string
    target: AccessGrantTarget
    conversationTypeMaskOverride?: number | null
    createdByWorkspaceMemberId?: string | null
    reason?: string | null
    source?: AccessBindingSource
  }
): Promise<TableInsert<"resource_access_bindings">> {
  const ref = accessGrantTargetToSubjectRefLocal(input.target)
  const subjectId = await upsertAccessSubject(db, ref)
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
    subject_id: subjectId,
    conversation_type_mask_override: input.conversationTypeMaskOverride ?? null,
    status: "active" as const,
    source: input.source ?? "manual",
    created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
    reason: input.reason ?? null,
  } satisfies TableInsert<"resource_access_bindings">
}

function accessGrantTargetToSubjectRefLocal(
  target: AccessGrantTarget
): SubjectRef {
  switch (target.targetType) {
    case "workspace":
      return {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: target.subjectWorkspaceId,
      }
    case "workspace_member":
      return {
        kind: SUBJECT_KIND.WORKSPACE_MEMBER,
        memberId: target.subjectWorkspaceMemberId,
      }
    case "conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: target.subjectConversationId,
      }
    case "actor":
      return { kind: SUBJECT_KIND.ACTOR, actorId: target.subjectActorId }
    case "actor_in_conversation":
      return {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: target.subjectConversationActorContextId,
      }
  }
}

/**
 * SELECT-side projection from an `access_subjects` row (joined onto a
 * binding) back to the application-layer `AccessGrantTarget`. The
 * `conversation_actor_context_id` case requires the joined
 * `conversation_actor_contexts` row to recover `actor_id` + `conversation_id`.
 */
export type AccessSubjectRowFields = {
  kind: string
  workspace_id: string | null
  workspace_member_id: string | null
  actor_id: string | null
  conversation_id: string | null
  conversation_actor_context_id: string | null
}

export function accessSubjectRowToGrantTarget(
  subjectRow: AccessSubjectRowFields,
  contextRow?: { actor_id: string; conversation_id: string } | null
): AccessGrantTarget {
  switch (subjectRow.kind) {
    case "workspace":
      if (!subjectRow.workspace_id)
        throw new Error("workspace subject missing workspace_id")
      return {
        targetType: "workspace",
        subjectWorkspaceId: subjectRow.workspace_id,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "workspace_member":
      if (!subjectRow.workspace_member_id)
        throw new Error("workspace_member subject missing workspace_member_id")
      return {
        targetType: "workspace_member",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: subjectRow.workspace_member_id,
        subjectActorId: null,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation":
      if (!subjectRow.conversation_id)
        throw new Error("conversation subject missing conversation_id")
      return {
        targetType: "conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: null,
        subjectConversationId: subjectRow.conversation_id,
        subjectConversationActorContextId: null,
      }
    case "actor":
      if (!subjectRow.actor_id)
        throw new Error("actor subject missing actor_id")
      return {
        targetType: "actor",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: subjectRow.actor_id,
        subjectConversationId: null,
        subjectConversationActorContextId: null,
      }
    case "conversation_actor_context":
      if (!subjectRow.conversation_actor_context_id)
        throw new Error("conversation_actor_context subject missing context id")
      if (!contextRow)
        throw new Error(
          "actor_in_conversation binding requires the conversation_actor_contexts JOIN row to derive actor_id/conversation_id"
        )
      return {
        targetType: "actor_in_conversation",
        subjectWorkspaceId: null,
        subjectWorkspaceMemberId: null,
        subjectActorId: contextRow.actor_id,
        subjectConversationId: contextRow.conversation_id,
        subjectConversationActorContextId:
          subjectRow.conversation_actor_context_id,
      }
    default:
      throw new Error(
        `Subject kind ${subjectRow.kind} cannot be a resource_access_bindings target`
      )
  }
}

/**
 * Map an access_subjects row's `kind` to the legacy `target_type` enum value
 * used by AccessGrantTarget. The `conversation_actor_context` kind maps to
 * `actor_in_conversation` for legacy compatibility.
 */
export function subjectKindToTargetType(
  kind: string
):
  | "workspace"
  | "workspace_member"
  | "conversation"
  | "actor"
  | "actor_in_conversation" {
  switch (kind) {
    case "workspace":
      return "workspace"
    case "workspace_member":
      return "workspace_member"
    case "conversation":
      return "conversation"
    case "actor":
      return "actor"
    case "conversation_actor_context":
      return "actor_in_conversation"
    default:
      throw new Error(`Unsupported subject kind for binding target: ${kind}`)
  }
}

/**
 * `pg.PoolClient`-compatible variant of `buildResourceAccessBindingInsertValues`.
 *
 * Use this from inside `transaction(async client => ...)` blocks so that both
 * the subject upsert AND the binding insert commit (or roll back) atomically
 * on the same transactional connection.
 */
export async function buildResourceAccessBindingInsertValuesOn(
  client: QueryExecutor,
  input: {
    workspaceId: string
    resourceType: AccessBindableResourceType
    resourceId: string
    target: AccessGrantTarget
    conversationTypeMaskOverride?: number | null
    createdByWorkspaceMemberId?: string | null
    reason?: string | null
    source?: AccessBindingSource
  }
): Promise<TableInsert<"resource_access_bindings">> {
  const ref = accessGrantTargetToSubjectRefLocal(input.target)
  const subjectId = await upsertAccessSubjectOn(client, ref)
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
    subject_id: subjectId,
    conversation_type_mask_override: input.conversationTypeMaskOverride ?? null,
    status: "active" as const,
    source: input.source ?? "manual",
    created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
    reason: input.reason ?? null,
  } satisfies TableInsert<"resource_access_bindings">
}

// ---------- P3 consolidation: unified read / mutate entry points ----------
//
// These helpers are the single intended API surface for callers that previously
// wrote bare `resource_access_bindings` SQL (mcp-plugins/relay-access.ts,
// mcp-plugins/service.ts, skills/service.ts, automation/service.ts). They JOIN
// `access_subjects` so the caller never has to think about the subject_id
// indirection.

import type { AccessBindingRow, AccessBindingTargetType } from "./bindings.js"

export async function insertAccessBindingReturningIdOn(
  client: QueryExecutor,
  params: Parameters<typeof buildResourceAccessBindingInsertValuesOn>[1]
): Promise<string> {
  const values = await buildResourceAccessBindingInsertValuesOn(client, params)
  const inserted = await executeTakeFirst<{ id: string }>(
    client,
    defaultDb
      .insertInto("resource_access_bindings")
      .values(values)
      .returning("id")
  )
  if (!inserted) {
    throw new Error("Failed to insert resource_access_bindings row")
  }
  return inserted.id
}

export async function insertAccessBindingReturningRowOn(
  client: QueryExecutor,
  params: Parameters<typeof buildResourceAccessBindingInsertValuesOn>[1]
): Promise<AccessBindingRow> {
  const values = await buildResourceAccessBindingInsertValuesOn(client, params)
  const inserted = await executeTakeFirst<AccessBindingRow>(
    client,
    defaultDb
      .insertInto("resource_access_bindings")
      .values(values)
      .returningAll()
  )
  if (!inserted) {
    throw new Error("Failed to insert resource_access_bindings row")
  }
  return augmentInsertedBindingRowWithTarget(
    inserted,
    params.target
  ) as AccessBindingRow
}

/**
 * After an INSERT ... RETURNING * on resource_access_bindings, the returned
 * row only has `subject_id` — no `target_type` or `subject_*_id` projections
 * (those columns were dropped in P1b). Callers that need to feed the row to
 * `normalizeAccessBindingRow` / `mapAccessBindingToGrant` must reconstruct
 * those derived fields from the AccessGrantTarget they originally wrote. This
 * helper performs that augmentation in one place — without it the downstream
 * functions throw "Unsupported access binding target type: undefined".
 */
export function augmentInsertedBindingRowWithTarget<
  T extends { subject_id: string | null },
>(
  inserted: T,
  target: AccessGrantTarget
): T & {
  target_type: AccessBindingTargetType
  subject_workspace_id: string | null
  subject_workspace_member_id: string | null
  subject_actor_id: string | null
  subject_conversation_id: string | null
  subject_conversation_actor_context_id: string | null
} {
  return {
    ...inserted,
    target_type: target.targetType,
    subject_workspace_id: target.subjectWorkspaceId,
    subject_workspace_member_id: target.subjectWorkspaceMemberId,
    subject_actor_id: target.subjectActorId,
    subject_conversation_id: target.subjectConversationId,
    subject_conversation_actor_context_id:
      target.subjectConversationActorContextId,
  }
}

import { sql } from "kysely"
import { CompiledQuery } from "kysely"
import type { AccessGrant } from "@synapse/shared/types"
import { mapAccessBindingToGrant } from "./bindings.js"

function resourceIdColumnFor(resourceType: AccessBindableResourceType) {
  switch (resourceType) {
    case "installed_skill":
      return "binding.installed_skill_id"
    case "plugin_installation":
      return "binding.plugin_installation_id"
    case "automation_event_source":
      return "binding.automation_event_source_id"
    case "actor":
      return "binding.actor_id"
    case "remote_agent":
      return "binding.remote_agent_id"
  }
}

/**
 * List the active access grants on a given resource. Always JOINs
 * access_subjects so the returned grants carry a decoded AccessGrantTarget,
 * not a raw subject_id. For `conversation_actor_context` subjects we also
 * LEFT JOIN `conversation_actor_contexts` so the `actor_in_conversation`
 * target shape (which downstream readers require) carries the underlying
 * actor_id + conversation_id.
 */
export async function listGrantsForResource(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
    includeRevoked?: boolean
  }
): Promise<AccessGrant[]> {
  const column = resourceIdColumnFor(input.resourceType)
  let query = db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "subj.conversation_actor_context_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.installed_skill_id",
      "binding.plugin_installation_id",
      "binding.automation_event_source_id",
      "binding.actor_id",
      "binding.remote_agent_id",
      "binding.conversation_type_mask_override",
      "binding.status",
      "binding.source",
      "binding.created_by_workspace_member_id",
      "binding.reason",
      "binding.created_at",
      "binding.revoked_at",
      "subj.kind as subject_kind",
      "subj.workspace_id as subject_workspace_id",
      "subj.workspace_member_id as subject_workspace_member_id",
      // For `conversation_actor_context` subjects the underlying actor and
      // conversation ids live on conversation_actor_contexts — readers
      // (readAccessBindingTarget → "actor_in_conversation") demand both, so
      // COALESCE in from the cac row when the subject itself doesn't carry
      // them.
      sql<string | null>`COALESCE(subj.actor_id, cac.actor_id)`.as(
        "subject_actor_id"
      ),
      sql<
        string | null
      >`COALESCE(subj.conversation_id, cac.conversation_id)`.as(
        "subject_conversation_id"
      ),
      "subj.conversation_actor_context_id as subject_conversation_actor_context_id",
    ] as const)
    .where("binding.resource_type", "=", input.resourceType)
    .where(sql.ref(column), "=", input.resourceId)
  if (!input.includeRevoked) {
    query = query.where("binding.status", "=", "active")
  }
  const rows = await query.execute()
  // Map subject_kind to the legacy target_type enum readAccessBindingTarget
  // dispatches on (workspace / workspace_member / conversation / actor /
  // actor_in_conversation). The subject_*_id projections above already carry
  // the resolved actor + conversation for actor_in_conversation grants.
  return rows.map((row) => {
    const target_type = subjectKindToTargetType(
      row.subject_kind as AccessSubjectRow["kind"]
    )
    return mapAccessBindingToGrant({ ...(row as any), target_type })
  })
}

/**
 * Revoke a single binding by id. Idempotent — already-revoked bindings
 * become no-ops. Returns true if a row was updated.
 */
export async function revokeGrant(
  db: KyselyDb,
  input: {
    bindingId: string
    revokedByWorkspaceMemberId?: string | null
    reason?: string | null
  }
): Promise<boolean> {
  const result = await db
    .updateTable("resource_access_bindings")
    .set({
      status: "revoked" as const,
      revoked_at: sql`NOW()`,
    })
    .where("id", "=", input.bindingId)
    .where("status", "=", "active")
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0) > 0
}

/**
 * Replace the target of an existing binding with a new subject. Internally
 * upserts the new access_subjects row and points the binding at it.
 */
export async function updateGrantTargets(
  db: KyselyDb,
  input: {
    bindingId: string
    newTarget: AccessGrantTarget
  }
): Promise<void> {
  const ref = accessGrantTargetToSubjectRefLocal(input.newTarget)
  const subjectId = await upsertAccessSubject(db, ref)
  await db
    .updateTable("resource_access_bindings")
    .set({ subject_id: subjectId })
    .where("id", "=", input.bindingId)
    .execute()
}

/**
 * Describe the access grants on a resource as a structured summary. Replaces
 * the hand-rolled summary at skills/service.ts:2639-2660. The shape mirrors
 * what callers were building inline so they can swap to this helper one
 * resource at a time.
 */
export async function describeAccessGrants(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
  }
): Promise<{ grants: AccessGrant[]; activeCount: number }> {
  const grants = await listGrantsForResource(db, input)
  return { grants, activeCount: grants.length }
}

// ---------- P3 consolidation: bulk row helpers for the per-resource service
// layers (skills/automation/mcp-plugins). These return `AccessBindingRow`-shaped
// rows (with `target_type` / `subject_*_id` reconstructed from `access_subjects`
// + `conversation_actor_contexts`) so that the historical per-service decorator
// functions (buildSkillAccessRow, buildInstallationAccessRow, ...) can keep
// working unchanged. Without these, every service file would re-implement the
// same SELECT-with-JOIN over and over — which is exactly the duplication we
// are trying to remove.

import { normalizeAccessBindingRow } from "./bindings.js"

function bindingRowSelectFor(
  db: KyselyDb,
  resourceType: AccessBindableResourceType
) {
  const column = resourceIdColumnFor(resourceType)
  return db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "subj.conversation_actor_context_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.installed_skill_id",
      "binding.plugin_installation_id",
      "binding.automation_event_source_id",
      "binding.actor_id",
      "binding.remote_agent_id",
      "binding.subject_id",
      sql<string>`${sql.ref(column)}::text`.as("resource_id"),
      sql<AccessBindingTargetType>`CASE subj.kind
        WHEN 'workspace' THEN 'workspace'
        WHEN 'workspace_member' THEN 'workspace_member'
        WHEN 'conversation' THEN 'conversation'
        WHEN 'actor' THEN 'actor'
        WHEN 'conversation_actor_context' THEN 'actor_in_conversation'
      END`.as("target_type"),
      "subj.workspace_id as subject_workspace_id",
      "subj.workspace_member_id as subject_workspace_member_id",
      sql<string | null>`COALESCE(subj.actor_id, cac.actor_id)`.as(
        "subject_actor_id"
      ),
      sql<
        string | null
      >`COALESCE(subj.conversation_id, cac.conversation_id)`.as(
        "subject_conversation_id"
      ),
      "subj.conversation_actor_context_id as subject_conversation_actor_context_id",
      "binding.conversation_type_mask_override",
      "binding.status",
      "binding.source",
      "binding.created_by_workspace_member_id",
      "binding.reason",
      "binding.created_at",
      "binding.revoked_at",
    ] as const)
}

/**
 * Load the `AccessBindingRow`-shaped rows for one or more resources of the
 * same type. Used by per-service loaders (skills, automation, mcp-plugins,
 * tool-resolver) that previously hand-rolled the same SELECT + JOIN. Rows are
 * already passed through `normalizeAccessBindingRow` so callers can feed them
 * directly into `buildSkillAccessRow` / `buildInstallationAccessRow` /
 * `mapAccessBindingToGrant` without any extra plumbing.
 */
export async function loadAccessBindingRowsForResources(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceIds: string[]
    workspaceId?: string
    includeRevoked?: boolean
  }
): Promise<AccessBindingRow[]> {
  if (input.resourceIds.length === 0) return []
  const column = resourceIdColumnFor(input.resourceType)
  let query = bindingRowSelectFor(db, input.resourceType)
    .where("binding.resource_type", "=", input.resourceType)
    .where(sql.ref(column), "in", input.resourceIds)
  if (input.workspaceId) {
    query = query.where("binding.workspace_id", "=", input.workspaceId)
  }
  if (!input.includeRevoked) {
    query = query.where("binding.status", "=", "active")
  }
  const rows = await query
    .orderBy(sql.ref(column))
    .orderBy("binding.created_at")
    .execute()
  return rows.map((row) =>
    normalizeAccessBindingRow(row as unknown as AccessBindingRow)
  )
}

/**
 * Convenience wrapper around `loadAccessBindingRowsForResources` for the
 * common single-resource case. Returns the raw rows (not yet decoded into
 * AccessGrant — use `listGrantsForResource` for that).
 */
export async function loadAccessBindingRowsForResource(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
    workspaceId?: string
    includeRevoked?: boolean
  }
): Promise<AccessBindingRow[]> {
  return loadAccessBindingRowsForResources(db, {
    resourceType: input.resourceType,
    resourceIds: [input.resourceId],
    workspaceId: input.workspaceId,
    includeRevoked: input.includeRevoked,
  })
}

/**
 * SQL-side variant of `loadAccessBindingRowsForResources` that pre-filters
 * bindings to only those whose target shape matches the given runtime context.
 * Replaces the legacy "load all bindings + client-side `accessMatches…` filter"
 * dance with a single round-trip — the WHERE clause below mirrors
 * `capabilityTargetMatchesContext` semantics exactly so a binding included by
 * the SQL is one that the client-side matcher would have accepted.
 */
export async function loadAccessBindingRowsForResourcesAndContext(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceIds: string[]
    contextWorkspaceId: string
    actorId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    includeRevoked?: boolean
  }
): Promise<AccessBindingRow[]> {
  if (input.resourceIds.length === 0) return []
  const column = resourceIdColumnFor(input.resourceType)
  let query = bindingRowSelectFor(db, input.resourceType)
    .where("binding.resource_type", "=", input.resourceType)
    .where(sql.ref(column), "in", input.resourceIds)
  if (!input.includeRevoked) {
    query = query.where("binding.status", "=", "active")
  }
  // The OR-of-target-kinds below is the SQL twin of
  // `capabilityTargetMatchesContext` in access/bindings.ts. Keep the two in
  // sync — a binding accepted by one must be accepted by the other.
  query = query.where((eb) => {
    const conditions = [
      eb.and([
        eb("subj.kind", "=", "workspace"),
        eb("subj.workspace_id", "=", input.contextWorkspaceId),
      ]),
    ]
    if (input.workspaceMemberId) {
      conditions.push(
        eb.and([
          eb("subj.kind", "=", "workspace_member"),
          eb("subj.workspace_member_id", "=", input.workspaceMemberId),
        ])
      )
    }
    if (input.actorId) {
      conditions.push(
        eb.and([
          eb("subj.kind", "=", "actor"),
          eb("subj.actor_id", "=", input.actorId),
        ])
      )
    }
    if (input.conversationId) {
      conditions.push(
        eb.and([
          eb("subj.kind", "=", "conversation"),
          eb("subj.conversation_id", "=", input.conversationId),
        ])
      )
    }
    if (input.actorId && input.conversationId) {
      conditions.push(
        eb.and([
          eb("subj.kind", "=", "conversation_actor_context"),
          eb("cac.actor_id", "=", input.actorId),
          eb("cac.conversation_id", "=", input.conversationId),
        ])
      )
    }
    return eb.or(conditions)
  })
  const rows = await query
    .orderBy(sql.ref(column))
    .orderBy("binding.created_at")
    .execute()
  return rows.map((row) =>
    normalizeAccessBindingRow(row as unknown as AccessBindingRow)
  )
}

/**
 * True iff there is at least one binding (active or otherwise) for the given
 * resource. Replaces inline `SELECT id FROM resource_access_bindings WHERE
 * <resource> = ? LIMIT 1` existence probes. The `activeOnly` flag narrows to
 * status='active' bindings; callers like relay default-access setup leave it
 * false because they want to detect any previously-written binding.
 */
export async function hasAnyBindingForResourceOn(
  client: QueryExecutor,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
    activeOnly?: boolean
  }
): Promise<boolean> {
  const column = resourceIdColumnForRaw(input.resourceType)
  let sqlText = `SELECT 1 FROM resource_access_bindings WHERE ${column} = $1::uuid`
  if (input.activeOnly) {
    sqlText += ` AND status = 'active'`
  }
  sqlText += ` LIMIT 1`
  const result = await client.query(sqlText, [input.resourceId])
  return result.rows.length > 0
}

function resourceIdColumnForRaw(resourceType: AccessBindableResourceType) {
  switch (resourceType) {
    case "installed_skill":
      return "installed_skill_id"
    case "plugin_installation":
      return "plugin_installation_id"
    case "automation_event_source":
      return "automation_event_source_id"
    case "actor":
      return "actor_id"
    case "remote_agent":
      return "remote_agent_id"
  }
}

/**
 * Find an active binding by (resource, subject). Used by per-service
 * idempotent "ensure" flows. Returns the binding id (or null) without
 * materializing the whole row.
 */
export async function findActiveBindingIdByResourceAndSubject(
  client: QueryExecutor,
  input: {
    workspaceId: string
    resourceType: AccessBindableResourceType
    resourceId: string
    subjectId: string
  }
): Promise<string | null> {
  const column = resourceIdColumnForRaw(input.resourceType)
  const result = await client.query(
    `SELECT id
     FROM resource_access_bindings
     WHERE workspace_id = $1
       AND ${column} = $2::uuid
       AND subject_id = $3::uuid
       AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.workspaceId, input.resourceId, input.subjectId]
  )
  return result.rows[0]?.id ?? null
}

/**
 * Update only the `conversation_type_mask_override` column on a binding. The
 * binding's subject/target stays the same. Used by the per-service "update
 * grant visibility mask" endpoints that previously wrote bare UPDATE SQL.
 */
export async function updateGrantConversationTypeMaskOverride(
  db: KyselyDb,
  input: {
    bindingId: string
    workspaceId?: string
    conversationTypeMaskOverride: number | null
  }
): Promise<void> {
  let query = db
    .updateTable("resource_access_bindings")
    .set({
      conversation_type_mask_override: input.conversationTypeMaskOverride,
    })
    .where("id", "=", input.bindingId)
  if (input.workspaceId) {
    query = query.where("workspace_id", "=", input.workspaceId)
  }
  await query.execute()
}

/**
 * Bulk revoke variant of `revokeGrant`. Used by tear-down flows that pause
 * an entire device or remove a set of capabilities at once.
 */
export async function revokeGrantsByIdsOn(
  client: QueryExecutor,
  bindingIds: string[]
): Promise<void> {
  if (bindingIds.length === 0) return
  await client.query(
    `UPDATE resource_access_bindings
     SET status = 'revoked',
         revoked_at = NOW()
     WHERE id = ANY($1::uuid[])
       AND status = 'active'`,
    [bindingIds]
  )
}

/**
 * Hard-delete every binding pointing at a resource. Use this only when the
 * underlying resource row itself is also being deleted (cascade-style) — in
 * which case there is no point keeping a revoked tombstone. For "user removed
 * this grant but the resource lives on" flows use `revokeGrant`.
 */
export async function hardDeleteBindingsForResourceOn(
  client: QueryExecutor,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
  }
): Promise<void> {
  const column = resourceIdColumnForRaw(input.resourceType)
  await client.query(
    `DELETE FROM resource_access_bindings WHERE ${column} = $1::uuid`,
    [input.resourceId]
  )
}

/**
 * Hard-delete bindings for a resource — Kysely flavour for callers already
 * holding a KyselyDb (not a transaction client).
 */
export async function hardDeleteBindingsForResource(
  db: KyselyDb,
  input: {
    resourceType: AccessBindableResourceType
    resourceId: string
  }
): Promise<void> {
  const column = resourceIdColumnForRaw(input.resourceType)
  await db
    .deleteFrom("resource_access_bindings")
    .where(sql.ref(column), "=", input.resourceId)
    .execute()
}

/**
 * Read a single binding row by id (and optionally workspace). Returns the
 * full `AccessBindingRow` shape — with `target_type` and the subject_*_id
 * projections reconstructed from the access_subjects JOIN — or null if no
 * matching binding exists.
 */
export async function getAccessBindingRowById(
  db: KyselyDb,
  input: {
    bindingId: string
    workspaceId?: string
    resourceType?: AccessBindableResourceType
    resourceId?: string
  }
): Promise<AccessBindingRow | null> {
  const resourceType = input.resourceType ?? "installed_skill"
  let query = bindingRowSelectFor(db, resourceType).where(
    "binding.id",
    "=",
    input.bindingId
  )
  if (input.workspaceId) {
    query = query.where("binding.workspace_id", "=", input.workspaceId)
  }
  if (input.resourceType) {
    query = query.where("binding.resource_type", "=", input.resourceType)
  }
  if (input.resourceType && input.resourceId) {
    const column = resourceIdColumnFor(input.resourceType)
    query = query.where(sql.ref(column), "=", input.resourceId)
  }
  const row = await query.executeTakeFirst()
  if (!row) return null
  return normalizeAccessBindingRow(row as unknown as AccessBindingRow)
}

/**
 * Return the distinct resource ids in a workspace whose active bindings
 * match a subject-side filter. Centralizes the dynamic SQL that
 * `findSkillIdsByBindingFilter` used to build inline.
 *
 * Filter semantics (only the provided ones apply, ANDed together):
 *  - `subjectId`: exact subject_id match
 *  - `actorId`: subj.actor_id matches OR the binding's
 *     conversation_actor_context resolves to that actor
 *  - `conversationId`: subj.conversation_id matches OR the binding's
 *     conversation_actor_context resolves to that conversation
 */
export async function listResourceIdsForWorkspaceByBindingFilter(
  db: KyselyDb,
  input: {
    workspaceId: string
    resourceType: AccessBindableResourceType
    subjectId?: string | null
    actorId?: string | null
    conversationId?: string | null
  }
): Promise<string[]> {
  const column = resourceIdColumnForRaw(input.resourceType)
  const values: unknown[] = [input.workspaceId]
  const conditions = [
    `binding.workspace_id = $1`,
    `binding.${column} IS NOT NULL`,
    `binding.status = 'active'`,
    `binding.resource_type = $${values.push(input.resourceType)}`,
  ]
  if (input.subjectId) {
    values.push(input.subjectId)
    conditions.push(`binding.subject_id = $${values.length}::uuid`)
  } else {
    if (input.actorId) {
      values.push(input.actorId)
      conditions.push(
        `(subj.actor_id = $${values.length}::uuid OR subj.conversation_actor_context_id IN (
          SELECT id FROM conversation_actor_contexts WHERE actor_id = $${values.length}::uuid
        ))`
      )
    }
    if (input.conversationId) {
      values.push(input.conversationId)
      conditions.push(
        `(subj.conversation_id = $${values.length}::uuid OR subj.conversation_actor_context_id IN (
          SELECT id FROM conversation_actor_contexts WHERE conversation_id = $${values.length}::uuid
        ))`
      )
    }
  }
  const sqlText = `
    SELECT DISTINCT binding.${column}::text AS resource_id
    FROM resource_access_bindings binding
    INNER JOIN access_subjects subj ON subj.id = binding.subject_id
    WHERE ${conditions.join(" AND ")}
  `
  const result = await db.executeQuery<{ resource_id: string }>(
    CompiledQuery.raw(sqlText, values)
  )
  return result.rows.map((row) => row.resource_id)
}
