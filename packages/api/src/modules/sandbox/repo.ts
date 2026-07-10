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
  // S10 UNION SUPERSET (§2.9/§E): candidates = live-mount arm ∪ live-sandbox arm.
  // The union can only GROW liveSessionIds, so no live container drops out of the
  // reaper shield during the mixed-shape interim. The sandboxes arm uses
  // `state NOT IN ('closed','failed')` (includes 'closing', matches
  // idx_sandboxes_reconcile — CORRECTION 8) so a 'closing' sandbox mid-teardown
  // with a live container is not reaped before its commit completes.
  const rows = await sql<{ sessionId: string | null }>`
    SELECT session_id FROM file_mounts
      WHERE status IN ('provisioning', 'active', 'committing')
    UNION
    SELECT s.session_id FROM sandboxes s
      JOIN runtimes_live r ON r.id = s.id
      WHERE s.state NOT IN ('closed', 'failed')
        AND s.session_id IS NOT NULL`.execute(run)
  return rows.rows
    .map((r) => r.sessionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
}

/**
 * Whether this host has EVER run a docker sandbox (any sandboxes row with
 * adapter='docker', live or soft-deleted). Drives whether reconcile fires the
 * docker orphan reaper even after a fallback to the local backend. Over-firing the
 * reap gate is a harmless no-op; under-firing would leak containers.
 */
export async function hasDockerMountHistory(
  run: Executor = db
): Promise<boolean> {
  const row = await sql<{ ok: boolean }>`
    SELECT EXISTS(SELECT 1 FROM sandboxes WHERE adapter = 'docker') AS ok`.execute(
    run
  )
  return Boolean(row.rows[0]?.ok)
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

/** Resolve the most-recent device_runtime service id for a bootstrapped runtime. */
export async function getLatestRuntimeServiceId(
  runtimeId: string,
  run: Executor = db
): Promise<string | undefined> {
  const svc = await run
    .selectFrom("runtimeServices")
    .select("id")
    .where("runtimeId", "=", runtimeId)
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
 *  Returns raw rows; the domain shaper (resolveRuntimeBuiltinIds) folds them. */
export async function selectRuntimeBuiltinExposures(
  runtimeId: string,
  run: Executor = db
): Promise<DeviceBuiltinExposureRow[]> {
  return run
    .selectFrom("runtimeExposures as e")
    .innerJoin("runtimeCapabilities as c", "c.exposureId", "e.id")
    .innerJoin("workspaceResources as resource", "resource.id", "c.id")
    .select(["e.id as exposureId", "c.id as capabilityId", "e.builtinKind"])
    .where("e.runtimeId", "=", runtimeId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("e.builtinKind", "in", ["filesystem", "commandline"])
    .execute() as Promise<DeviceBuiltinExposureRow[]>
}

/** Resolve THIS runtime's capability ids within a workspace (capability rows
 *  whose exposure belongs to the runtime). */
export async function selectRuntimeCapabilityIds(
  params: { workspaceId: string; runtimeId: string },
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
        .where("runtimeId", "=", params.runtimeId)
    )
    .execute()
  return rows.map((r) => r.id as string)
}

// ── sandboxes detail-table lifecycle (P2) ──────────────────────────────────
//
// The `sandboxes` CTI detail row is minted INSIDE backend.create() (docker: the
// bootstrap-consume tx; local: mintLocalSandboxRuntimeTx) — both in the devices
// repo, co-located with the pairing txns. THIS file owns the post-create
// writers/readers the sandbox spine (service.ts) consumes: the state/resource
// back-fill + the two lookup families.
//
// TWO lookup families (CORRECTION 5 — do NOT confuse them):
//   • CONTROL-PATH (teardown / recovery / isSandboxRuntimeAlive): STATE-AGNOSTIC.
//     getSandboxById (no filter) + getSandboxBySessionForControl (only
//     runtimes.deleted_at IS NULL, ANY state) — a 'failed'/'closing' sandbox
//     STILL resolves so a live runtime is killed before a recovery commit.
//   • REUSE / FAST-PATH / reconcile enumeration: STATE-FILTERED.
//     getLiveSandboxBySession (state NOT IN closed/failed).

export interface SandboxRow {
  id: string
  workspaceId: string
  sessionId: string | null
  mode: "resident" | "bare"
  adapter: string
  state:
    | "provisioning"
    | "active"
    | "committing"
    | "closing"
    | "closed"
    | "failed"
  resourceId: string | null
  hostPid: number | null
  pairingSessionId: string | null
}

const SANDBOX_ROW_COLUMNS = [
  "id",
  "workspaceId",
  "sessionId",
  "mode",
  "adapter",
  "state",
  "resourceId",
  "hostPid",
  "pairingSessionId",
] as const

const SANDBOX_ROW_COLUMNS_PREFIXED = [
  "sb.id",
  "sb.workspaceId",
  "sb.sessionId",
  "sb.mode",
  "sb.adapter",
  "sb.state",
  "sb.resourceId",
  "sb.hostPid",
  "sb.pairingSessionId",
] as const

function toSandboxRow(row: Record<string, unknown>): SandboxRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    sessionId: (row.sessionId as string | null) ?? null,
    mode: row.mode as SandboxRow["mode"],
    adapter: row.adapter as string,
    state: row.state as SandboxRow["state"],
    resourceId: (row.resourceId as string | null) ?? null,
    hostPid: (row.hostPid as number | null) ?? null,
    pairingSessionId: (row.pairingSessionId as string | null) ?? null,
  }
}

/**
 * Patch mutable columns on a sandboxes row (post-create back-fill + lifecycle
 * transitions). resource_id/host_pid are written ONLY here (POST-create), never
 * from onResourceCreated — for docker the container id arrives before the
 * consume mints the row (CORRECTION 4).
 */
export async function updateSandboxRow(
  id: string,
  patch: Partial<{
    state: SandboxRow["state"]
    resourceId: string | null
    hostPid: number | null
    errorMessage: string | null
    deadlineAt: Date | null
  }>,
  run: Executor = db
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.state !== undefined) set.state = patch.state
  if (patch.resourceId !== undefined) set.resourceId = patch.resourceId
  if (patch.hostPid !== undefined) set.hostPid = patch.hostPid
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage
  if (patch.deadlineAt !== undefined) set.deadlineAt = patch.deadlineAt
  if (Object.keys(set).length === 0) return
  set.updatedAt = new Date()
  await run
    .updateTable("sandboxes")
    .set(set as never)
    .where("id", "=", id)
    .execute()
}

/**
 * CONTROL-PATH resolver primary: load a sandboxes row by id with NO state filter
 * (rows are never hard-deleted; resource_id/host_pid/adapter survive
 * 'failed'/'closing'/'closed'). Used by teardown/recovery/liveness so a runtime
 * behind a failed sandbox is still killed before a recovery commit.
 */
export async function getSandboxById(
  id: string,
  run: Executor = db
): Promise<SandboxRow | null> {
  const row = await run
    .selectFrom("sandboxes")
    .select(SANDBOX_ROW_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst()
  return row ? toSandboxRow(row) : null
}

/**
 * Bare-dispatch resolver (§4.7.1.1): everything dispatchBareRuntimeTool needs to
 * (a) decide whether to lazy-rebuild the plane or hard-deny, and (b) rebuild the
 * plane from the persisted descriptor (never live config — mode-flip safety). A
 * missing row / soft-deleted runtime / non-live state ⇒ the fork hard-denies.
 */
export interface BareSandboxDispatchRow {
  sessionId: string | null
  mode: "resident" | "bare"
  adapter: string
  state: SandboxRow["state"]
  runtimeDeletedAt: Date | null
  capabilityDescriptor: Record<string, unknown>
  /**
   * The bare_dataplane service's scheme-tagged non-dialable endpoint
   * (`inprocess:<runtimeId>` for local:bare; `docker-exec:<containerId>` for
   * docker:bare). The rebuild-on-miss path forks on the scheme to reconstruct the
   * correct plane (a docker:bare plane needs the container id). NULL only if the
   * bare_dataplane service is somehow absent (a hard-deny condition upstream).
   */
  dataPlaneEndpoint: string | null
}

export async function getBareSandboxForDispatch(
  runtimeId: string,
  run: Executor = db
): Promise<BareSandboxDispatchRow | null> {
  const row = await run
    .selectFrom("sandboxes as sb")
    .innerJoin("runtimes as r", "r.id", "sb.id")
    // Surface the bare_dataplane service's endpoint so the rebuild-on-miss path
    // can reconstruct the correct plane kind (docker:bare needs the container id
    // parsed from `docker-exec:<cid>`). LEFT JOIN so a missing service still
    // returns the row (the upstream hard-deny gates handle it).
    .leftJoin("runtimeServices as rs", (join) =>
      join
        .onRef("rs.runtimeId", "=", "sb.id")
        .on("rs.serviceKind", "=", "bare_dataplane")
    )
    .select([
      "sb.sessionId",
      "sb.mode",
      "sb.adapter",
      "sb.state",
      "sb.capabilityDescriptor",
      "r.deletedAt as runtimeDeletedAt",
      "rs.dataPlaneEndpoint as dataPlaneEndpoint",
    ])
    .where("sb.id", "=", runtimeId)
    .executeTakeFirst()
  if (!row) return null
  return {
    sessionId: (row.sessionId as string | null) ?? null,
    mode: row.mode as SandboxRow["mode"],
    adapter: row.adapter as string,
    state: row.state as SandboxRow["state"],
    runtimeDeletedAt: (row.runtimeDeletedAt as Date | null) ?? null,
    capabilityDescriptor:
      (row.capabilityDescriptor as Record<string, unknown> | null) ?? {},
    dataPlaneEndpoint: (row.dataPlaneEndpoint as string | null) ?? null,
  }
}

/**
 * Target-id binding for the bare fork (§4.7.1.1): the API-signed envelope's
 * runtime_exposure_id must belong to THIS runtime + service, and its
 * runtime_tool_id must belong to that exposure. This is the fork's own
 * verification in place of the resident device's in-process envelope verifier —
 * it rejects a replayed / cross-runtime envelope before any plane call.
 */
export async function verifyBareDispatchTarget(
  args: {
    runtimeId: string
    runtimeServiceId: string
    exposureId: string
    toolId: string
  },
  run: Executor = db
): Promise<boolean> {
  const exp = await run
    .selectFrom("runtimeExposures")
    .select(["id"])
    .where("id", "=", args.exposureId)
    .where("runtimeId", "=", args.runtimeId)
    .where("serviceId", "=", args.runtimeServiceId)
    .executeTakeFirst()
  if (!exp) return false
  const tool = await run
    .selectFrom("runtimeTools")
    .select(["id"])
    .where("id", "=", args.toolId)
    .where("exposureId", "=", args.exposureId)
    .executeTakeFirst()
  return Boolean(tool)
}

/**
 * CONTROL-PATH resolver fallback: the latest sandbox for a session filtered ONLY
 * on runtimes.deleted_at IS NULL (ANY state — NOT on sandboxes.state). Used when
 * a mount has no sandbox_id back-filled yet (CORRECTION 5).
 */
export async function getSandboxBySessionForControl(
  sessionId: string,
  run: Executor = db
): Promise<SandboxRow | null> {
  const row = await run
    .selectFrom("sandboxes as sb")
    .innerJoin("runtimes as r", "r.id", "sb.id")
    .select(SANDBOX_ROW_COLUMNS_PREFIXED)
    .where("sb.sessionId", "=", sessionId)
    .where("r.deletedAt", "is", null)
    .orderBy("sb.createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return row ? toSandboxRow(row) : null
}

/**
 * REUSE / FAST-PATH resolver: the latest LIVE sandbox for a session
 * (state NOT IN closed/failed, runtimes.deleted_at IS NULL). NEVER use for
 * teardown/recovery/liveness — reserved for reuse/fast-path (CORRECTION 5).
 */
export async function getLiveSandboxBySession(
  sessionId: string,
  run: Executor = db
): Promise<SandboxRow | null> {
  const row = await run
    .selectFrom("sandboxes as sb")
    .innerJoin("runtimes as r", "r.id", "sb.id")
    .select(SANDBOX_ROW_COLUMNS_PREFIXED)
    .where("sb.sessionId", "=", sessionId)
    .where("r.deletedAt", "is", null)
    .where(sql<boolean>`sb.state NOT IN ('closed', 'failed')`)
    .orderBy("sb.createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return row ? toSandboxRow(row) : null
}

/** Whether this host has EVER minted a docker sandbox (any sandboxes row with
 *  adapter='docker'). ORed into the reaper's docker-coverage gate (S10). */
export async function hasDockerSandboxHistory(
  run: Executor = db
): Promise<boolean> {
  return Boolean(
    await run
      .selectFrom("sandboxes")
      .select("id")
      .where("adapter", "=", "docker")
      .limit(1)
      .executeTakeFirst()
  )
}

/** Revoke all ACTIVE runtime-authorization grants for a runtime in a workspace. */
export async function revokeActiveRuntimeGrants(
  params: { workspaceId: string; runtimeId: string },
  run: Executor = db
): Promise<void> {
  await run
    .updateTable("runtimeAuthorizationGrants")
    .set({
      status: "revoked",
      revokedAt: new Date(),
    } as never)
    .where("runtimeId", "=", params.runtimeId)
    .where("workspaceId", "=", params.workspaceId)
    .where("status", "=", "active")
    .execute()
}
