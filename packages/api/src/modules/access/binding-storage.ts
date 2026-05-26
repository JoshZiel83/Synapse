import {
  executeTakeFirst,
  db as defaultDb,
} from "../../infrastructure/database/kysely.js"
import type {
  KyselyDb,
  QueryExecutor,
  TableInsert,
} from "../../infrastructure/database/kysely.js"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "./subject-registry.js"
import type {
  AccessBindableResourceType,
  AccessGrantTarget,
} from "./bindings.js"
import {
  accessGrantTargetScopeRef,
  accessGrantTargetToSubjectRef,
} from "./bindings.js"

export type AccessBindingSource =
  | "manual"
  | "default_open"
  | "relay_auto"
  | "approval"
  | "system"

/**
 * D3: build the insert values for resource_access_bindings. `subject_id` is
 * the canonical reference; `scope_subject_id` is set when the target is
 * scoped (e.g. actor + scope=conversation).
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
  const ref = accessGrantTargetToSubjectRef(input.target)
  const subjectId = await upsertAccessSubject(db, ref)
  const scopeRef = accessGrantTargetScopeRef(input.target)
  const scopeSubjectId = scopeRef
    ? await upsertAccessSubject(db, scopeRef)
    : null
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    relay_capability_id:
      input.resourceType === "relay_capability" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
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
 * `pg.PoolClient`-compatible variant of `buildResourceAccessBindingInsertValues`.
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
  const ref = accessGrantTargetToSubjectRef(input.target)
  const subjectId = await upsertAccessSubjectOn(client, ref)
  const scopeRef = accessGrantTargetScopeRef(input.target)
  const scopeSubjectId = scopeRef
    ? await upsertAccessSubjectOn(client, scopeRef)
    : null
  return {
    workspace_id: input.workspaceId,
    resource_type: input.resourceType,
    installed_skill_id:
      input.resourceType === "installed_skill" ? input.resourceId : null,
    plugin_installation_id:
      input.resourceType === "plugin_installation" ? input.resourceId : null,
    relay_capability_id:
      input.resourceType === "relay_capability" ? input.resourceId : null,
    automation_event_source_id:
      input.resourceType === "automation_event_source"
        ? input.resourceId
        : null,
    actor_id: input.resourceType === "actor" ? input.resourceId : null,
    remote_agent_id:
      input.resourceType === "remote_agent" ? input.resourceId : null,
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

import type { AccessBindingRow } from "./bindings.js"

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
 * D3: after an INSERT ... RETURNING * the returned row only has `subject_id`
 * and `scope_subject_id`. Augment the row with subject/scope projection
 * fields synthesized from the AccessGrantTarget so downstream readers
 * (`mapAccessBindingToGrant` / `normalizeAccessBindingRow`) decode the
 * subject without a second lookup.
 */
export function augmentInsertedBindingRowWithTarget<
  T extends { subject_id: string | null; scope_subject_id?: string | null },
>(
  inserted: T,
  target: AccessGrantTarget
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
import type { AccessGrant } from "@synapse/shared/types"
import { mapAccessBindingToGrant } from "./bindings.js"

function resourceIdColumnFor(resourceType: AccessBindableResourceType) {
  switch (resourceType) {
    case "installed_skill":
      return "binding.installed_skill_id"
    case "plugin_installation":
      return "binding.plugin_installation_id"
    case "relay_capability":
      return "binding.relay_capability_id"
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
 * not a raw subject_id.
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
      "access_subjects as scope_subj",
      "scope_subj.id",
      "binding.scope_subject_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.installed_skill_id",
      "binding.plugin_installation_id",
      "binding.relay_capability_id",
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
  return rows.map((row) => mapAccessBindingToGrant(row as any))
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
  const ref = accessGrantTargetToSubjectRef(input.newTarget)
  const subjectId = await upsertAccessSubject(db, ref)
  await db
    .updateTable("resource_access_bindings")
    .set({ subject_id: subjectId })
    .where("id", "=", input.bindingId)
    .execute()
}

/**
 * Describe the access grants on a resource as a structured summary.
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
      "access_subjects as scope_subj",
      "scope_subj.id",
      "binding.scope_subject_id"
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.installed_skill_id",
      "binding.plugin_installation_id",
      "binding.relay_capability_id",
      "binding.automation_event_source_id",
      "binding.actor_id",
      "binding.remote_agent_id",
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
 * Load the `AccessBindingRow`-shaped rows for one or more resources of the
 * same type.
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
 * Convenience wrapper for the single-resource case.
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
    normalizeAccessBindingRow(row as unknown as AccessBindingRow)
  )
}

/**
 * True iff there is at least one binding (active or otherwise) for the given
 * resource.
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
    case "relay_capability":
      return "relay_capability_id"
    case "automation_event_source":
      return "automation_event_source_id"
    case "actor":
      return "actor_id"
    case "remote_agent":
      return "remote_agent_id"
  }
}

/**
 * Find an active binding by (resource, subject).
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
 * Update only the `conversation_type_mask_override` column on a binding.
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
 * Bulk revoke variant of `revokeGrant`.
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
 * Hard-delete every binding pointing at a resource.
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
 * Hard-delete bindings for a resource — Kysely flavour.
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
 * Read a single binding row by id (and optionally workspace).
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
 * match a subject-side filter.
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
      conditions.push(`subj.actor_id = $${values.length}::uuid`)
    }
    if (input.conversationId) {
      values.push(input.conversationId)
      conditions.push(`subj.conversation_id = $${values.length}::uuid`)
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
