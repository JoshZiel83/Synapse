// File-space + file-mount + snapshot repo layer for the sandbox manager.
//
// Mirrors memory_spaces / resolveOrCreateMemorySpace: a file_space is keyed by
// (workspace_id, owner_subject_id, scope_subject_id?, namespace_key) and is
// the application-level scope for a content-addressed working tree. The
// snapshot DAG (file_snapshots) replaces the helper's history.sqlite as the
// authoritative history; file_mounts records a (session × space) materialization.
//
// This module is pure DB plumbing — no process spawning, no fs-helper. The
// service layer (service.ts) composes these with the one-shot fs-helper driver
// and device pairing to actually provision a sandbox.

import { v4 as uuidv4 } from "uuid"
import { sql } from "kysely"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import { type Executor } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"

export class SandboxSpaceError extends Error {
  constructor(
    message: string,
    public status = 500
  ) {
    super(message)
    this.name = "SandboxSpaceError"
  }
}

const DEFAULT_NAMESPACE = "default"

// The three mount subpaths a sandbox exposes (CHECK-constrained in schema).
export type MountSubpath = "conversation" | "actor" | "actor-conversation"
export const MOUNT_SUBPATHS: readonly MountSubpath[] = [
  "conversation",
  "actor",
  "actor-conversation",
]

// NOTE: these row shapes describe what the Kysely executor RETURNS at runtime.
// The CamelCasePlugin (maintainNestedObjectKeys: true) camelCases the top-level
// keys of every result row — including raw sql`...`.execute() — so the physical
// snake_case columns surface here as camelCase. The SQL bodies below keep the
// snake_case column names (that's the physical schema); only the read keys are
// camelCase.
export interface FileSpaceRow {
  id: string
  workspaceId: string
  ownerSubjectId: string
  scopeSubjectId: string | null
  namespaceKey: string
  currentSnapshotId: string | null
}

export interface FileMountRow {
  id: string
  workspaceId: string
  sessionId: string
  fileSpaceId: string
  mountSubpath: MountSubpath
  /** The owning CTI sandbox detail row (P3: the SOLE mount→runtime identity).
   *  Back-filled POST-create (the sandboxes row is minted inside backend.create());
   *  NULL only in the insert→onRuntimeReady window. adapter / resource_id / host_pid
   *  / pairing_session live on the sandboxes row, resolved via this id. */
  sandboxId: string | null
  baseSnapshotId: string | null
  resultSnapshotId: string | null
  refreshPolicy: "per_turn" | "on_teardown"
  status: "provisioning" | "active" | "closed" | "failed"
  materializedDir: string | null
  errorMessage: string | null
}

export interface FileSnapshotRow {
  id: string
  workspaceId: string
  fileSpaceId: string
  parentSnapshotId: string | null
  version: string
  manifestSha256: string
  reason: string
  entryCount: number
  totalBytes: string
}

/**
 * Idempotently resolve (or create) a file_space for an owner/scope/namespace.
 * Mirrors resolveOrCreateMemorySpace exactly: single-statement transactional
 * upsert via INSERT ... ON CONFLICT ... DO UPDATE (no-op) RETURNING, picking
 * the scoped/unscoped partial-unique index by branching on scopeSubjectId.
 * current_snapshot_id is left NULL on create (an empty space) — the composite
 * FK forbids pointing at a non-existent snapshot.
 */
export async function ensureFileSpace(
  client: Executor,
  input: {
    workspaceId: string
    owner: SubjectRef
    scope?: SubjectRef
    namespaceKey?: string
  }
): Promise<FileSpaceRow> {
  const ownerKind = input.owner.kind
  if (
    ownerKind === SUBJECT_KIND.USER ||
    ownerKind === SUBJECT_KIND.EXTERNAL ||
    ownerKind === SUBJECT_KIND.PLATFORM
  ) {
    throw new SandboxSpaceError(
      `File space owner kind '${ownerKind}' is not permitted`,
      400
    )
  }
  if (
    input.scope &&
    input.scope.kind !== SUBJECT_KIND.WORKSPACE &&
    input.scope.kind !== SUBJECT_KIND.CONVERSATION
  ) {
    throw new SandboxSpaceError(
      `File space scope kind '${input.scope.kind}' must be workspace|conversation`,
      400
    )
  }

  const ownerSubjectId = await upsertAccessSubjectOn(client, input.owner)
  const scopeSubjectId = input.scope
    ? await upsertAccessSubjectOn(client, input.scope)
    : null
  const namespaceKey =
    (input.namespaceKey || DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE

  // DO UPDATE (no-op) is required for RETURNING on the conflicting row; DO
  // NOTHING would skip RETURNING. Pick the matching partial-unique index. The
  // file_spaces unique indexes are soft-delete-aware (… AND deleted_at IS NULL),
  // so the ON CONFLICT predicate must match exactly (design §8.3).
  // conflictClause is a fixed compile-time fragment (no external input) → sql.raw.
  const conflictClause = scopeSubjectId
    ? `(workspace_id, owner_subject_id, scope_subject_id, namespace_key) WHERE scope_subject_id IS NOT NULL AND deleted_at IS NULL`
    : `(workspace_id, owner_subject_id, namespace_key) WHERE scope_subject_id IS NULL AND deleted_at IS NULL`
  const result = await sql<FileSpaceRow>`
    INSERT INTO file_spaces (id, workspace_id, owner_subject_id, scope_subject_id, namespace_key, created_at, updated_at)
    VALUES (${uuidv4()}, ${input.workspaceId}, ${ownerSubjectId}, ${scopeSubjectId}, ${namespaceKey}, NOW(), NOW())
    ON CONFLICT ${sql.raw(conflictClause)}
      DO UPDATE SET updated_at = file_spaces.updated_at
    RETURNING id, workspace_id, owner_subject_id, scope_subject_id, namespace_key, current_snapshot_id`.execute(
    client
  )
  const row = result.rows[0]
  if (!row) {
    throw new SandboxSpaceError("Failed to resolve or create file_space", 500)
  }
  return row
}

/** Load a file_space by id. */
export async function getFileSpace(
  client: Executor,
  fileSpaceId: string
): Promise<FileSpaceRow | null> {
  const result = await sql<FileSpaceRow>`
    SELECT id, workspace_id, owner_subject_id, scope_subject_id, namespace_key, current_snapshot_id
    FROM file_spaces WHERE id = ${fileSpaceId} LIMIT 1`.execute(client)
  return result.rows[0] ?? null
}

/**
 * Insert a file_mount row in 'provisioning' state. The two active partial-unique
 * indexes (per session×space, per session×subpath) guarantee a session never
 * has two live mounts for the same space or subpath.
 */
export async function insertFileMount(
  client: Executor,
  input: {
    workspaceId: string
    sessionId: string
    fileSpaceId: string
    mountSubpath: MountSubpath
    baseSnapshotId: string | null
    refreshPolicy?: "per_turn" | "on_teardown"
    materializedDir?: string | null
  }
): Promise<FileMountRow> {
  const result = await sql<FileMountRow>`
    INSERT INTO file_mounts
      (id, workspace_id, session_id, file_space_id, mount_subpath,
       base_snapshot_id, refresh_policy, status,
       materialized_dir, created_at, updated_at)
    VALUES (${uuidv4()}, ${input.workspaceId}, ${input.sessionId}, ${input.fileSpaceId}, ${input.mountSubpath},
            ${input.baseSnapshotId}, ${input.refreshPolicy ?? "per_turn"}, 'provisioning', ${input.materializedDir ?? null}, NOW(), NOW())
    RETURNING id, workspace_id, session_id, file_space_id, mount_subpath,
              sandbox_id, base_snapshot_id, result_snapshot_id,
              refresh_policy, status, materialized_dir, error_message`.execute(
    client
  )
  const row = result.rows[0]
  if (!row) throw new SandboxSpaceError("Failed to insert file_mount", 500)
  return row
}

/** Patch mutable columns on a file_mount (status/device/pid/snapshots/etc). */
export async function updateFileMount(
  client: Executor,
  mountId: string,
  patch: Partial<{
    status: FileMountRow["status"]
    sandboxId: string | null
    baseSnapshotId: string | null
    resultSnapshotId: string | null
    materializedDir: string | null
    errorMessage: string | null
    closedAt: boolean // when true, set closed_at = NOW()
  }>
): Promise<void> {
  const sets = []
  const add = (col: string, val: unknown) => {
    sets.push(sql`${sql.ref(col)} = ${val}`)
  }
  if (patch.status !== undefined) add("status", patch.status)
  if (patch.sandboxId !== undefined) add("sandbox_id", patch.sandboxId)
  if (patch.baseSnapshotId !== undefined)
    add("base_snapshot_id", patch.baseSnapshotId)
  if (patch.resultSnapshotId !== undefined)
    add("result_snapshot_id", patch.resultSnapshotId)
  if (patch.materializedDir !== undefined)
    add("materialized_dir", patch.materializedDir)
  if (patch.errorMessage !== undefined) add("error_message", patch.errorMessage)
  if (patch.closedAt) sets.push(sql`closed_at = NOW()`)
  if (sets.length === 0) {
    return
  }
  await sql`UPDATE file_mounts SET ${sql.join(sets, sql`, `)} WHERE id = ${mountId}`.execute(
    client
  )
}

/** Active (non-closed/failed) mounts for a session. */
export async function getActiveMountsForSession(
  client: Executor,
  sessionId: string
): Promise<FileMountRow[]> {
  const result = await sql<FileMountRow>`
    SELECT id, workspace_id, session_id, file_space_id, mount_subpath,
           sandbox_id, base_snapshot_id, result_snapshot_id,
           refresh_policy, status, materialized_dir, error_message
    FROM file_mounts
    WHERE session_id = ${sessionId} AND status NOT IN ('closed', 'failed')
    ORDER BY mount_subpath`.execute(client)
  return result.rows
}

/**
 * Mounts left in 'failed' state with a preserved live dir — the teardown
 * commit failed and the materialized_dir was kept for recovery. Grouped by
 * session for the startup reconciler to retry. `limit` bounds a single sweep.
 */
export async function getFailedRecoverableMounts(
  client: Executor,
  limit = 200
): Promise<FileMountRow[]> {
  const result = await sql<FileMountRow>`
    SELECT id, workspace_id, session_id, file_space_id, mount_subpath,
           sandbox_id, base_snapshot_id, result_snapshot_id,
           refresh_policy, status, materialized_dir, error_message
    FROM file_mounts
    WHERE status = 'failed' AND materialized_dir IS NOT NULL
    ORDER BY updated_at ASC
    LIMIT ${limit}`.execute(client)
  return result.rows
}

/**
 * (R4 §6.3/§6.5) Does this session have any 'failed' recoverable mount (a
 * materialized_dir preserved by a teardown pull/commit failure)? The off-box
 * closing reaper re-drive uses this: a 'closing' off-box row with NO active mounts
 * but pending FAILED mounts must NOT DELETE the VM (+ rm the preserved dirs) — that
 * unrecovered work belongs to recoverFailedSandboxMounts' re-pull.
 */
export async function sessionHasFailedRecoverableMounts(
  client: Executor,
  sessionId: string
): Promise<boolean> {
  const result = await sql<{ one: number }>`
    SELECT 1 AS one
    FROM file_mounts
    WHERE session_id = ${sessionId}
      AND status = 'failed'
      AND materialized_dir IS NOT NULL
    LIMIT 1`.execute(client)
  return result.rows.length > 0
}

/**
 * (R5 #4 review-fix) Terminally close every FAILED mount of a session — used when
 * off-box recovery is EXHAUSTED (the un-pulled VM is unrecoverable, so its preserved
 * materializedDir is being discarded). Flips 'failed' → 'closed' so the recovery
 * sweep + the keepalive's failed-mount predicate stop matching the row.
 */
export async function closeSessionFailedMounts(
  client: Executor,
  sessionId: string
): Promise<void> {
  await sql`
    UPDATE file_mounts
       SET status = 'closed', closed_at = NOW()
     WHERE session_id = ${sessionId}
       AND status = 'failed'`.execute(client)
}

/**
 * Append a new snapshot to a space's DAG and advance current_snapshot_id, all
 * under a short transaction that serializes version assignment via
 * SELECT ... FOR UPDATE on the file_spaces row. The caller must have already
 * ingested the manifest blob + new content blobs into content_blobs (the FK
 * file_snapshots.manifest_sha256 → content_blobs is RESTRICT).
 *
 * Returns the new snapshot row. `expectedParentSnapshotId` is the head the
 * caller computed the manifest against; if the head has since moved, this
 * throws SandboxSpaceError(409) so the caller can re-scan against the new head
 * (never blindly merge a stale manifest).
 */
export async function appendSnapshot(
  client: Executor,
  input: {
    workspaceId: string
    fileSpaceId: string
    expectedParentSnapshotId: string | null
    manifestSha256: string
    reason?: string
    entryCount: number
    totalBytes: number
    createdBySessionId?: string | null
  }
): Promise<FileSnapshotRow> {
  // Serialize per-space version assignment.
  const locked = await sql<{ currentSnapshotId: string | null }>`
    SELECT current_snapshot_id FROM file_spaces WHERE id = ${input.fileSpaceId} FOR UPDATE`.execute(
    client
  )
  if (locked.rows.length === 0) {
    throw new SandboxSpaceError(
      `file_space ${input.fileSpaceId} not found`,
      404
    )
  }
  const head = locked.rows[0].currentSnapshotId
  if (head !== input.expectedParentSnapshotId) {
    throw new SandboxSpaceError(
      `file_space ${input.fileSpaceId} head moved during commit (expected ${input.expectedParentSnapshotId}, now ${head})`,
      409
    )
  }

  const nextVersion = await sql<{ v: string }>`
    SELECT COALESCE(MAX(version), 0) + 1 AS v FROM file_snapshots WHERE file_space_id = ${input.fileSpaceId}`.execute(
    client
  )
  const version = nextVersion.rows[0]?.v ?? "1"

  const snapId = uuidv4()
  const inserted = await sql<FileSnapshotRow>`
    INSERT INTO file_snapshots
      (id, workspace_id, file_space_id, parent_snapshot_id, version,
       manifest_sha256, reason, entry_count, total_bytes,
       created_by_session_id, created_at)
    VALUES (${snapId}, ${input.workspaceId}, ${input.fileSpaceId}, ${input.expectedParentSnapshotId}, ${version},
            ${input.manifestSha256}, ${input.reason ?? "session_commit"}, ${input.entryCount}, ${input.totalBytes},
            ${input.createdBySessionId ?? null}, NOW())
    RETURNING id, workspace_id, file_space_id, parent_snapshot_id, version,
              manifest_sha256, reason, entry_count, total_bytes`.execute(client)
  const row = inserted.rows[0]
  if (!row) throw new SandboxSpaceError("Failed to insert file_snapshot", 500)

  await sql`
    UPDATE file_spaces SET current_snapshot_id = ${snapId} WHERE id = ${input.fileSpaceId}`.execute(
    client
  )
  return row
}

/** Load a snapshot's manifest sha for a given snapshot id (within a space). */
export async function getSnapshotManifestSha(
  client: Executor,
  snapshotId: string
): Promise<string | null> {
  const result = await sql<{ manifestSha256: string }>`
    SELECT manifest_sha256 FROM file_snapshots WHERE id = ${snapshotId} LIMIT 1`.execute(
    client
  )
  return result.rows[0]?.manifestSha256 ?? null
}
