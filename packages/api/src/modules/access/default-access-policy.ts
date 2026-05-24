/**
 * P2: "default-open" access policy is now expressed via the existence of a
 * workspace-scoped binding (source=default_open) on the actor/remote_agent.
 * The historical `actors.access_policy` / `remote_agents.access_policy`
 * columns have been dropped; this module is the single point where the
 * derived intent is read/written.
 *
 * Both Kysely-style (`*` taking `KyselyDb`) and `pg.PoolClient`-style
 * (`*On` taking a `QueryExecutor`) helpers are exposed so callers in either
 * transaction style can keep all writes atomic with the binding insert.
 */

import { SUBJECT_KIND } from "@synapse/shared"
import type {
  KyselyDb,
  QueryExecutor,
} from "../../infrastructure/database/kysely.js"
import { executeSqlOn } from "../../infrastructure/database/kysely.js"
import {
  buildResourceAccessBindingInsertValues,
  buildResourceAccessBindingInsertValuesOn,
} from "./binding-storage.js"
import { upsertAccessSubject } from "./subject-registry.js"

export type AccessPolicyValue = "workspace_open" | "approval_required"

const DEFAULT_OPEN_REASON =
  "default workspace-open binding written by access lifecycle"

async function hasWorkspaceDefaultOpenBinding(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  const idColumn = resourceType === "actor" ? "actor_id" : "remote_agent_id"
  const row = await db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .select("binding.id")
    .where("binding.resource_type", "=", resourceType)
    .where(`binding.${idColumn}` as any, "=", resourceId)
    .where("binding.source", "=", "default_open")
    .where("subj.kind", "=", "workspace")
    .where("subj.workspace_id", "=", workspaceId)
    .where("binding.status", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

async function hasWorkspaceDefaultOpenBindingOn(
  client: QueryExecutor,
  resourceType: "actor" | "remote_agent",
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  const idColumn = resourceType === "actor" ? "actor_id" : "remote_agent_id"
  const result = await executeSqlOn<{ id: string }>(
    client,
    `SELECT binding.id
     FROM resource_access_bindings binding
     INNER JOIN access_subjects subj ON subj.id = binding.subject_id
     WHERE binding.resource_type = $1
       AND binding.${idColumn} = $2::uuid
       AND binding.source = 'default_open'
       AND subj.kind = 'workspace'
       AND subj.workspace_id = $3::uuid
       AND binding.status = 'active'
     LIMIT 1`,
    [resourceType, resourceId, workspaceId]
  )
  return result.rows.length > 0
}

export async function deriveAccessPolicy(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  resourceId: string,
  workspaceId: string
): Promise<AccessPolicyValue> {
  return (await hasWorkspaceDefaultOpenBinding(
    db,
    resourceType,
    resourceId,
    workspaceId
  ))
    ? "workspace_open"
    : "approval_required"
}

export async function deriveAccessPolicyMany(
  db: KyselyDb,
  resourceType: "actor" | "remote_agent",
  workspaceId: string,
  resourceIds: readonly string[]
): Promise<Map<string, AccessPolicyValue>> {
  const out = new Map<string, AccessPolicyValue>()
  if (resourceIds.length === 0) return out
  for (const id of resourceIds) {
    out.set(id, "approval_required")
  }
  const idColumn = resourceType === "actor" ? "actor_id" : "remote_agent_id"
  const rows = await db
    .selectFrom("resource_access_bindings as binding")
    .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
    .select([`binding.${idColumn} as resource_id` as any])
    .where("binding.resource_type", "=", resourceType)
    .where(`binding.${idColumn}` as any, "in", [...resourceIds])
    .where("binding.source", "=", "default_open")
    .where("subj.kind", "=", "workspace")
    .where("subj.workspace_id", "=", workspaceId)
    .where("binding.status", "=", "active")
    .execute()
  for (const row of rows as Array<{ resource_id: string | null }>) {
    if (row.resource_id) {
      out.set(row.resource_id, "workspace_open")
    }
  }
  return out
}

/**
 * Idempotently align the default-open binding to the desired policy. Call this
 * on actor/remote_agent creation and on policy update.
 */
export async function setAccessPolicy(
  db: KyselyDb,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    policy: AccessPolicyValue
    createdByWorkspaceMemberId?: string | null
  }
): Promise<void> {
  if (params.policy === "workspace_open") {
    const existing = await hasWorkspaceDefaultOpenBinding(
      db,
      params.resourceType,
      params.resourceId,
      params.workspaceId
    )
    if (existing) return
    const values = await buildResourceAccessBindingInsertValues(db, {
      workspaceId: params.workspaceId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      target: workspaceTarget(params.workspaceId),
      source: "default_open",
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: DEFAULT_OPEN_REASON,
    })
    await db
      .insertInto("resource_access_bindings")
      .values(values)
      .onConflict((oc) => oc.doNothing())
      .execute()
    return
  }

  const idColumn =
    params.resourceType === "actor" ? "actor_id" : "remote_agent_id"
  await db
    .updateTable("resource_access_bindings")
    .set({ status: "revoked", revoked_at: new Date() })
    .where("resource_type", "=", params.resourceType)
    .where(idColumn as any, "=", params.resourceId)
    .where("source", "=", "default_open")
    .where("status", "=", "active")
    .execute()
}

/**
 * `pg.PoolClient`-compatible variant of `setAccessPolicy`. Use this from inside
 * `transaction(async client => ...)` blocks (e.g. actor creation) so the
 * binding upsert commits atomically with the actor INSERT on the same trx.
 */
export async function setAccessPolicyOn(
  client: QueryExecutor,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    policy: AccessPolicyValue
    createdByWorkspaceMemberId?: string | null
  }
): Promise<void> {
  if (params.policy === "workspace_open") {
    const existing = await hasWorkspaceDefaultOpenBindingOn(
      client,
      params.resourceType,
      params.resourceId,
      params.workspaceId
    )
    if (existing) return
    const values = await buildResourceAccessBindingInsertValuesOn(client, {
      workspaceId: params.workspaceId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      target: workspaceTarget(params.workspaceId),
      source: "default_open",
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: DEFAULT_OPEN_REASON,
    })
    await executeSqlOn(
      client,
      `INSERT INTO resource_access_bindings (
         workspace_id, resource_type, installed_skill_id, plugin_installation_id,
         relay_capability_id, automation_event_source_id, actor_id, remote_agent_id,
         subject_id, conversation_type_mask_override, status, source,
         created_by_workspace_member_id, reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT DO NOTHING`,
      [
        values.workspace_id,
        values.resource_type,
        values.installed_skill_id,
        values.plugin_installation_id,
        values.relay_capability_id,
        values.automation_event_source_id,
        values.actor_id,
        values.remote_agent_id,
        values.subject_id,
        values.conversation_type_mask_override,
        values.status,
        values.source,
        values.created_by_workspace_member_id,
        values.reason,
      ]
    )
    return
  }

  const idColumn =
    params.resourceType === "actor" ? "actor_id" : "remote_agent_id"
  await executeSqlOn(
    client,
    `UPDATE resource_access_bindings
     SET status = 'revoked', revoked_at = NOW()
     WHERE resource_type = $1
       AND ${idColumn} = $2::uuid
       AND source = 'default_open'
       AND status = 'active'`,
    [params.resourceType, params.resourceId]
  )
}

/**
 * Approval flow: when an entity_access_requests row (target subject = actor or
 * remote_agent) is approved, write a workspace-member-scoped binding granting
 * that specific member access to the actor/remote_agent. This does NOT grant
 * everyone in the workspace access — only the approved member.
 */
export async function grantApprovedAccess(
  db: KyselyDb,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    grantedToMemberId: string
    grantedByWorkspaceMemberId?: string | null
    reason?: string | null
  }
): Promise<string> {
  const values = await buildResourceAccessBindingInsertValues(db, {
    workspaceId: params.workspaceId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    target: workspaceMemberTarget(params.grantedToMemberId),
    source: "approval",
    createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
    reason:
      params.reason ?? `Approved access for member ${params.grantedToMemberId}`,
  })
  const inserted = await db
    .insertInto("resource_access_bindings")
    .values(values)
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst()
  if (inserted) return inserted.id

  const idColumn =
    params.resourceType === "actor" ? "actor_id" : "remote_agent_id"
  // Re-read the existing approval row (any source) for this member subject.
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId: params.grantedToMemberId,
  })
  const existing = await db
    .selectFrom("resource_access_bindings")
    .select("id")
    .where("resource_type", "=", params.resourceType)
    .where(idColumn as any, "=", params.resourceId)
    .where("source", "=", "approval")
    .where("status", "=", "active")
    .where("subject_id", "=", subjectId)
    .executeTakeFirstOrThrow()
  return existing.id
}

/**
 * `pg.PoolClient`-compatible variant of `grantApprovedAccess`.
 */
export async function grantApprovedAccessOn(
  client: QueryExecutor,
  params: {
    resourceType: "actor" | "remote_agent"
    resourceId: string
    workspaceId: string
    grantedToMemberId: string
    grantedByWorkspaceMemberId?: string | null
    reason?: string | null
  }
): Promise<string> {
  const values = await buildResourceAccessBindingInsertValuesOn(client, {
    workspaceId: params.workspaceId,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    target: workspaceMemberTarget(params.grantedToMemberId),
    source: "approval",
    createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
    reason:
      params.reason ?? `Approved access for member ${params.grantedToMemberId}`,
  })
  const inserted = await executeSqlOn<{ id: string }>(
    client,
    `INSERT INTO resource_access_bindings (
       workspace_id, resource_type, installed_skill_id, plugin_installation_id,
       relay_capability_id, automation_event_source_id, actor_id, remote_agent_id,
       subject_id, conversation_type_mask_override, status, source,
       created_by_workspace_member_id, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      values.workspace_id,
      values.resource_type,
      values.installed_skill_id,
      values.plugin_installation_id,
      values.relay_capability_id,
      values.automation_event_source_id,
      values.actor_id,
      values.remote_agent_id,
      values.subject_id,
      values.conversation_type_mask_override,
      values.status,
      values.source,
      values.created_by_workspace_member_id,
      values.reason,
    ]
  )
  if (inserted.rows[0]) return inserted.rows[0].id

  const idColumn =
    params.resourceType === "actor" ? "actor_id" : "remote_agent_id"
  const existing = await executeSqlOn<{ id: string }>(
    client,
    `SELECT id FROM resource_access_bindings
     WHERE resource_type = $1
       AND ${idColumn} = $2::uuid
       AND source = 'approval'
       AND status = 'active'
       AND subject_id = $3::uuid
     LIMIT 1`,
    [params.resourceType, params.resourceId, values.subject_id]
  )
  if (!existing.rows[0]) {
    throw new Error("Failed to upsert approval binding")
  }
  return existing.rows[0].id
}

function workspaceTarget(workspaceId: string) {
  return {
    targetType: "workspace" as const,
    subjectWorkspaceId: workspaceId,
    subjectWorkspaceMemberId: null,
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
}

function workspaceMemberTarget(memberId: string) {
  return {
    targetType: "workspace_member" as const,
    subjectWorkspaceId: null,
    subjectWorkspaceMemberId: memberId,
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
}
