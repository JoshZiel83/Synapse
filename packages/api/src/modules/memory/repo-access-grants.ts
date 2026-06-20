/**
 * `memory_access_grants` CRUD storage layer (PR5 of the subject + memory
 * refactor). The table itself was introduced in PR1 with its trigger; this
 * module wraps it in the same Kysely + SubjectRef vocabulary the rest of the
 * access layer uses, so callers don't have to think about access_subjects
 * upserts or the per-row workspace consistency rules (the trigger handles
 * those, but failing fast at the writer is friendlier).
 *
 * Grants are append-only: revocation flips status='revoked' + revoked_at
 * (soft delete) so audit trails survive a grant being withdrawn. Reuse the
 * same (memory_space_id, COALESCE(memory_item_id::text,''), subject_id,
 * COALESCE(scope_subject_id::text,'')) active uniqueness as the schema.
 */

import { sql } from "kysely"
import {
  MEMORY_ACCESS_GRANT_STATUS,
  isScopeEligibleSubject,
  type MemoryAccessGrantStatus,
  type MemoryPermission,
  type SubjectRef,
} from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"

export type MemoryAccessGrantRow = {
  id: string
  workspaceId: string
  memorySpaceId: string
  memoryItemId: string | null
  subjectId: string
  scopeSubjectId: string | null
  permissions: MemoryPermission[]
  status: MemoryAccessGrantStatus
  source: string | null
  createdByWorkspaceMemberId: string | null
  sourceTaskId: string | null
  revokedAt: Date | null
  supersededAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type InsertMemoryAccessGrantInput = {
  workspaceId: string
  memorySpaceId: string
  /** When non-null, the grant applies to a single memory_item; otherwise space-level. */
  memoryItemId?: string | null
  subject: SubjectRef
  /** workspace | conversation only; trigger enforces. */
  scope?: SubjectRef
  permissions: readonly MemoryPermission[]
  source?: string | null
  createdByWorkspaceMemberId?: string | null
  sourceTaskId?: string | null
}

export async function insertMemoryAccessGrant(
  db: KyselyDb,
  input: InsertMemoryAccessGrantInput
): Promise<MemoryAccessGrantRow> {
  if (input.permissions.length === 0) {
    throw new Error("memory_access_grants.permissions must be non-empty")
  }
  if (input.scope && !isScopeEligibleSubject(input.scope)) {
    throw new Error(
      `memory_access_grants.scope_subject_id must be workspace | conversation, got ${input.scope.kind}`
    )
  }
  const subjectId = await upsertAccessSubject(db, input.subject)
  const scopeSubjectId = input.scope
    ? await upsertAccessSubject(db, input.scope)
    : null

  const result = await db
    .insertInto("memoryAccessGrants")
    .values({
      workspaceId: input.workspaceId,
      memorySpaceId: input.memorySpaceId,
      memoryItemId: input.memoryItemId ?? null,
      subjectId: subjectId,
      scopeSubjectId: scopeSubjectId,
      permissions: input.permissions as any,
      status: MEMORY_ACCESS_GRANT_STATUS.ACTIVE,
      source: input.source ?? null,
      createdByWorkspaceMemberId: input.createdByWorkspaceMemberId ?? null,
      sourceTaskId: input.sourceTaskId ?? null,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow()
  return result
}

/**
 * Soft-revoke a grant. Idempotent — already-revoked rows return false.
 */
export async function revokeMemoryAccessGrant(
  db: KyselyDb,
  grantId: string
): Promise<boolean> {
  const updated = await db
    .updateTable("memoryAccessGrants")
    .set({
      status: MEMORY_ACCESS_GRANT_STATUS.REVOKED,
      revokedAt: sql`NOW()`,
    } as any)
    .where("id", "=", grantId)
    .where("status", "=", MEMORY_ACCESS_GRANT_STATUS.ACTIVE)
    .returning("id")
    .execute()
  return updated.length > 0
}

export async function listActiveMemoryAccessGrants(
  db: KyselyDb,
  memorySpaceId: string
): Promise<MemoryAccessGrantRow[]> {
  const rows = await db
    .selectFrom("memoryAccessGrants")
    .selectAll()
    .where("memorySpaceId", "=", memorySpaceId)
    .where("status", "=", MEMORY_ACCESS_GRANT_STATUS.ACTIVE)
    .orderBy("createdAt", "desc")
    .execute()
  return rows
}

/**
 * PR5 evaluator hot-path query: does any active memory_access_grants row on
 * `memorySpaceId` (or on the specific `memoryItemId`, if non-null) grant
 * `permission` to a subject in `runtimeSubjectIds`, with a scope that is
 * either NULL or in `runtimeScopeSubjectIds`?
 *
 * This matches the SQL template the plan locked in:
 *   subject_id ∈ runtime AND
 *   (scope_subject_id IS NULL OR scope_subject_id ∈ runtimeScopeSubjectIds) AND
 *   permission ∈ permissions
 */
export async function memoryGrantMatches(
  db: KyselyDb,
  params: {
    memorySpaceId: string
    memoryItemId?: string | null
    permission: MemoryPermission
    runtimeSubjectIds: readonly string[]
    runtimeScopeSubjectIds: readonly string[]
    /** When `space-only`, only matches grants whose memory_item_id IS NULL.
     *  When `with-item`, matches both space-level and item-level grants for
     *  the given memory_item_id. */
    mode: "space-only" | "with-item"
  }
): Promise<boolean> {
  if (params.runtimeSubjectIds.length === 0) return false
  let query = db
    .selectFrom("memoryAccessGrants")
    .select(["id"])
    .where("memorySpaceId", "=", params.memorySpaceId)
    .where("status", "=", MEMORY_ACCESS_GRANT_STATUS.ACTIVE)
    .where("subjectId", "in", [...params.runtimeSubjectIds])
    .where(
      sql<boolean>`${params.permission}::memory_permission = ANY(permissions)`
    )
    .limit(1)

  if (params.runtimeScopeSubjectIds.length > 0) {
    const scopes = [...params.runtimeScopeSubjectIds]
    query = query.where((eb) =>
      eb.or([
        eb("scopeSubjectId", "is", null),
        eb("scopeSubjectId", "in", scopes),
      ])
    )
  } else {
    query = query.where("scopeSubjectId", "is", null)
  }

  if (params.mode === "space-only") {
    query = query.where("memoryItemId", "is", null)
  } else if (params.memoryItemId == null) {
    // with-item: either a space-level grant OR an item-level grant for the
    // specific memory_item_id.
    query = query.where("memoryItemId", "is", null)
  } else {
    const itemId = params.memoryItemId
    query = query.where((eb) =>
      eb.or([eb("memoryItemId", "is", null), eb("memoryItemId", "=", itemId)])
    )
  }

  const row = await query.executeTakeFirst()
  return Boolean(row)
}

/**
 * PR-fix-round-2: enumerate the memory_space ids the principal can reach
 * via active **space-level** grants (memory_item_id IS NULL). This is the
 * only grant shape that legitimately widens list/search/recall candidate
 * sets — item-level grants must NOT participate in candidate widening
 * because that would let an item-level read grant on item X surface every
 * item in X's space.
 *
 * Item-level grants are still honored by `memoryGrantMatches(mode:
 * "with-item")` for the single-item evaluator path.
 */
export async function listSpaceLevelGrantSpaceIds(
  db: KyselyDb,
  params: {
    workspaceId: string
    permission: MemoryPermission
    runtimeSubjectIds: readonly string[]
    runtimeScopeSubjectIds: readonly string[]
  }
): Promise<string[]> {
  if (params.runtimeSubjectIds.length === 0) return []
  let query = db
    .selectFrom("memoryAccessGrants as g")
    .select(["g.memorySpaceId"])
    .distinct()
    .where("g.workspaceId", "=", params.workspaceId)
    .where("g.status", "=", MEMORY_ACCESS_GRANT_STATUS.ACTIVE)
    .where("g.subjectId", "in", [...params.runtimeSubjectIds])
    .where("g.memoryItemId", "is", null) // space-level only
    .where(
      sql<boolean>`${params.permission}::memory_permission = ANY(g.permissions)`
    )

  if (params.runtimeScopeSubjectIds.length > 0) {
    const scopes = [...params.runtimeScopeSubjectIds]
    query = query.where((eb) =>
      eb.or([
        eb("g.scopeSubjectId", "is", null),
        eb("g.scopeSubjectId", "in", scopes),
      ])
    )
  } else {
    query = query.where("g.scopeSubjectId", "is", null)
  }

  const rows = await query.execute()
  return rows.map((row) => row.memorySpaceId)
}
