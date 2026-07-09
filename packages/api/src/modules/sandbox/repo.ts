// Sandbox module DB access (repo layer). This file is the single home for the
// sandbox module's raw db-client queries — it is exempt from guard r8/r1/r2/r4
// (basename matches /repo[^/]*\.ts$/), so it MAY import the db client and `sql`.
//
// Repo functions return camelCase DOMAIN records and KEEP Date objects (no
// time-to-ISO serialization here — that belongs to presenters, enforced by
// guard r3). Each function takes an injectable
// `run: Executor = db` so callers can thread a transaction/test handle while
// defaulting to the singleton.

import { sql } from "kysely"
import { db, withDbTransaction } from "../../infrastructure/database/kysely.js"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  type PendingCommitConflict,
  type PendingRefreshConflicts,
  normalizePendingConflicts,
  mergePendingConflicts,
  normalizePendingRefresh,
  mergePendingRefreshConflicts,
} from "./pending-conflicts.js"

// Re-export the Executor type so module files (e.g. grants.ts) can accept an
// injectable executor WITHOUT importing the forbidden kysely.js path.
export type { Executor } from "../../infrastructure/database/kysely.js"

// ── service.ts lifecycle: default executor + transaction runner ─────────────
//
// service.ts must hold NO db-client import, but it still threads a production
// default executor into the executor-injectable space.ts helpers and binds the
// RefreshDeps/CommitDeps `dbh`/`runInTx` defaults. These two thin accessors are
// that default, exposed as functions (not the raw `db` value) so the client
// import stays confined to this repo. The Executor identity is the SAME global
// `db`, so transaction semantics across space.ts are unchanged.

/** The production default Executor for non-transactional reads/updates. */
export function defaultDbh(): Executor {
  return db
}

/**
 * Production default transaction runner (wraps withDbTransaction). Used as the
 * RefreshDeps/CommitDeps `runInTx` default and the pending-store wrappers'
 * default, so the inner FOR UPDATE/appendSnapshot run on one pinned connection
 * inside a single BEGIN/COMMIT. NEVER nest this inside another open tx.
 */
export function runInTx<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  return withDbTransaction(fn)
}

// ── service.ts small lookup reads ───────────────────────────────────────────

export interface SessionContext {
  workspaceId: string
  conversationId: string
  actorId: string
}

/**
 * Resolve a session's workspace/conversation/actor context. Returns camelCase
 * domain scalars or null when the session row is absent. Accepts an injected
 * executor so a test on a single pinned/rolled-back connection can see its own
 * uncommitted session row; defaults to the global db.
 */
export async function loadSessionContext(
  sessionId: string,
  run: Executor = db
): Promise<SessionContext | null> {
  const row = await run
    .selectFrom("sessions")
    .select(["workspaceId", "conversationId", "actorId"])
    .where("id", "=", sessionId)
    .executeTakeFirst()
  if (!row) return null
  return {
    workspaceId: row.workspaceId as string,
    conversationId: row.conversationId as string,
    actorId: row.actorId as string,
  }
}

/**
 * Resolve the device_runtime service id for a device (the id dispatchSyncTool
 * keys the tunnel registry on). Returns null if the device has no device_runtime
 * service yet. Mirrors the lookup the docker bootstrap poller + dispatch use.
 */
export async function resolveDeviceRuntimeServiceId(
  deviceId: string,
  run: Executor = db
): Promise<string | null> {
  const svc = await run
    .selectFrom("runtimeServices")
    .select("id")
    .where("runtimeId", "=", deviceId)
    .where("serviceKind", "=", "device_runtime")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return (svc?.id as string | undefined) ?? null
}

/**
 * One readiness tick for waitForCatalog: is the device's filesystem builtin
 * exposure healthy yet? The service keeps the poll loop and calls this each tick
 * (preserving the predicate set: builtinKind=filesystem + runtimeStatus=healthy).
 */
export async function isFilesystemExposureHealthy(
  deviceId: string,
  run: Executor = db
): Promise<boolean> {
  const ready = await run
    .selectFrom("runtimeExposures")
    .select("id")
    .where("runtimeId", "=", deviceId)
    .where("builtinKind", "=", "filesystem")
    .where("runtimeStatus", "=", "healthy")
    .limit(1)
    .executeTakeFirst()
  return Boolean(ready)
}

/**
 * Session ids that have at least one mount in a non-terminal lifecycle state
 * (provisioning/active/committing) — the reconcile sweep's candidate set. The
 * status `in [...]` predicate is load-bearing (excludes closed/failed).
 */
export async function listReconcileCandidateSessionIds(
  run: Executor = db
): Promise<string[]> {
  const rows = await run
    .selectFrom("fileMounts")
    .select("sessionId")
    .where("status", "in", ["provisioning", "active", "committing"])
    .groupBy("sessionId")
    .execute()
  return rows.map((r) => r.sessionId as string)
}

/**
 * Whether this host has EVER run a docker sandbox (any file_mounts row with
 * sandbox_backend='docker'). Drives whether reconcile fires the docker orphan
 * reaper even after a fallback to the local backend. The `limit(1)` existence
 * probe is kept verbatim.
 */
export async function hasDockerMountHistory(
  run: Executor = db
): Promise<boolean> {
  return Boolean(
    await run
      .selectFrom("fileMounts")
      .select("id")
      .where("sandboxBackend", "=", "docker")
      .limit(1)
      .executeTakeFirst()
  )
}

export async function listGcSnapshotManifestShas(
  run: Executor = db
): Promise<string[]> {
  const rows = await sql<{ manifestSha256: string }>`
    SELECT DISTINCT manifest_sha256 FROM file_snapshots`.execute(run)
  return rows.rows
    .map((row) => row.manifestSha256)
    .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
}

/**
 * Durable-GC bookkeeping (plan §10): for a remote backend's candidate shas,
 * read each existing content_blobs row's `durable_confirmed_at` so the sweep can
 * apply the grace window. Returns a Map sha → durableConfirmedAt (Date | null).
 * Shas with NO row are simply absent from the map (the sweep treats "no row" as
 * eligible — an orphaned object with no ledger entry).
 *
 * Scoped to the given backend so the partial index
 * (content_blobs_remote_backend_idx) covers it and a stray local_cas row can
 * never make a remote-keyed object look reachable.
 */
export async function listDurableBlobRows(
  backend: string,
  shas: string[],
  run: Executor = db
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  if (shas.length === 0) return out
  const rows = await run
    .selectFrom("contentBlobs")
    .select(["sha256", "durableConfirmedAt"])
    .where("backend", "=", backend)
    .where("sha256", "in", shas)
    .execute()
  for (const row of rows) {
    out.set(
      row.sha256 as string,
      (row.durableConfirmedAt as Date | null) ?? null
    )
  }
  return out
}

/**
 * Durable-GC safety gate (content storage plan §10#6): is `backend` a write
 * target — i.e. does AT LEAST ONE content_blobs row reference it? The durable
 * sweep deletes object bytes, so it must NEVER touch a configured-but-read-only
 * remote bucket (e.g. a legacy/migration source with WRITE_DEFAULT=local_cas):
 * that bucket has no rows, so this returns false and the sweep skips it whole.
 *
 * Scoped to the backend so the partial index (content_blobs_remote_backend_idx)
 * covers it; LIMIT 1 makes it an index-existence probe, not a full count.
 */
export async function backendHasAnyBlobRow(
  backend: string,
  run: Executor = db
): Promise<boolean> {
  const row = await run
    .selectFrom("contentBlobs")
    .select("sha256")
    .where("backend", "=", backend)
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}

/**
 * Purge a content_blobs row through the SECURITY DEFINER `sd_delete_content_blob`
 * fn (plan §10#1). A naked DELETE is blocked by the `sd_reject_delete` BEFORE
 * DELETE trigger (the row writer is append-only for the app role); the fn runs as
 * `synapse_purge_fn_owner` so the trigger permits it. The durable GC sweep is the
 * ONLY caller — it deletes the row only AFTER the object's bytes are gone from
 * its remote backend.
 */
export async function purgeContentBlobRow(
  sha256: string,
  run: Executor = db
): Promise<void> {
  await sql`SELECT sd_delete_content_blob(${sha256})`.execute(run)
}

const GC_PART_TABLES = [
  "conversation_item_parts",
  "tool_result_parts",
  "memory_item_parts",
  "context_archive_frame_parts",
] as const

export type GcPartTable = (typeof GC_PART_TABLES)[number]

export function gcPartTables(): readonly GcPartTable[] {
  return GC_PART_TABLES
}

export async function listGcPartRefShas(
  table: GcPartTable,
  run: Executor = db
): Promise<string[]> {
  const rows = await sql<{ refSha256: string }>`
    SELECT DISTINCT ref_sha256 FROM ${sql.ref(table)} WHERE ref_sha256 IS NOT NULL`.execute(
    run
  )
  return rows.rows
    .map((row) => row.refSha256)
    .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
}

export async function listGcAssetContentShas(
  run: Executor = db
): Promise<string[]> {
  const rows = await sql<{ contentSha256: string }>`
    SELECT DISTINCT content_sha256 FROM file_assets WHERE content_sha256 IS NOT NULL`.execute(
    run
  )
  return rows.rows
    .map((row) => row.contentSha256)
    .filter((sha): sha is string => typeof sha === "string" && sha.length > 0)
}

export async function listGcPendingSidecarStates(
  run: Executor,
  keys: { pendingCommitKey: string; pendingRefreshKey: string }
): Promise<unknown[]> {
  const rows = await sql<{ collaborationState: unknown }>`
    SELECT collaboration_state FROM sessions
      WHERE collaboration_state ? ${keys.pendingCommitKey}
         OR collaboration_state ? ${keys.pendingRefreshKey}`.execute(run)
  return rows.rows.map((row) => row.collaborationState)
}

// ── service.ts pending-conflict JSONB store (sessions.collaboration_state) ───
//
// Raw sql is preserved VERBATIM: the SQL bodies keep snake_case
// (collaboration_state) while the CamelCasePlugin camelCases the read keys
// (collaborationState); the FOR UPDATE / jsonb_build_object(::jsonb) / `- ::text`
// delete are load-bearing. The `*On` cores take the Executor param and NEVER
// reach for the global db, so a caller can couple the persist with other
// statements in ONE transaction (refresh couples it with the base advance;
// commitOneMount persists inside deps.runInTx).

const PENDING_CONFLICTS_KEY = "_sandboxPendingCommitConflicts"
const PENDING_REFRESH_KEY = "_sandboxPendingRefreshConflicts"

/**
 * Executor-bound core of recordPendingCommitConflicts: read (FOR UPDATE) → merge
 * → write the pending commit-conflict blob on the given (already-open) tx.
 */
export async function recordPendingCommitConflictsOn(
  txq: Executor,
  sessionId: string,
  conflictsBySubpath: Record<string, PendingCommitConflict>
): Promise<void> {
  const existing = await sql<{ collaborationState: unknown }>`
      SELECT collaboration_state FROM sessions WHERE id = ${sessionId} FOR UPDATE`.execute(
    txq
  )
  const state = (existing.rows[0]?.collaborationState ?? {}) as Record<
    string,
    unknown
  >
  const prev = normalizePendingConflicts(state[PENDING_CONFLICTS_KEY])
  const merged = mergePendingConflicts(prev, conflictsBySubpath)
  await sql`
      UPDATE sessions
       SET collaboration_state =
         COALESCE(collaboration_state, '{}'::jsonb)
         || jsonb_build_object(${PENDING_CONFLICTS_KEY}::text, ${JSON.stringify(merged)}::jsonb)
       WHERE id = ${sessionId}`.execute(txq)
}

/**
 * Stash turn-end commit conflicts on the session for the next turn to surface.
 * MERGES with any already-pending conflicts (union by subpath: deduped paths +
 * deduped sidecars). Opens its own transaction via the injected runInTx
 * (default: withDbTransaction) so the FOR UPDATE + UPDATE run on one connection.
 */
export async function recordPendingCommitConflicts(
  sessionId: string,
  conflictsBySubpath: Record<string, PendingCommitConflict>,
  runInTxArg: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T> = runInTx
): Promise<void> {
  await runInTxArg((txq) =>
    recordPendingCommitConflictsOn(txq, sessionId, conflictsBySubpath)
  )
}

/**
 * Read (WITHOUT clearing) any commit conflicts stashed by a previous turn's
 * teardown/commit. At-least-once delivery: the caller surfaces these to the
 * agent, then clears ONLY after the model has consumed them.
 */
export async function peekPendingCommitConflicts(
  sessionId: string
): Promise<Record<string, PendingCommitConflict>> {
  const row = await db
    .selectFrom("sessions")
    .select("collaborationState")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  const state = (row?.collaborationState ?? {}) as Record<string, unknown>
  const pending = normalizePendingConflicts(state[PENDING_CONFLICTS_KEY])
  return Object.keys(pending).length > 0 ? pending : {}
}

/** Clear the stashed commit conflicts (after the agent has consumed them). */
export async function clearPendingCommitConflicts(
  sessionId: string
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      collaborationState: sql`COALESCE(collaboration_state, '{}'::jsonb) - ${PENDING_CONFLICTS_KEY}::text`,
    } as never)
    .where("id", "=", sessionId)
    .execute()
}

/**
 * Executor-bound core of recordPendingRefreshConflicts: read (FOR UPDATE) →
 * merge → write the pending refresh blob on the given (already-open) tx. Used by
 * refreshSpaces to couple the persist with the per-mount base advance in ONE
 * transaction (round-11 #2).
 */
export async function recordPendingRefreshConflictsOn(
  txq: Executor,
  sessionId: string,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
): Promise<void> {
  const existing = await sql<{ collaborationState: unknown }>`
    SELECT collaboration_state FROM sessions WHERE id = ${sessionId} FOR UPDATE`.execute(
    txq
  )
  const state = (existing.rows[0]?.collaborationState ?? {}) as Record<
    string,
    unknown
  >
  const prev = normalizePendingRefresh(state[PENDING_REFRESH_KEY])
  const merged = mergePendingRefreshConflicts(prev, incoming)
  await sql`
    UPDATE sessions
       SET collaboration_state =
         COALESCE(collaboration_state, '{}'::jsonb)
         || jsonb_build_object(${PENDING_REFRESH_KEY}::text, ${JSON.stringify(merged)}::jsonb)
       WHERE id = ${sessionId}`.execute(txq)
}

/**
 * Persist refresh conflicts (deferred paths + sidecars) for at-least-once
 * delivery (round-10 #1), MERGING with any still-undelivered ones. Opens its own
 * transaction via the injected runInTx (default: withDbTransaction).
 */
export async function recordPendingRefreshConflicts(
  sessionId: string,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >,
  runInTxArg: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T> = runInTx
): Promise<void> {
  await runInTxArg((txq) =>
    recordPendingRefreshConflictsOn(txq, sessionId, incoming)
  )
}

/**
 * Read (WITHOUT clearing) refresh conflicts stashed by a previous turn whose
 * notice the actor may not have consumed (at-least-once delivery, round-10 #1).
 * Returns the persisted deferred paths + sidecars (NOT syncFailures).
 */
export async function peekPendingRefreshConflicts(
  sessionId: string
): Promise<
  Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
> {
  const row = await db
    .selectFrom("sessions")
    .select("collaborationState")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  const state = (row?.collaborationState ?? {}) as Record<string, unknown>
  return normalizePendingRefresh(state[PENDING_REFRESH_KEY])
}

/** Clear the stashed refresh conflicts (after the agent has consumed them). */
export async function clearPendingRefreshConflicts(
  sessionId: string
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      collaborationState: sql`COALESCE(collaboration_state, '{}'::jsonb) - ${PENDING_REFRESH_KEY}::text`,
    } as never)
    .where("id", "=", sessionId)
    .execute()
}

// ── docker-sandbox-backend.ts: bootstrap-poll + cleanup ─────────────────────

export interface PairingBootstrapResolution {
  status: string
  runtimeId: string | null
}

/** Read the pairing session's bootstrap state (status + claimed device id). */
export async function getPairingSessionBootstrapState(
  pairingSessionId: string,
  run: Executor = db
): Promise<PairingBootstrapResolution | undefined> {
  return run
    .selectFrom("runtimePairingSessions")
    .select(["status", "runtimeId"])
    .where("id", "=", pairingSessionId)
    .executeTakeFirst()
}

/** Resolve the most-recent device_runtime service id for a bootstrapped device. */
export async function getLatestDeviceRuntimeServiceId(
  deviceId: string,
  run: Executor = db
): Promise<string | undefined> {
  const svc = await run
    .selectFrom("runtimeServices")
    .select("id")
    .where("runtimeId", "=", deviceId)
    .where("serviceKind", "=", "device_runtime")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return svc?.id as string | undefined
}

/** Cancel a still-pending device pairing session so its code can't be reused.
 *  No-op if the session already advanced past pending. Best-effort caller. */
export async function cancelPendingPairingSession(
  pairingSessionId: string,
  run: Executor = db
): Promise<void> {
  await run
    .updateTable("runtimePairingSessions")
    .set({ status: "cancelled" } as never)
    .where("id", "=", pairingSessionId)
    .where("status", "=", "pending")
    .execute()
}

// ── grants.ts: builtin-exposure resolution + grant revocation ───────────────

export interface DeviceBuiltinExposureRow {
  exposureId: string
  capabilityId: string
  builtinKind: string
}

/** Resolve a device's active filesystem/commandline builtin exposures +
 *  capabilities (joined to its workspace resources, soft-delete + active filtered).
 *  Returns raw rows; the domain shaper (resolveDeviceBuiltinIds) folds them. */
export async function selectDeviceBuiltinExposures(
  deviceId: string,
  run: Executor = db
): Promise<DeviceBuiltinExposureRow[]> {
  return run
    .selectFrom("runtimeExposures as e")
    .innerJoin("runtimeCapabilities as c", "c.exposureId", "e.id")
    .innerJoin("workspaceResources as resource", "resource.id", "c.id")
    .select(["e.id as exposureId", "c.id as capabilityId", "e.builtinKind"])
    .where("e.runtimeId", "=", deviceId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("e.builtinKind", "in", ["filesystem", "commandline"])
    .execute() as Promise<DeviceBuiltinExposureRow[]>
}

/** Resolve THIS device's capability ids within a workspace (capability rows
 *  whose exposure belongs to the device). */
export async function selectDeviceCapabilityIds(
  params: { workspaceId: string; deviceId: string },
  run: Executor = db
): Promise<string[]> {
  const rows = await run
    .selectFrom("runtimeCapabilities as capability")
    .innerJoin("workspaceResources as resource", "resource.id", "capability.id")
    .select("capability.id")
    .where("resource.workspaceId", "=", params.workspaceId)
    .where(
      "capability.exposureId",
      "in",
      run
        .selectFrom("runtimeExposures")
        .select("id")
        .where("runtimeId", "=", params.deviceId)
    )
    .execute()
  return rows.map((r) => r.id as string)
}

/** Revoke all ACTIVE runtime-authorization grants for a device in a workspace. */
export async function revokeActiveDeviceRuntimeGrants(
  params: { workspaceId: string; deviceId: string },
  run: Executor = db
): Promise<void> {
  await run
    .updateTable("runtimeAuthorizationGrants")
    .set({
      status: "revoked",
      revokedAt: new Date(),
    } as never)
    .where("runtimeId", "=", params.deviceId)
    .where("workspaceId", "=", params.workspaceId)
    .where("status", "=", "active")
    .execute()
}
