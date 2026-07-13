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
import {
  type SandboxCapabilityDescriptor,
  decodeSandboxCapabilityDescriptor,
} from "./model.js"
import { decodeSandboxDataPlaneCredentials } from "./data-plane-credentials.js"
import type { SandboxDataPlaneCredentials } from "./sandbox-backend.js"

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
 * Resolve the device_runtime service id for a runtime (the id dispatchSyncTool
 * keys the endpoint registry on). Returns null if the runtime has no
 * device_runtime service yet. Mirrors the lookup the docker bootstrap poller +
 * dispatch use.
 */
export async function resolveDeviceRuntimeServiceId(
  runtimeId: string,
  run: Executor = db
): Promise<string | null> {
  const svc = await run
    .selectFrom("runtimeServices")
    .select("id")
    .where("runtimeId", "=", runtimeId)
    .where("serviceKind", "=", "device_runtime")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return (svc?.id as string | undefined) ?? null
}

/**
 * One readiness tick for waitForCatalog: is the runtime's filesystem builtin
 * exposure healthy yet? The service keeps the poll loop and calls this each tick
 * (preserving the predicate set: builtinKind=filesystem + runtimeStatus=healthy).
 */
export async function isFilesystemExposureHealthy(
  runtimeId: string,
  run: Executor = db
): Promise<boolean> {
  const ready = await run
    .selectFrom("runtimeExposures")
    .select("id")
    .where("runtimeId", "=", runtimeId)
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
      WHERE status IN ('provisioning', 'active')
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
 * Whether reconcile should fire the docker orphan reaper — TRUE on ANY evidence this
 * host could have leaked a labeled docker sandbox container:
 *
 *  (1) a `sandboxes` row adapter='docker' (post-bootstrap; live or soft-deleted).
 *      Covers a host that ran docker sandboxes and later fell back to local.
 *  (2) a live (non-closed/failed) `file_mount` whose `sandbox_id` is STILL NULL — the
 *      fingerprint of a PRE-BOOTSTRAP crash orphan: the API `docker run`+LABELED a
 *      container, then died BEFORE the bootstrap-consume minted the sandboxes row (so
 *      arm (1) is blind to it) and before sandbox_id was back-filled. At STARTUP (the
 *      only reconcile caller) such a mount is ALWAYS a crash orphan — no in-flight
 *      provision exists yet — so this never false-positives on a healthy provision. A
 *      pure-local pre-mint crash also matches, but the reaper then finds no labeled
 *      container and no-ops. **Must be read BEFORE the reconcile teardown loop closes
 *      the orphan's mounts**, else the signal is erased.
 *
 * Over-firing is a harmless no-op; under-firing leaks containers — exactly what
 * dropping the old file_mounts.sandbox_backend arm (P3d) reintroduced for arm (2),
 * restored here structurally.
 */
export async function hasDockerMountHistory(
  run: Executor = db
): Promise<boolean> {
  const row = await sql<{ ok: boolean }>`
    SELECT (
      EXISTS(SELECT 1 FROM sandboxes WHERE adapter = 'docker')
      OR EXISTS(
        SELECT 1 FROM file_mounts
        WHERE sandbox_id IS NULL AND status NOT IN ('closed', 'failed')
      )
    ) AS ok`.execute(run)
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

export interface RuntimeBuiltinExposureRow {
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
): Promise<RuntimeBuiltinExposureRow[]> {
  return run
    .selectFrom("runtimeExposures as e")
    .innerJoin("runtimeCapabilities as c", "c.exposureId", "e.id")
    .innerJoin("workspaceResources as resource", "resource.id", "c.id")
    .select(["e.id as exposureId", "c.id as capabilityId", "e.builtinKind"])
    .where("e.runtimeId", "=", runtimeId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("e.builtinKind", "in", ["filesystem", "commandline"])
    .execute() as Promise<RuntimeBuiltinExposureRow[]>
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
//   • REUSE / FAST-PATH / reconcile enumeration: STATE-FILTERED. The fast path
//     reads getSandboxById / getSandboxBySessionForControl and reuses ONLY when
//     state === 'active' (R3.5 — a 'provisioning'/'closing' row must converge,
//     never be reused). There is no looser NOT-IN-(closed,failed) reader.

export interface SandboxRow {
  id: string
  workspaceId: string
  sessionId: string | null
  mode: "resident" | "bare"
  adapter: string
  state: "provisioning" | "active" | "closing" | "closed" | "failed"
  resourceId: string | null
  hostPid: number | null
  /**
   * R3.6: durable process-identity token ('<boot_id>:<starttime>') for a LOCAL
   * sandbox's host_pid. The cross-process kill path signals host_pid ONLY when the
   * live pid's identity still matches this. NULL for docker/off-box (no host pid),
   * non-Linux hosts, and legacy rows minted before this column existed.
   */
  hostPidIdentity: string | null
  pairingSessionId: string | null
  /**
   * (R4 §1.3/#6) The raw base64 AES-256-GCM envelope of the off-box data-plane
   * creds (nonce‖ct‖tag, AAD-bound to the row id). NULL for host/resident + the
   * unauthenticated local cube. The general read surface carries the CIPHERTEXT;
   * the decrypt-at-exit (→ SandboxDataPlaneCredentials) is confined to the
   * dispatch/rebuild path (getBareSandboxForDispatch), never the generic reader.
   */
  dataPlaneCredentialsEncrypted: string | null
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
  "hostPidIdentity",
  "pairingSessionId",
  "dataPlaneCredentialsEncrypted",
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
  "sb.hostPidIdentity",
  "sb.pairingSessionId",
  "sb.dataPlaneCredentialsEncrypted",
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
    hostPidIdentity: (row.hostPidIdentity as string | null) ?? null,
    pairingSessionId: (row.pairingSessionId as string | null) ?? null,
    dataPlaneCredentialsEncrypted:
      (row.dataPlaneCredentialsEncrypted as string | null) ?? null,
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
    hostPidIdentity: string | null
    errorMessage: string | null
    deadlineAt: Date | null
  }>,
  run: Executor = db
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.state !== undefined) set.state = patch.state
  if (patch.resourceId !== undefined) set.resourceId = patch.resourceId
  if (patch.hostPid !== undefined) set.hostPid = patch.hostPid
  if (patch.hostPidIdentity !== undefined)
    set.hostPidIdentity = patch.hostPidIdentity
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
 * R3.P2b — race-closing active flip. Provision's final `provisioning → active`
 * transition MUST be a compare-and-swap: only flip when the row is STILL
 * 'provisioning', so a concurrent TTL reaper that already moved it to 'failed'
 * (deadline exceeded) is not silently resurrected. Returns true iff exactly one
 * row flipped; false ⇒ the reaper (or another writer) won and the caller must run
 * its provision-failure cleanup instead of reporting success.
 */
export async function casFlipSandboxActive(
  id: string,
  run: Executor = db
): Promise<boolean> {
  const res = await run
    .updateTable("sandboxes")
    .set({ state: "active", updatedAt: new Date() } as never)
    .where("id", "=", id)
    .where("state", "=", "provisioning")
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0n) === 1
}

/**
 * (R4 §6.3/§6.6 #5-A) CAS the teardown CLOSE-GATE. Only flip a row still in a
 * non-terminal state (provisioning/active/closing) to 'closing' — so a concurrent
 * reprovision/reaper that already drove it terminal (closed/failed) wins and the
 * teardown ABORTS rather than laying a fence on a row someone else owns. Returns
 * true iff it flipped/re-affirmed exactly one non-terminal row. (The 'closing'→
 * 'closing' self-flip re-affirms an in-progress teardown's own fence and bumps
 * updated_at, pacing the closing-retry reaper.) Off-box teardown MUST NOT swallow
 * a false here: proceeding to kill+commit under an unset fence violates the R3.8
 * exactly-one-when-active invariant.
 */
export async function casFlipSandboxClosing(
  id: string,
  run: Executor = db
): Promise<boolean> {
  const res = await run
    .updateTable("sandboxes")
    .set({ state: "closing", updatedAt: new Date() } as never)
    .where("id", "=", id)
    .where("state", "in", ["provisioning", "active", "closing"])
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0n) === 1
}

/**
 * R3.P2b — TTL reaper candidate query. Sandboxes STILL 'provisioning' whose
 * deadline_at has passed: a provision that crashed/hung before its CAS active
 * flip. Restricted to state='provisioning' (the idx_sandboxes_reap partial index)
 * — active/committing/closing are boot-reconcile's job, never the periodic sweep.
 */
export async function listStuckProvisioningSandboxes(
  run: Executor = db
): Promise<
  Array<{ id: string; workspaceId: string; sessionId: string | null }>
> {
  const rows = await sql<{
    id: string
    workspaceId: string
    sessionId: string | null
  }>`
    SELECT id, workspace_id AS "workspaceId", session_id AS "sessionId"
      FROM sandboxes
      WHERE state = 'provisioning' AND deadline_at IS NOT NULL AND deadline_at < NOW()`.execute(
    run
  )
  return rows.rows
}

/**
 * R3.P2b — CAS the reaper's terminal flip. Only move a still-'provisioning' row
 * to 'failed' (mirror of {@link casFlipSandboxActive}), so a provision that flips
 * to 'active' at the same instant wins and the reaper no-ops. Returns true iff it
 * flipped exactly one row.
 */
export async function casFailStuckProvisioningSandbox(
  id: string,
  errorMessage: string,
  run: Executor = db
): Promise<boolean> {
  const res = await run
    .updateTable("sandboxes")
    .set({
      state: "failed",
      errorMessage,
      updatedAt: new Date(),
    } as never)
    .where("id", "=", id)
    .where("state", "=", "provisioning")
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0n) === 1
}

/**
 * F3 — sessions of sandboxes STUCK in 'closing' (teardown preserved them on an
 * alive/unknown liveness probe) whose runtime is not yet soft-deleted and whose
 * last close attempt is older than the grace window. The periodic retry re-drives
 * teardownSandbox for each (fail-closed: it converges only on a CONFIRMED-dead
 * re-probe, never orphans a possibly-live runtime). `updated_at` is bumped by the
 * close-gate on every attempt, so the grace both skips normal in-flight teardowns
 * (seconds) and paces the retry cadence for a genuinely-stuck row.
 */
export async function listReapableClosingSandboxSessions(
  graceSeconds: number,
  run: Executor = db
): Promise<Array<{ sessionId: string }>> {
  const rows = await sql<{ sessionId: string }>`
    SELECT sb.session_id AS "sessionId"
      FROM sandboxes sb
      JOIN runtimes_live r ON r.id = sb.id
      WHERE sb.state = 'closing'
        AND sb.session_id IS NOT NULL
        AND sb.updated_at < NOW() - make_interval(secs => ${graceSeconds})`.execute(
    run
  )
  return rows.rows
}

/**
 * (R4 §1.7 orphan sweep) Provider resource ids of the LIVE, non-terminal
 * sandboxes for an adapter — the "still ours, do NOT reap" set the provider VM
 * listing is diffed against. Non-terminal = provisioning/active/closing (a
 * 'closing' VM may still be pulled by teardown/recovery). A soft-deleted runtime
 * or a closed/failed row is intentionally ABSENT so its leaked VM gets reaped.
 * Empty resource_id (a host/resident row) is excluded.
 */
export async function listNonTerminalSandboxResourceIds(
  adapter: string,
  run: Executor = db
): Promise<string[]> {
  const rows = await sql<{ resourceId: string }>`
    SELECT sb.resource_id AS "resourceId"
      FROM sandboxes sb
      JOIN runtimes_live r ON r.id = sb.id
      WHERE sb.adapter = ${adapter}
        AND sb.resource_id <> ''
        AND sb.state IN ('provisioning', 'active', 'closing')`.execute(run)
  return rows.rows.map((x) => x.resourceId)
}

/**
 * (R4 §1.7 keepalive) Provider resource ids of the LIVE sandboxes whose session
 * is IN USE (provisioning/active) for an adapter — the VMs whose hard provider
 * auto-destroy deadline the maintenance tick must push forward so an active
 * session never self-destructs. 'closing' is excluded on purpose (teardown / the
 * closing reaper own it, and the TTL is its intended backstop).
 */
export async function listKeepAliveSandboxResourceIds(
  adapter: string,
  run: Executor = db
): Promise<string[]> {
  const rows = await sql<{ resourceId: string }>`
    SELECT sb.resource_id AS "resourceId"
      FROM sandboxes sb
      JOIN runtimes_live r ON r.id = sb.id
      WHERE sb.adapter = ${adapter}
        AND sb.resource_id <> ''
        AND sb.state IN ('provisioning', 'active')`.execute(run)
  return rows.rows.map((x) => x.resourceId)
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
  /**
   * R3.2 (target-confusion, SECURITY): the AUTHORITATIVE provider resource id from
   * the sandboxes row (docker:bare → the container id; local:bare → ""). The
   * rebuild path binds the free-string data_plane_endpoint to THIS value and takes
   * the docker container id from HERE, never from `endpoint.slice(...)` — the
   * endpoint degrades to a pure scheme discriminant so a hand-edited endpoint can
   * no longer redirect the docker-exec plane at an arbitrary container.
   */
  resourceId: string | null
  runtimeDeletedAt: Date | null
  /** (R4 §1.3) the row's workspace id — the second half of the creds AAD, and
   *  threaded onto the rebuild row for a future per-ws key rotation. */
  workspaceId: string
  /**
   * (R4 §1.3, F7) the DECRYPTED off-box data-plane creds, or null. A creds-only
   * decrypt MISS (rotated key / tampered AAD / corrupt blob) is null — NOT a null
   * ROW (the reconnect re-mint heals it); whole-row-null stays reserved for a
   * descriptor decode miss (capabilityDescriptor null → hard-deny below). null for
   * host/resident + the unauthenticated local cube.
   */
  credentials: SandboxDataPlaneCredentials | null
  /** (R4 §1.6) provider platform/arch facts, threaded onto the rebuild row. */
  platform: string | null
  arch: string | null
  /**
   * Zod-decoded (P1.3) persisted descriptor, or NULL when the JSONB failed to
   * decode (corrupt/hand-edited row). The dispatch fork hard-denies on null
   * rather than running the plane with a NaN/defaulted safety cap. NULL is also
   * expected for a resident sandbox's `{}`-degenerate descriptor, but a resident
   * row never reaches the bare dispatch fork (the mode gate denies first).
   */
  capabilityDescriptor: SandboxCapabilityDescriptor | null
  /**
   * The bare_dataplane service's scheme-tagged non-dialable endpoint
   * (`inprocess:<runtimeId>` for local:bare; `docker-exec:<containerId>` for
   * docker:bare). The rebuild-on-miss path forks on the scheme to reconstruct the
   * correct plane (a docker:bare plane needs the container id). NULL only if the
   * bare_dataplane service is somehow absent (a hard-deny condition upstream).
   */
  dataPlaneEndpoint: string | null
}

/**
 * (R4 §3.4 #5-B) Lightweight cross-process liveness for a bare runtime — ONLY the
 * sandbox state + the runtime soft-delete flag, no descriptor/creds decode. Feeds
 * the short-TTL HIT re-check in bare-dispatch so a live in-process plane HIT can't
 * outlive a cross-process teardown (a ≥2-replica topology an off-box VM enables).
 */
export async function getBareDispatchLiveness(
  runtimeId: string,
  run: Executor = db
): Promise<{
  state: SandboxRow["state"]
  runtimeDeletedAt: Date | null
} | null> {
  const row = await run
    .selectFrom("sandboxes as sb")
    .innerJoin("runtimes as r", "r.id", "sb.id")
    .select(["sb.state", "r.deletedAt as runtimeDeletedAt"])
    .where("sb.id", "=", runtimeId)
    .executeTakeFirst()
  if (!row) return null
  return {
    state: row.state as SandboxRow["state"],
    runtimeDeletedAt: (row.runtimeDeletedAt as Date | null) ?? null,
  }
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
      "sb.workspaceId",
      "sb.mode",
      "sb.adapter",
      "sb.state",
      "sb.resourceId",
      "sb.platform",
      "sb.arch",
      "sb.dataPlaneCredentialsEncrypted",
      "sb.capabilityDescriptor",
      "r.deletedAt as runtimeDeletedAt",
      "rs.dataPlaneEndpoint as dataPlaneEndpoint",
    ])
    .where("sb.id", "=", runtimeId)
    .executeTakeFirst()
  if (!row) return null
  const workspaceId = row.workspaceId as string
  return {
    sessionId: (row.sessionId as string | null) ?? null,
    workspaceId,
    mode: row.mode as SandboxRow["mode"],
    adapter: row.adapter as string,
    state: row.state as SandboxRow["state"],
    resourceId: (row.resourceId as string | null) ?? null,
    runtimeDeletedAt: (row.runtimeDeletedAt as Date | null) ?? null,
    // R4 §1.3 (F7): decrypt the off-box creds bound (AAD) to THIS row's identity.
    // A creds-only MISS → null (NOT a null row) so the rebuild degrades to a
    // token-less/re-mint heal instead of a hard-deny. Never throws.
    credentials: decodeSandboxDataPlaneCredentials(
      (row.dataPlaneCredentialsEncrypted as string | null) ?? null,
      { sandboxRowId: runtimeId, workspaceId }
    ),
    platform: (row.platform as string | null) ?? null,
    arch: (row.arch as string | null) ?? null,
    // P1.3: Zod-decode at the repo exit; null on any decode failure so the
    // dispatch fork fails closed instead of trusting a corrupt safety cap.
    capabilityDescriptor: decodeSandboxCapabilityDescriptor(
      row.capabilityDescriptor
    ),
    dataPlaneEndpoint: (row.dataPlaneEndpoint as string | null) ?? null,
  }
}

/**
 * (R4 §6.2) Re-persist FRESH off-box data-plane creds after a reconnect re-mint,
 * gated on the sandbox still being non-terminal (CAS on state) so a teardown
 * racing the re-mint doesn't resurrect a cred blob on a closing/closed/failed
 * row. NEVER called on the read-only dispatch fast path unless the token changed.
 * Returns true iff it wrote exactly one row.
 */
export async function repersistBareSandboxCredentials(
  runtimeId: string,
  credentialsEncrypted: string | null,
  run: Executor = db
): Promise<boolean> {
  const res = await run
    .updateTable("sandboxes")
    .set({
      dataPlaneCredentialsEncrypted: credentialsEncrypted,
      updatedAt: new Date(),
    } as never)
    .where("id", "=", runtimeId)
    .where("state", "not in", ["closing", "closed", "failed"])
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0n) === 1
}

/**
 * Target-id binding for the bare fork (§4.7.1.1), hardened to RESIDENT PARITY
 * (R3.P2a). The old check was existence/ownership-only: it verified the exposure
 * belonged to runtime+service and the tool belonged to the exposure, but never
 * re-derived the tool's IDENTITY the way the resident projection query does
 * (capability-projection/repo.ts joins dt.currentName / dt.latestRevisionId /
 * dt.status='active' / dx.builtinKind). A stale-revision, renamed, removed, or
 * cross-family envelope (e.g. a filesystem grant carrying toolName='bash') would
 * pass. This now binds ALL of:
 *   - exposure → runtime + service (existing ownership)
 *   - exposure.builtinKind === capabilityFamily (the claimed grant's family —
 *     bare exposures always set a non-null builtin_kind, so this always applies)
 *   - tool.exposureId === exposureId (existing)
 *   - tool.currentName === toolName (the dispatched visible name is the CURRENT
 *     name — a renamed tool denies)
 *   - tool.latestRevisionId === toolRevisionId (strict revision parity: the
 *     envelope's revision must be the tool's LATEST — a stale revision denies)
 *   - tool.status === 'active' (a removed/disabled tool denies)
 * so a replayed / cross-runtime / stale / renamed / cross-family envelope is
 * rejected before any plane call, matching the resident dispatch's guarantees.
 */
export async function verifyBareDispatchTarget(
  args: {
    runtimeId: string
    runtimeServiceId: string
    exposureId: string
    toolId: string
    toolName: string
    toolRevisionId: string
    /** The claimed grant's capability family (grant.capability). Bound to the
     *  exposure's builtin_kind so a filesystem grant can't dispatch a bash tool. */
    capabilityFamily: string
  },
  run: Executor = db
): Promise<boolean> {
  const exp = await run
    .selectFrom("runtimeExposures")
    .select(["id", "builtinKind"])
    .where("id", "=", args.exposureId)
    .where("runtimeId", "=", args.runtimeId)
    .where("serviceId", "=", args.runtimeServiceId)
    .executeTakeFirst()
  if (!exp) return false
  // A bare exposure ALWAYS carries a non-null builtin_kind (core-catalog). When
  // present it MUST equal the claimed grant family; a null builtin_kind (should
  // never happen for a bare exposure) cannot be trusted to bind, so deny.
  const builtinKind = exp.builtinKind as string | null
  if (builtinKind === null || builtinKind !== args.capabilityFamily)
    return false
  const tool = await run
    .selectFrom("runtimeTools")
    .select(["id", "currentName", "latestRevisionId", "status"])
    .where("id", "=", args.toolId)
    .where("exposureId", "=", args.exposureId)
    .executeTakeFirst()
  if (!tool) return false
  if ((tool.status as string) !== "active") return false
  if ((tool.currentName as string) !== args.toolName) return false
  if ((tool.latestRevisionId as string | null) !== args.toolRevisionId)
    return false
  return true
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
