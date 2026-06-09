import {
  db as defaultDb,
  runBuilder,
} from "../../infrastructure/database/kysely.js"
import type {
  Executor,
  KyselyDb,
  TableInsert,
} from "../../infrastructure/database/kysely.js"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "./subject-registry.js"
import type {
  AutomationEventSourceBindingResourceType,
  AutomationEventSourceBindingTarget,
} from "./bindings.js"
import {
  accessGrantTargetScopeRef,
  accessGrantTargetToSubjectRef,
} from "./bindings.js"

export type AutomationEventSourceBindingSource =
  | "manual"
  | "default_open"
  | "approval"
  | "system"

/**
 * D3: build the insert values for resource_access_bindings. `subject_id` is
 * the canonical reference; `scope_subject_id` is set when the target is
 * scoped (e.g. actor + scope=conversation).
 */
export async function buildAutomationEventSourceAccessBindingInsertValues(
  db: KyselyDb,
  input: {
    workspaceId: string
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    target: AutomationEventSourceBindingTarget
    conversationTypeMaskOverride?: number | null
    createdByWorkspaceMemberId?: string | null
    reason?: string | null
    source?: AutomationEventSourceBindingSource
  }
): Promise<TableInsert<"resource_access_bindings">> {
  const ref = accessGrantTargetToSubjectRef(input.target)
  const subjectId = await upsertAccessSubject(db, ref)
  const scopeRef = accessGrantTargetScopeRef(input.target)
  const scopeSubjectId = scopeRef
    ? await upsertAccessSubject(db, scopeRef)
    : null
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    automation_event_source_id: input.resourceId,
    subject_id: subjectId,
    scope_subject_id: scopeSubjectId,
    conversation_type_mask_override: input.conversationTypeMaskOverride ?? null,
    status: "active" as const,
    source: input.source ?? "manual",
    created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
    reason: input.reason ?? null,
  } satisfies TableInsert<"resource_access_bindings">
}

/**
 * `pg.PoolClient`-compatible variant of `buildAutomationEventSourceAccessBindingInsertValues`.
 */
export async function buildAutomationEventSourceAccessBindingInsertValuesOn(
  client: Executor,
  input: {
    workspaceId: string
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    target: AutomationEventSourceBindingTarget
    conversationTypeMaskOverride?: number | null
    createdByWorkspaceMemberId?: string | null
    reason?: string | null
    source?: AutomationEventSourceBindingSource
  }
): Promise<TableInsert<"resource_access_bindings">> {
  const ref = accessGrantTargetToSubjectRef(input.target)
  const subjectId = await upsertAccessSubjectOn(client, ref)
  const scopeRef = accessGrantTargetScopeRef(input.target)
  const scopeSubjectId = scopeRef
    ? await upsertAccessSubjectOn(client, scopeRef)
    : null
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    automation_event_source_id: input.resourceId,
    subject_id: subjectId,
    scope_subject_id: scopeSubjectId,
    conversation_type_mask_override: input.conversationTypeMaskOverride ?? null,
    status: "active" as const,
    source: input.source ?? "manual",
    created_by_workspace_member_id: input.createdByWorkspaceMemberId ?? null,
    reason: input.reason ?? null,
  } satisfies TableInsert<"resource_access_bindings">
}

// ---------- P3 consolidation: unified read / mutate entry points ----------

import type { AutomationEventSourceBindingRow } from "./bindings.js"

export async function insertAutomationEventSourceAccessBindingReturningIdOn(
  client: Executor,
  params: Parameters<
    typeof buildAutomationEventSourceAccessBindingInsertValuesOn
  >[1]
): Promise<string> {
  const values = await buildAutomationEventSourceAccessBindingInsertValuesOn(
    client,
    params
  )
  const result = await runBuilder<{ id: string }>(
    client,
    defaultDb
      .insertInto("resource_access_bindings")
      .values(values)
      .returning("id")
  )
  const inserted = result.rows[0]
  if (!inserted) {
    throw new Error("Failed to insert resource_access_bindings row")
  }
  return inserted.id
}

export async function insertAutomationEventSourceAccessBindingReturningRowOn(
  client: Executor,
  params: Parameters<
    typeof buildAutomationEventSourceAccessBindingInsertValuesOn
  >[1]
): Promise<AutomationEventSourceBindingRow> {
  const values = await buildAutomationEventSourceAccessBindingInsertValuesOn(
    client,
    params
  )
  const result = await runBuilder<AutomationEventSourceBindingRow>(
    client,
    defaultDb
      .insertInto("resource_access_bindings")
      .values(values)
      .returningAll()
  )
  const inserted = result.rows[0]
  if (!inserted) {
    throw new Error("Failed to insert resource_access_bindings row")
  }
  return augmentInsertedBindingRowWithTarget(
    inserted,
    params.target
  ) as AutomationEventSourceBindingRow
}

/**
 * D3: after an INSERT ... RETURNING * the returned row only has `subject_id`
 * and `scope_subject_id`. Augment the row with subject/scope projection
 * fields synthesized from the AutomationEventSourceBindingTarget so downstream readers
 * (`mapAutomationEventSourceAccessBindingToGrant` / `normalizeAutomationEventSourceAccessBindingRow`) decode the
 * subject without a second lookup.
 */
export function augmentInsertedBindingRowWithTarget<
  T extends { subject_id: string | null; scope_subject_id?: string | null },
>(
  inserted: T,
  target: AutomationEventSourceBindingTarget
): T & {
  scope_subject_id: string | null
  subject_kind: string
  subject_workspace_id_via_join: string | null
  subject_workspace_member_id_via_join: string | null
  subject_actor_id_via_join: string | null
  subject_remote_agent_id_via_join: string | null
  subject_conversation_id_via_join: string | null
  scope_kind: string | null
  scope_workspace_id_via_join: string | null
  scope_conversation_id_via_join: string | null
} {
  return {
    ...inserted,
    scope_subject_id:
      (inserted as { scope_subject_id?: string | null }).scope_subject_id ??
      null,
    subject_kind: target.subject.kind,
    subject_workspace_id_via_join:
      target.subject.kind === "workspace"
        ? (target.subject as { workspaceId: string }).workspaceId
        : null,
    subject_workspace_member_id_via_join:
      target.subject.kind === "workspace_member"
        ? (target.subject as { memberId: string }).memberId
        : null,
    subject_actor_id_via_join:
      target.subject.kind === "actor"
        ? (target.subject as { actorId: string }).actorId
        : null,
    subject_remote_agent_id_via_join:
      target.subject.kind === "remote_agent"
        ? (target.subject as { remoteAgentId: string }).remoteAgentId
        : null,
    subject_conversation_id_via_join:
      target.subject.kind === "conversation"
        ? (target.subject as { conversationId: string }).conversationId
        : null,
    scope_kind: target.scope?.kind ?? null,
    scope_workspace_id_via_join:
      target.scope?.kind === "workspace"
        ? (target.scope as { workspaceId: string }).workspaceId
        : null,
    scope_conversation_id_via_join:
      target.scope?.kind === "conversation"
        ? (target.scope as { conversationId: string }).conversationId
        : null,
  }
}

import { sql } from "kysely"
import { CompiledQuery } from "kysely"
import type { AutomationEventSourceAccessGrant } from "@synapse/shared/types"
import { mapAutomationEventSourceAccessBindingToGrant } from "./bindings.js"

function resourceIdColumnFor(
  resourceType: AutomationEventSourceBindingResourceType
) {
  return "binding.automation_event_source_id"
}

/**
 * List the active access grants on a given resource. Always JOINs
 * access_subjects so the returned grants carry a decoded AutomationEventSourceBindingTarget,
 * not a raw subject_id.
 */
export async function listAutomationEventSourceAccessGrants(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    includeRevoked?: boolean
  }
): Promise<AutomationEventSourceAccessGrant[]> {
  const column = resourceIdColumnFor(input.resourceType)
  let query = db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "binding.scope_subject_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.automation_event_source_id",
      "binding.conversation_type_mask_override",
      "binding.status",
      "binding.source",
      "binding.created_by_workspace_member_id",
      "binding.reason",
      "binding.created_at",
      "binding.revoked_at",
      "binding.scope_subject_id",
      "binding.subject_id",
      sql<string>`${sql.ref(column)}::text`.as("resource_id"),
      "subj.kind as subject_kind",
      sql<string | null>`subj.workspace_id`.as("subject_workspace_id_via_join"),
      sql<string | null>`subj.workspace_member_id`.as(
        "subject_workspace_member_id_via_join"
      ),
      sql<string | null>`subj.actor_id`.as("subject_actor_id_via_join"),
      sql<string | null>`subj.remote_agent_id`.as(
        "subject_remote_agent_id_via_join"
      ),
      sql<string | null>`subj.conversation_id`.as(
        "subject_conversation_id_via_join"
      ),
      sql<string | null>`scope_subj.kind`.as("scope_kind"),
      sql<string | null>`scope_subj.workspace_id`.as(
        "scope_workspace_id_via_join"
      ),
      sql<string | null>`scope_subj.conversation_id`.as(
        "scope_conversation_id_via_join"
      ),
    ] as const)
    .where("binding.resource_type", "=", input.resourceType)
    .where(sql.ref(column), "=", input.resourceId)
  if (!input.includeRevoked) {
    query = query.where("binding.status", "=", "active")
  }
  const rows = await query.execute()
  return rows.map((row) =>
    mapAutomationEventSourceAccessBindingToGrant(row as any)
  )
}

/**
 * Revoke a single binding by id. Idempotent — already-revoked bindings
 * become no-ops. Returns true if a row was updated.
 */
export async function revokeAutomationEventSourceAccessBinding(
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
 * Replace the target of an existing binding with a new subject (and
 * optional scope). Internally upserts the new access_subjects rows and
 * points the binding at them.
 *
 * Post-D4 round 7 review (P3): also rewrites `scope_subject_id`. Earlier
 * this only updated `subject_id`, so moving a grant from
 * (subject=A, scope=C1) to (subject=A, scope=C2) — or scoped → unscoped —
 * silently kept the old scope on the row. Now both columns are written
 * in one statement: the new scope is the optional `scope` on the new
 * target (null when unscoped).
 */
export async function updateAutomationEventSourceAccessBindingTargets(
  db: KyselyDb,
  input: {
    bindingId: string
    newTarget: AutomationEventSourceBindingTarget
  }
): Promise<void> {
  const ref = accessGrantTargetToSubjectRef(input.newTarget)
  const scopeRef = accessGrantTargetScopeRef(input.newTarget)
  const subjectId = await upsertAccessSubject(db, ref)
  const scopeSubjectId = scopeRef
    ? await upsertAccessSubject(db, scopeRef)
    : null
  await db
    .updateTable("resource_access_bindings")
    .set({
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId,
    })
    .where("id", "=", input.bindingId)
    .execute()
}

/**
 * Describe the access grants on a resource as a structured summary.
 */
export async function describeAutomationEventSourceAccessGrants(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
  }
): Promise<{
  grants: AutomationEventSourceAccessGrant[]
  activeCount: number
}> {
  const grants = await listAutomationEventSourceAccessGrants(db, input)
  return { grants, activeCount: grants.length }
}

import { normalizeAutomationEventSourceAccessBindingRow } from "./bindings.js"

function bindingRowSelectFor(
  db: KyselyDb,
  resourceType: AutomationEventSourceBindingResourceType
) {
  const column = resourceIdColumnFor(resourceType)
  return db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "binding.scope_subject_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.automation_event_source_id",
      "binding.subject_id",
      "binding.scope_subject_id",
      sql<string>`${sql.ref(column)}::text`.as("resource_id"),
      sql<string>`subj.kind`.as("subject_kind"),
      sql<string | null>`subj.workspace_id`.as("subject_workspace_id_via_join"),
      sql<string | null>`subj.workspace_member_id`.as(
        "subject_workspace_member_id_via_join"
      ),
      sql<string | null>`subj.remote_agent_id`.as(
        "subject_remote_agent_id_via_join"
      ),
      sql<string | null>`subj.actor_id`.as("subject_actor_id_via_join"),
      sql<string | null>`subj.conversation_id`.as(
        "subject_conversation_id_via_join"
      ),
      sql<string | null>`scope_subj.kind`.as("scope_kind"),
      sql<string | null>`scope_subj.workspace_id`.as(
        "scope_workspace_id_via_join"
      ),
      sql<string | null>`scope_subj.conversation_id`.as(
        "scope_conversation_id_via_join"
      ),
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
 * Load the `AutomationEventSourceBindingRow`-shaped rows for one or more resources of the
 * same type.
 */
export async function loadAutomationEventSourceAccessBindingRowsForSources(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceIds: string[]
    workspaceId?: string
    includeRevoked?: boolean
  }
): Promise<AutomationEventSourceBindingRow[]> {
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
    normalizeAutomationEventSourceAccessBindingRow(
      row as unknown as AutomationEventSourceBindingRow
    )
  )
}

/**
 * Convenience wrapper for the single-resource case.
 */
export async function loadAutomationEventSourceAccessBindingRowsForSource(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    workspaceId?: string
    includeRevoked?: boolean
  }
): Promise<AutomationEventSourceBindingRow[]> {
  return loadAutomationEventSourceAccessBindingRowsForSources(db, {
    resourceType: input.resourceType,
    resourceIds: [input.resourceId],
    workspaceId: input.workspaceId,
    includeRevoked: input.includeRevoked,
  })
}

/**
 * SQL-side variant of `loadAutomationEventSourceAccessBindingRowsForSources` that pre-filters
 * bindings to only those whose target shape matches the given runtime context.
 */
export async function loadAutomationEventSourceAccessBindingRowsForSourcesAndContext(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceIds: string[]
    contextWorkspaceId: string
    actorId?: string | null
    remoteAgentId?: string | null
    conversationId?: string | null
    workspaceMemberId?: string | null
    includeRevoked?: boolean
  }
): Promise<AutomationEventSourceBindingRow[]> {
  if (input.resourceIds.length === 0) return []
  const column = resourceIdColumnFor(input.resourceType)
  let query = bindingRowSelectFor(db, input.resourceType)
    .where("binding.resource_type", "=", input.resourceType)
    .where(sql.ref(column), "in", input.resourceIds)
  if (!input.includeRevoked) {
    query = query.where("binding.status", "=", "active")
  }
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
    if (input.remoteAgentId) {
      conditions.push(
        eb.and([
          eb("subj.kind", "=", "remote_agent"),
          eb("subj.remote_agent_id", "=", input.remoteAgentId),
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
    return eb.or(conditions)
  })
  query = query.where((eb) => {
    const scopeConds = [
      eb("binding.scope_subject_id", "is", null),
      eb.and([
        eb("scope_subj.kind", "=", "workspace"),
        eb("scope_subj.workspace_id", "=", input.contextWorkspaceId),
      ]),
    ]
    if (input.conversationId) {
      scopeConds.push(
        eb.and([
          eb("scope_subj.kind", "=", "conversation"),
          eb("scope_subj.conversation_id", "=", input.conversationId),
        ])
      )
    }
    return eb.or(scopeConds)
  })
  const rows = await query
    .orderBy(sql.ref(column))
    .orderBy("binding.created_at")
    .execute()
  return rows.map((row) =>
    normalizeAutomationEventSourceAccessBindingRow(
      row as unknown as AutomationEventSourceBindingRow
    )
  )
}

/**
 * True iff there is at least one binding (active or otherwise) for the given
 * resource.
 */
export async function hasAnyAutomationEventSourceAccessBindingOn(
  client: Executor,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    activeOnly?: boolean
  }
): Promise<boolean> {
  const column = resourceIdColumnForRaw(input.resourceType)
  let builder = defaultDb
    .selectFrom("resource_access_bindings")
    .select(sql`1`.as("one"))
    .where(sql.ref(column), "=", input.resourceId)
  if (input.activeOnly) {
    builder = builder.where("status", "=", "active")
  }
  const result = await runBuilder(client, builder.limit(1))
  return result.rows.length > 0
}

function resourceIdColumnForRaw(
  resourceType: AutomationEventSourceBindingResourceType
) {
  return "automation_event_source_id"
}

/**
 * Find an active binding by (resource, subject, scope?).
 *
 * Post-D4 round 7 review (P2): `scope_subject_id` is part of the binding's
 * identity. Two grants (subject=actor A, scope=conversation C1) and
 * (subject=actor A, scope=conversation C2) are distinct rows — collapsing
 * them by subject_id alone meant a caller upserting the C2 grant would
 * dedupe onto the C1 row (writing C2 inputs over the C1 binding's
 * fingerprint) and lookups would return the wrong binding. The optional
 * `scopeSubjectId` (null for unscoped) is matched with `IS NOT DISTINCT
 * FROM` so NULL-vs-NULL and UUID-equality both work correctly.
 */
export async function findActiveAutomationEventSourceAccessBindingIdBySubject(
  client: Executor,
  input: {
    workspaceId: string
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
    subjectId: string
    scopeSubjectId?: string | null
  }
): Promise<string | null> {
  const column = resourceIdColumnForRaw(input.resourceType)
  const result = await runBuilder<{ id: string }>(
    client,
    defaultDb
      .selectFrom("resource_access_bindings")
      .select("id")
      .where("workspace_id", "=", input.workspaceId)
      .where(sql.ref(column), "=", input.resourceId)
      .where("subject_id", "=", input.subjectId)
      .where(
        sql`scope_subject_id IS NOT DISTINCT FROM ${
          input.scopeSubjectId ?? null
        }::uuid` as unknown as never
      )
      .where("status", "=", "active")
      .orderBy("created_at", "desc")
      .limit(1)
  )
  return result.rows[0]?.id ?? null
}

/**
 * Update only the `conversation_type_mask_override` column on a binding.
 */
export async function updateAutomationEventSourceAccessGrantConversationTypeMaskOverride(
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
 * Bulk revoke variant of `revokeAutomationEventSourceAccessBinding`.
 */
export async function revokeAutomationEventSourceAccessBindingsByIdsOn(
  client: Executor,
  bindingIds: string[]
): Promise<void> {
  if (bindingIds.length === 0) return
  await runBuilder(
    client,
    defaultDb
      .updateTable("resource_access_bindings")
      .set({ status: "revoked", revoked_at: sql`NOW()` })
      .where("id", "in", bindingIds)
      .where("status", "=", "active")
  )
}

/**
 * Revoke every binding pointing at a resource (soft-delete world: design §7.4).
 * Was a hard DELETE; resource_access_bindings is a status-flip junction, and
 * naked DELETE is forbidden by sd_reject_delete. Callers that "remove a
 * resource's bindings" (plugin/skill uninstall) get the same observable effect —
 * the bindings are no longer active — while history is preserved.
 */
export async function revokeAutomationEventSourceAccessBindingsForSourceOn(
  client: Executor,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
  }
): Promise<void> {
  const column = resourceIdColumnForRaw(input.resourceType)
  await runBuilder(
    client,
    defaultDb
      .updateTable("resource_access_bindings")
      .set({ status: "revoked", revoked_at: sql`NOW()` })
      .where(sql.ref(column), "=", input.resourceId)
      .where("status", "=", "active")
  )
}

/**
 * Revoke bindings for a resource — Kysely flavour (see above; was hard delete).
 */
export async function revokeAutomationEventSourceAccessBindingsForSource(
  db: KyselyDb,
  input: {
    resourceType: AutomationEventSourceBindingResourceType
    resourceId: string
  }
): Promise<void> {
  const column = resourceIdColumnForRaw(input.resourceType)
  await db
    .updateTable("resource_access_bindings")
    .set({ status: "revoked", revoked_at: sql`NOW()` })
    .where(sql.ref(column), "=", input.resourceId)
    .where("status", "=", "active")
    .execute()
}

/**
 * Read a single binding row by id (and optionally workspace).
 */
export async function getAutomationEventSourceAccessBindingRowById(
  db: KyselyDb,
  input: {
    bindingId: string
    workspaceId?: string
    resourceType?: AutomationEventSourceBindingResourceType
    resourceId?: string
  }
): Promise<AutomationEventSourceBindingRow | null> {
  const resourceType = input.resourceType ?? "automation_event_source"
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
  return normalizeAutomationEventSourceAccessBindingRow(
    row as unknown as AutomationEventSourceBindingRow
  )
}

/**
 * Return the distinct resource ids in a workspace whose active bindings
 * match a subject-side filter.
 *
 * Post-D4 round 7 review (P2): `scopeSubjectId` filters by the exact
 * scope (NULL = unscoped). Without this filter, asking "which skills
 * has actor A in conversation C1 been bound to?" returned bindings for
 * actor A in any scope — including C2 or unscoped — silently widening
 * the listing. `IS NOT DISTINCT FROM` handles the NULL=NULL case.
 */
export async function listAutomationEventSourceIdsByBindingFilter(
  db: KyselyDb,
  input: {
    workspaceId: string
    resourceType: AutomationEventSourceBindingResourceType
    subjectId?: string | null
    /**
     * Pass to filter by the scope_subject_id column too:
     *   - omitted (undefined) → no scope filter, behaves as before
     *   - null                → match unscoped bindings only
     *   - UUID                → match bindings with this exact scope
     */
    scopeSubjectId?: string | null
    actorId?: string | null
    conversationId?: string | null
    // Round 13 review (P2): without these, callers that pass
    // workspaceMemberId / remoteAgentId without an accompanying
    // subjectId fell through to "no subject filter" and the helper
    // returned every active binding in the workspace. Filter on the
    // matching access_subjects column when subjectId isn't provided.
    workspaceMemberId?: string | null
    remoteAgentId?: string | null
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
      conditions.push(`subj.actor_id = $${values.length}::uuid`)
    }
    if (input.conversationId) {
      values.push(input.conversationId)
      conditions.push(`subj.conversation_id = $${values.length}::uuid`)
    }
    if (input.workspaceMemberId) {
      values.push(input.workspaceMemberId)
      conditions.push(`subj.workspace_member_id = $${values.length}::uuid`)
    }
    if (input.remoteAgentId) {
      values.push(input.remoteAgentId)
      conditions.push(`subj.remote_agent_id = $${values.length}::uuid`)
    }
  }
  if (input.scopeSubjectId !== undefined) {
    values.push(input.scopeSubjectId)
    conditions.push(
      `binding.scope_subject_id IS NOT DISTINCT FROM $${values.length}::uuid`
    )
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
