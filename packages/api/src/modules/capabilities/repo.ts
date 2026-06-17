// capabilities/repo.ts — DB-touching helpers for the capabilities module.
//
// The only capabilities file permitted to import the db client (guard r8). Owns
// the workspace-capability-conversation-type-policy reads/writes (raw SQL over
// the policy table joined to access_subjects) and the workspace-member id
// lookup the surface resolver needs. Presentation/normalization stays in
// conversation-type-policies.ts. round-6 P1-6.

import { sql } from "kysely"
import {
  SUBJECT_KIND,
  DEFAULT_CONVERSATION_TYPE_MASK,
  type SubjectRef,
} from "@synapse/shared"
import type { CapabilityConversationTypePolicyResourceFamily } from "@synapse/shared/types"
import { db, type Executor } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { upsertAccessSubjectDefault } from "../access/guards.js"

// camelCase row shape: CamelCasePlugin.transformResult runs unconditionally on
// raw `sql` results too, so the SELECT aliases the snake_case columns to
// double-quoted camelCase identifiers and the consumers read camelCase keys.
export type WorkspaceCapabilityConversationTypePolicyRow = {
  workspaceId: string
  resourceFamily: CapabilityConversationTypePolicyResourceFamily
  defaultConversationTypeMask: number
}

/** All policy rows for one workspace (ordered by resource_family). */
export async function selectWorkspacePolicyRows(
  workspaceId: string
): Promise<WorkspaceCapabilityConversationTypePolicyRow[]> {
  const result = await sql<WorkspaceCapabilityConversationTypePolicyRow>`
    SELECT
      subj.workspace_id AS "workspaceId",
      policy.resource_family AS "resourceFamily",
      policy.default_conversation_type_mask AS "defaultConversationTypeMask"
    FROM workspace_capability_conversation_type_policies policy
    INNER JOIN access_subjects subj ON subj.id = policy.subject_id
    WHERE subj.workspace_id = ${workspaceId}
      AND subj.kind = 'workspace'
    ORDER BY policy.resource_family ASC`.execute(db)
  return result.rows
}

/** Policy rows across many workspaces (for the bulk map). */
export async function selectWorkspacePolicyRowsForIds(
  workspaceIds: string[]
): Promise<WorkspaceCapabilityConversationTypePolicyRow[]> {
  const result = await sql<WorkspaceCapabilityConversationTypePolicyRow>`
    SELECT
      subj.workspace_id AS "workspaceId",
      policy.resource_family AS "resourceFamily",
      policy.default_conversation_type_mask AS "defaultConversationTypeMask"
    FROM workspace_capability_conversation_type_policies policy
    INNER JOIN access_subjects subj ON subj.id = policy.subject_id
    WHERE subj.workspace_id = ANY(${workspaceIds}::uuid[])
      AND subj.kind = 'workspace'`.execute(db)
  return result.rows
}

/** Seed (ON CONFLICT DO NOTHING) one resource-family default for a subject. */
export async function insertWorkspacePolicyDefault(
  run: Executor,
  subjectId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily
): Promise<void> {
  await sql`
    INSERT INTO workspace_capability_conversation_type_policies (
      subject_id, resource_family, default_conversation_type_mask
    )
    VALUES (${subjectId}, ${resourceFamily}, ${DEFAULT_CONVERSATION_TYPE_MASK})
    ON CONFLICT (subject_id, resource_family) DO NOTHING`.execute(run)
}

/** Resolve the workspace subject id during seeding (uses the passed executor). */
export async function upsertWorkspaceSubjectId(
  run: Executor,
  workspaceId: string
): Promise<string> {
  const ref: SubjectRef = { kind: SUBJECT_KIND.WORKSPACE, workspaceId }
  return upsertAccessSubject(run, ref)
}

/** Upsert (ON CONFLICT DO UPDATE) one resource-family mask on the default db. */
export async function upsertWorkspacePolicy(
  workspaceId: string,
  resourceFamily: CapabilityConversationTypePolicyResourceFamily,
  mask: number
): Promise<void> {
  const subjectId = await upsertAccessSubjectDefault({
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId,
  })
  await sql`
    INSERT INTO workspace_capability_conversation_type_policies (
      subject_id, resource_family, default_conversation_type_mask
    )
    VALUES (${subjectId}, ${resourceFamily}, ${mask})
    ON CONFLICT (subject_id, resource_family) DO UPDATE
      SET default_conversation_type_mask = EXCLUDED.default_conversation_type_mask`.execute(
    db
  )
}

/** The active workspace-member id for a (workspace, user), if any. */
export async function selectWorkspaceMemberId(
  workspaceId: string,
  userId: string
): Promise<string | null> {
  const member = await db
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("userId", "=", userId)
    .limit(1)
    .executeTakeFirst()
  return member?.id ?? null
}
