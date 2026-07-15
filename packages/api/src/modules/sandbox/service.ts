// Sandbox manager service: provision / refresh / commit / teardown.
//
// Composes the file-space DB layer (space.ts), the supervisor-side CAS driver
// (materialize.ts), the two-layer authorization (grants.ts), and the host
// provider (host-provider.ts) into the session lifecycle. Topology A: the
// device-runtime is a same-host child sharing one CAS volume with the API.
//
// Three mount spaces per session (general owner model):
//   /conversation        owner=conversation, scope=∅   (shared, multi-writer)
//   /actor               owner=actor,        scope=∅   (global private)
//   /actor-conversation  owner=actor, scope=conversation (this-session private)

import { mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import { actorRef, conversationRef } from "@synapse/shared"
import type { Executor } from "./repo.js"
import * as repo from "./repo.js"
import { STORAGE_DIR } from "../../infrastructure/storage/index.js"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("sandbox.service")
import { deleteRuntime } from "../devices/service.js"
import { getRuntimeEndpointRegistry } from "../devices/tunnel-registry.js"
import {
  ensureFileSpace,
  insertFileMount,
  updateFileMount,
  getActiveMountsForSession,
  claimFailedRecoverableMounts,
  releaseRecoveryClaims,
  sessionHasFailedRecoverableMounts,
  sandboxHasFailedRecoverableMounts,
  closeSessionFailedMounts,
  closeSandboxFailedMounts,
  getFileSpace,
  ensureContentBlob,
  appendSnapshot,
  getSnapshotManifestSha,
  type MountSubpath,
  type FileMountRow,
} from "./space.js"
import {
  materializeSnapshot,
  scanCommitDir,
  syncDir,
  applyHeadForConflicts,
  resolveFsHelperPath,
  cleanupDirs,
  restoreSidecar,
} from "./materialize.js"
import type { DirSyncResult } from "@synapse/device-runtime"
import type { HostProvider } from "./host-provider.js"
import {
  readHostPidIdentity,
  verifyPidIdentity,
  type SandboxHandle,
  type SandboxLiveness,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-lifecycle.js"
import type { OffBoxWorkingSetBridge } from "./data-plane.js"
import { reapDockerSandboxOrphans, type SpawnImpl } from "./docker-sandbox.js"
import {
  markBareDataPlaneClosing,
  clearBareDataPlaneClosing,
  unregisterBareDataPlane,
} from "./bare-dispatch.js"
import {
  resolveSandboxAdapter,
  adapterForRow,
  isOffBoxAdapter,
  type SandboxAdapter,
  type OffBoxBareAdapter,
} from "./adapter-registry.js"
import {
  resolveRuntimeBuiltinIds,
  createSandboxGrants,
  revokeSandboxGrants,
} from "./grants.js"
import {
  type SandboxProvisionResult,
  type SidecarRestoreFailure,
  type SidecarRestoreFailureReason,
} from "./model.js"
import {
  isSidecarPayloadIrrecoverable,
  parseSidecarRoute,
} from "./pending-conflicts.js"
import type {
  ConflictSidecarRef,
  PendingCommitConflict,
  PendingRefreshConflicts,
} from "./pending-conflicts.js"

export {
  isSidecarPayloadIrrecoverable,
  mergePendingConflicts,
  mergePendingRefreshConflicts,
  decodePendingConflicts,
  decodePendingRefresh,
  parseSidecarRoute,
  SIDECAR_ROUTE_RE,
} from "./pending-conflicts.js"
export type {
  ConflictSidecarRef,
  PendingCommitConflict,
  PendingRefreshConflicts,
} from "./pending-conflicts.js"

export class SandboxServiceError extends Error {
  constructor(
    message: string,
    public status = 500
  ) {
    super(message)
    this.name = "SandboxServiceError"
  }
}

// In-process registry of live sandbox handles, keyed by sessionId (== the
// SandboxHandle.sandboxId), so teardown can kill the runtime it started.
// The adapter + resource_id (+ host_pid for local) are persisted on the owning
// `sandboxes` row (P3) so a different process / post-restart teardown can rebuild a
// SandboxRef (via the mount's sandbox_id) and kill it without the in-process handle.
const liveSandboxHandles = new Map<string, SandboxHandle>()

/**
 * R3.P2b: the provision budget written to sandboxes.deadline_at at the post-create
 * back-fill. Deliberately generous — it must exceed the worst-case provision
 * wall-clock (create + catalog wait 30s + tunnel wait 30s + sidecar restore) so
 * the periodic TTL reaper only ever fires on a genuinely-stuck 'provisioning' row,
 * never on a slow-but-healthy in-flight provision. 5 minutes.
 */
const PROVISION_DEADLINE_MS = 5 * 60_000

/**
 * Resolve the sandbox ADAPTER for the provision path (§4.1). Forks on BOTH
 * provider AND mode via the registry. The catalogSource on the returned adapter
 * is what the provision spine forks on (waitForCatalog/waitForTunnelEndpoint vs
 * the api-authored skip).
 */
function resolveAdapterForProvision(
  options: ProvisionSandboxOptions
): SandboxAdapter {
  const adapter = resolveSandboxAdapter(
    config.sandbox.provider,
    config.sandbox.mode,
    {
      hostProvider: options.hostProvider,
      // (§1.5) inject the spine's catalog + tunnel waiters so the RESIDENT
      // adapter's ready() can perform the Mode-A control-plane wait WITHOUT
      // adapter-registry importing this module (which would form a cycle).
      readiness: { waitForCatalog, waitForTunnelEndpoint },
    }
  )
  if (!adapter) {
    throw new SandboxServiceError(
      `no sandbox adapter registered for provider='${config.sandbox.provider}' mode='${config.sandbox.mode}'`,
      500
    )
  }
  return adapter
}

type SessionContext = repo.SessionContext

/**
 * Origin the LOCAL sandbox device-runtime dials back to (passed as `--server=`
 * and to startPairing). Honors SANDBOX_SERVER_ORIGIN — a containerized
 * local deploy sets it to http://127.0.0.1:3001 (loopback) so the same-host
 * child doesn't have to round-trip the public domain (DNS/hairpin-NAT). Falls
 * back to config.app.baseUrl (the prior unconditional value) when unset.
 *
 * NOTE: this is the LOCAL adapter's provision. The docker adapter does NOT read
 * spec.serverOrigin — it builds its own from the same env in
 * dockerBackendOptionsFromEnv (opts.serverOrigin) — so this never affects it.
 */
export function sandboxLocalServerOrigin(): string {
  return config.sandbox.serverOrigin
}

/**
 * The spec.storageVolumeSubpath value for a given adapter. It is a DOCKER-ONLY
 * field (the docker adapter mounts the session's subpath of the shared storage
 * volume into the container; the local adapter ignores it). Computing it for
 * the local adapter was a latent bug: toSandboxVolumeSubpath REQUIRES STORAGE_DIR
 * to live under the volume mount point (default /app/storage) and throws
 * otherwise — which on a bare-metal API (default STORAGE_DIR=/tmp/synapse-storage)
 * aborts provision before the adapter even starts. So compute it only for docker;
 * local gets undefined.
 *
 * Pure (takes storageDir/mountPoint explicitly rather than reading the module
 * STORAGE_DIR const) so it is deterministically unit-testable.
 */
export function sandboxSpecVolumeSubpath(
  provider: string,
  input: { storageDir: string; mountPoint: string; sessionId: string }
): string | undefined {
  return provider === "docker" ? toSandboxVolumeSubpath(input) : undefined
}

/**
 * An adapter usable for `connect()` only (teardown / cross-process kill), built
 * from the persisted SandboxRef kind. `create()` is never called on these.
 *
 * Crucially this must NOT depend on the current provision env: a docker sandbox
 * has to stay reapable even after the API fell back to the local adapter, had
 * sandboxes disabled, or lost its FRP_SHARED_TOKEN — so its connect() is the env-free
 * connectDockerSandbox (docker CLI + persisted container id, no image/network/volume/
 * frp config), never the eager provisionDockerSandbox(dockerBackendOptionsFromEnv()).
 */
function adapterForKind(
  ref: SandboxRef,
  dockerSpawnImpl?: SpawnImpl
): SandboxAdapter {
  // Row-driven (adapter + mode), NEVER current config (inv-45). For docker this
  // resolves the ENV-FREE connect path (F-A); create() is never called on a
  // connect-only adapter. adapterForRow keeps that split.
  return adapterForRow(ref.adapter, ref.mode, { dockerSpawnImpl })
}

/**
 * CONTROL-PATH ref resolver (CORRECTION 5 — STATE-AGNOSTIC). Used by
 * teardown / recovery / isSandboxRuntimeAlive: a sandbox reaches recovery
 * precisely because its state is 'failed'/'closing', so this MUST resolve those
 * too, else a live runtime is never killed and a recovery commit snapshots a
 * directory under active write. Resolution order (P3 — the sandboxes row is the sole
 * identity; there is NO file_mounts-column fallback, so this returns null when neither
 * resolves = nothing killable):
 *   1. mount.sandbox_id → getSandboxById (NO state filter),
 *   2. by-session → getSandboxBySessionForControl (only runtimes.deleted_at IS
 *      NULL, ANY state).
 * This is the STATE-AGNOSTIC control-path resolver; the reuse fast path instead
 * gates on state === 'active' at its own call site (R3.5).
 * runtimeServiceId is intentionally omitted — the kill/liveness path (docker rm
 * by resource id / pid signal) never needs it.
 */
async function buildSandboxRefFromSandboxRow(
  mounts: FileMountRow[],
  run: Executor = repo.defaultDbh(),
  // R3.5(D): an explicit sessionId lets a MOUNT-LESS teardown still resolve its
  // owning sandbox by-session (the mounts-derived sessionId is "" with no mounts).
  explicitSessionId?: string,
  // (R6 #5): when a runtime is PINNED (teardown/recovery by explicit runtimeId),
  // resolve the ref from THAT exact row — never the mounts/createdAt-DESC session
  // resolver — so the reconnect/kill always targets the runtime the caller flipped.
  explicitRuntimeId?: string
): Promise<SandboxRef | null> {
  const sessionId = explicitSessionId ?? mounts[0]?.sessionId ?? ""
  let row: repo.SandboxRow | null = null
  if (explicitRuntimeId) {
    row = await repo.getSandboxById(explicitRuntimeId, run)
    if (!row) return null // the pinned runtime is gone → nothing to target
  } else {
    const mountSandboxId = mounts.find((m) => m.sandboxId)?.sandboxId ?? null
    if (mountSandboxId) {
      row = await repo.getSandboxById(mountSandboxId, run)
    }
    if (!row && sessionId) {
      row = await repo.getSandboxBySessionForControl(sessionId, run)
    }
  }
  if (row) {
    return {
      adapter: row.adapter,
      mode: row.mode,
      sandboxId: sessionId,
      resourceId: row.resourceId ?? "",
      runtimeId: row.id,
      pairingSessionId: row.pairingSessionId ?? undefined,
      hostPid: row.hostPid ?? undefined,
      // R3.6: carry the durable pid-identity token so the cross-process kill path
      // signals host_pid ONLY when the live pid still matches (PID-reuse-safe).
      hostPidIdentity: row.hostPidIdentity,
    }
  }
  // No owning sandbox row resolvable (crash before the sandbox was minted, or a
  // mount with no runtime yet) → nothing killable. The sandboxes row is the sole
  // mount→runtime identity.
  return null
}

/**
 * Source the runtime id from a session's mounts via the back-filled sandbox_id
 * (== runtimeId) — the mount's sole runtime identity. "" when no mount has one yet.
 */
function runtimeIdFromMounts(mounts: FileMountRow[]): string {
  return mounts.find((m) => m.sandboxId)?.sandboxId ?? ""
}

/**
 * TRISTATE liveness (R3.4) of the runtime behind a session's mounts. Prefers the
 * in-process handle (cheap); otherwise rebuilds a SandboxRef via the STATE-AGNOSTIC
 * control-path resolver and probes via the owning adapter (docker inspect / pid
 * identity). Crucially it NO LONGER collapses a probe failure to "dead": a
 * transport/daemon error or an unverifiable pid returns 'unknown', so callers can
 * SHIELD (preserve tracking + persisted state) instead of destructively reaping a
 * sandbox they merely couldn't reach. Only a STRUCTURAL absence (no killable ref)
 * returns 'dead' here.
 */
export async function isSandboxRuntimeAlive(
  mounts: FileMountRow[],
  opts: { run?: Executor; dockerSpawnImpl?: SpawnImpl } = {}
): Promise<SandboxLiveness> {
  const sessionId = mounts[0]?.sessionId
  if (sessionId) {
    const live = liveSandboxHandles.get(sessionId)
    if (live) {
      try {
        return await live.probeLiveness()
      } catch {
        // The in-process probe itself threw → we could not determine liveness.
        return "unknown"
      }
    }
  }
  const ref = await buildSandboxRefFromSandboxRow(
    mounts,
    opts.run ?? repo.defaultDbh()
  )
  // No killable ref (crash before mint, or a mount with no runtime) → structural
  // absence: there is nothing to keep alive, so 'dead' is safe (not 'unknown').
  if (!ref) return "dead"
  try {
    const handle = await adapterForKind(ref, opts.dockerSpawnImpl).connect(ref)
    return await handle.probeLiveness()
  } catch {
    // Could not even connect/probe (e.g. docker CLI missing) → unknown, NOT dead.
    return "unknown"
  }
}

/** Injectable seam for {@link isSandboxRuntime} / {@link sandboxUnauthorizedDeny}
 *  so the sandbox-vs-device discriminator is unit-testable without a DB. */
export interface SandboxRuntimeLookupDeps {
  getSandboxById?: (
    id: string,
    run?: Executor
  ) => Promise<repo.SandboxRow | null>
}

/**
 * Discriminator: is this runtime a SANDBOX (runtimes.kind='sandbox') rather than
 * a real paired device? The CTI `sandboxes` detail row shares its primary key
 * with the `runtimes` supertype (sandboxes.id = runtimes.id, fk_sandboxes_runtime_root),
 * so a resolvable sandboxes row for `runtimeId` means kind='sandbox'; no row (a
 * device, or an unknown id) means it is not a sandbox.
 */
export async function isSandboxRuntime(
  runtimeId: string,
  deps: SandboxRuntimeLookupDeps = {}
): Promise<boolean> {
  if (!runtimeId) return false
  const getRow = deps.getSandboxById ?? repo.getSandboxById
  return (await getRow(runtimeId)) !== null
}

export interface SandboxUnauthorizedDeny {
  code: "permission_denied"
  message: string
}

/**
 * PRE-AUTHORIZED-ONLY gate (owner decision, P5c/d): ephemeral sandboxes do NOT
 * use async human approval. When a tool call finds no matching grant AND the
 * target runtime is a SANDBOX, dispatch must fail SYNCHRONOUSLY in-turn
 * (permission_denied) instead of minting a runtime-authorization REQUEST — a
 * sandbox request would (i) need a control-plane approval session the bare plane
 * never has and (ii) target a runtime the turn-end teardown soft-deletes before
 * anyone could approve it. Real devices are unaffected: returns null for a
 * device runtime so the caller keeps the existing async approval-request path.
 *
 * CROSS-FILE HOOK (the branch point lives in capability-projection, which this
 * agent does not own): capability-projection/service.ts `requestAuthorizationOrDeny`
 * (invoked from the `claim.kind === "no_match"` branch of dispatchRuntimeTool)
 * must call this FIRST and, when it returns non-null, return
 * `synapseErrorBlock({ code: "permission_denied", message })` INSTEAD of calling
 * `createRuntimeAuthorizationRequest(...)`.
 */
export async function sandboxUnauthorizedDeny(
  runtimeId: string,
  runtimeCapabilityId: string,
  deps: SandboxRuntimeLookupDeps = {}
): Promise<SandboxUnauthorizedDeny | null> {
  if (!(await isSandboxRuntime(runtimeId, deps))) return null
  return {
    code: "permission_denied",
    message:
      `sandbox capability ${runtimeCapabilityId} is not pre-authorized for ` +
      `this call; ephemeral sandboxes require pre-authorization (no async approval)`,
  }
}

/**
 * Startup reconciler: tear down sandboxes left dangling by a crash so the next
 * turn re-provisions cleanly. teardownSandbox() resolves a killable SandboxRef
 * from the owning `sandboxes` row (via the mount's sandbox_id, state-agnostic —
 * {@link buildSandboxRefFromSandboxRow}), reading adapter / resource_id / host_pid
 * off THAT row (P3 — the mount no longer carries them). The recovery matrix:
 *
 *   sandboxes.state   resource_id  →  teardown action
 *   ---------------   -----------     ------------------------
 *   (no row yet)      —               nothing to kill; close mounts
 *   provisioning      set             docker rm by resource id; close mounts
 *   active            set/null        normal teardown (commit→kill runtime)
 *   failed/closing    set/null        state-agnostic resolve still kills it
 *
 * Label-only orphans — a container the API `docker run` started but crashed
 * BEFORE the sandboxes row was minted (docker pre-bootstrap), so no row can build a
 * killable ref — are reaped separately via {@link reapDockerSandboxOrphans}, which
 * scans `docker ps` by the session LABEL and removes any whose session isn't in the
 * live set. Only runs when the docker adapter has history. Bounded; best-effort; logs.
 */
/**
 * Deps for reconcileSandboxes — all default to production. The reaper-survival
 * pin injects `executor` (a testcontainer handle so the REAL
 * listReconcileCandidateSessionIds + buildSandboxRefFromSandboxRow run against
 * fixtures) + `dockerSpawnImpl` (the LOWEST docker seam: `docker inspect`/`ps`).
 * Per CORRECTION 9 we do NOT inject isAlive — it runs for real so a
 * CORRECTION-1/4/5 ref-resolution regression is actually caught.
 */
export interface ReconcileSandboxesDeps {
  executor?: Executor
  dockerSpawnImpl?: SpawnImpl
  /** Override the candidate enumeration (defaults to the REAL repo reader). */
  listCandidates?: (run: Executor) => Promise<string[]>
  /** Override the orphan reap (defaults to the REAL reapDockerSandboxOrphans). */
  reap?: (live: Set<string>) => Promise<{ removed: string[] }>
}

export async function reconcileSandboxes(
  deps: ReconcileSandboxesDeps = {}
): Promise<void> {
  const run = deps.executor ?? repo.defaultDbh()
  const listCandidates =
    deps.listCandidates ?? repo.listReconcileCandidateSessionIds
  const reap =
    deps.reap ??
    ((live: Set<string>) =>
      reapDockerSandboxOrphans(live, { spawnImpl: deps.dockerSpawnImpl }))
  const sessionIds = await listCandidates(run)
  // Compute the docker-orphan reap gate BEFORE the teardown loop below closes any
  // pre-bootstrap orphan's mounts. hasDockerMountHistory's live-mount arm (its ONLY
  // signal for a container whose sandboxes row was never minted — the pre-bootstrap
  // crash window) reads live file_mounts; teardownSandbox() closes those mounts, so
  // deferring this read until after the loop would erase the signal and leak the
  // labeled orphan (adversarial-review finding, P3d regression).
  const shouldReapDockerOrphans =
    config.sandbox.provider === "docker" ||
    (await repo.hasDockerMountHistory(run))
  const liveSessionIds = new Set<string>()
  for (const sessionId of sessionIds) {
    try {
      const mounts = await getActiveMountsForSession(run, sessionId)
      // The authoritative sandbox row (STATE-AGNOSTIC control resolver). Its state
      // — not merely mount presence — decides shield vs reap (R3.5).
      const sandboxRow = await repo.getSandboxBySessionForControl(
        sessionId,
        run
      )
      const nonTerminal =
        !!sandboxRow &&
        sandboxRow.state !== "closed" &&
        sandboxRow.state !== "failed"
      if (mounts.length === 0) {
        // R3.5: a mount-less candidate came from the sandbox-arm of the union — a
        // sandbox row with no live mounts. At startup (the only reconcile caller)
        // that is a crash orphan; if its row is non-terminal, tear it down so a
        // leaked runtime/container doesn't linger. A session with NO row (and no
        // mounts) is a true no-op.
        if (nonTerminal) {
          log.warn(
            { sessionId, state: sandboxRow!.state },
            "reconcile: tearing down mount-less non-terminal sandbox"
          )
          await teardownSandbox(sessionId, { executor: deps.executor })
        }
        continue
      }
      const allActive = mounts.every((m) => m.status === "active")
      // R3.5: shield ONLY a genuinely-'active' sandbox. A provisioning/closing/
      // failed sandbox (even with live mounts) is NOT reusable — route it to
      // teardown so it converges instead of being reused/shielded forever.
      const stateActive = sandboxRow?.state === "active"
      const liveness: SandboxLiveness =
        allActive && stateActive
          ? await isSandboxRuntimeAlive(mounts, {
              run,
              dockerSpawnImpl: deps.dockerSpawnImpl,
            })
          : "dead"
      if (allActive && stateActive && liveness !== "dead") {
        // Healthy + (alive OR unknown) — keep it and shield its container from the
        // orphan reaper below. R3.4: a transient probe error ('unknown') must NOT
        // reap a possibly-live sandbox, so it shields exactly like 'alive'.
        liveSessionIds.add(sessionId)
        continue
      }
      log.warn(
        { sessionId, allActive, state: sandboxRow?.state, liveness },
        "reconcile: tearing down stale session"
      )
      // Thread the RAW injected executor: in prod deps.executor is undefined so
      // teardown falls through to its own defaults (behaviour-preserving); in the
      // reaper test it is the pinned trx so teardown's WRITE path runs on the same
      // connection the fixtures + assertions use.
      await teardownSandbox(sessionId, { executor: deps.executor })
    } catch (err) {
      log.error({ sessionId, err }, "reconcile failed")
    }
  }

  // Reap label-only Docker orphans (the crash window the DB sweep above can't see),
  // using the gate captured BEFORE the teardown loop. We must NOT gate solely on the
  // CURRENT config being docker: a host that ran docker sandboxes and then fell back
  // to local (or crashed pre-bootstrap and restarted local) would otherwise leak
  // every container. Pure-local deployments with no docker evidence skip the docker
  // call entirely.
  if (shouldReapDockerOrphans) {
    try {
      const { removed } = await reap(liveSessionIds)
      if (removed.length > 0) {
        log.warn({ removed }, "reconcile: reaped label-only docker orphan(s)")
      }
    } catch (err) {
      log.error({ err }, "reconcile: docker orphan reap failed")
    }
  }

  // (R4 §1.7 / #3) Off-box provider orphan sweep — DELETE cube VMs tagged as ours
  // but no longer tracked by a live DB row (crash-between-create-and-mint leaks +
  // post-teardown stragglers the docker/DB sweeps can't see). No-op unless the
  // configured provider is off-box. Self-contained fault handling; wrapped anyway.
  try {
    const { reaped } = await reapOffBoxSandboxOrphans({
      executor: deps.executor,
    })
    if (reaped > 0) {
      log.warn({ reaped }, "reconcile: reaped off-box provider orphan(s)")
    }
  } catch (err) {
    log.error({ err }, "reconcile: off-box orphan sweep failed")
  }
}

const loadSessionContext = repo.loadSessionContext

export interface ReapStuckProvisioningResult {
  scanned: number
  reaped: number
}

/**
 * R3.P2b — periodic TTL reaper for sandboxes STUCK in 'provisioning' past their
 * deadline_at (a provisionSandbox that crashed/hung before its CAS active flip).
 * RESTRICTED to state='provisioning' ONLY (the idx_sandboxes_reap partial index) —
 * active/closing are boot-reconcile's job, NEVER this periodic sweep.
 *
 * For each stuck row it does a CAS 'provisioning'→'failed' (so a provision that
 * flips to 'active' at the same instant WINS and the reaper no-ops on it — the
 * race-closer paired with {@link provisionSandbox}'s casFlipSandboxActive), then
 * revokes its grants + marks its mounts 'failed' + best-effort kills the
 * in-process handle if THIS process happens to hold one. It NEVER calls the
 * liveness-based teardown (host-scoped, boot-only) and never touches an
 * active/closing row. Best-effort + idempotent.
 */
export async function reapStuckProvisioningSandboxes(
  deps: {
    executor?: Executor
  } = {}
): Promise<ReapStuckProvisioningResult> {
  const run = deps.executor ?? repo.defaultDbh()
  const stuck = await repo.listStuckProvisioningSandboxes(run)
  let reaped = 0
  for (const row of stuck) {
    try {
      const flipped = await repo.casFailStuckProvisioningSandbox(
        row.id,
        "provisioning exceeded deadline_at (TTL reaped)",
        run
      )
      if (!flipped) continue // a concurrent active-flip won; leave it.
      reaped += 1
      // Best-effort kill the in-process handle if this process holds one.
      if (row.sessionId) {
        const handle = liveSandboxHandles.get(row.sessionId)
        if (handle) {
          await handle.kill().catch(() => {})
          liveSandboxHandles.delete(row.sessionId)
        }
        // Revoke grants (need the session's actor/conversation context).
        const ctx = await loadSessionContext(row.sessionId, run)
        if (ctx) {
          await revokeSandboxGrants({
            workspaceId: ctx.workspaceId,
            runtimeId: row.id,
            actorId: ctx.actorId,
            conversationId: ctx.conversationId,
            executor: run,
          }).catch(() => {})
        }
        // Mark its live mounts 'failed' (preserve dirs — nothing to commit yet, but
        // don't leave them 'provisioning' forever).
        const mounts = await getActiveMountsForSession(run, row.sessionId)
        for (const mount of mounts) {
          await updateFileMount(run, mount.id, {
            status: "failed",
            errorMessage: "sandbox provisioning TTL-reaped",
          }).catch(() => {})
        }
      }
      // E-1: converge the runtime — soft-delete it (CASCADEs any remaining grants),
      // matching teardownSandbox. Without this the CAS-'failed' runtimes row lingers
      // with deleted_at IS NULL forever (reconcile excludes 'failed', reuse requires
      // 'active') — an unbounded accumulation. Runs regardless of sessionId.
      await deleteRuntime(row.workspaceId, row.id, run).catch((err) =>
        log.error(
          { sandboxId: row.id, err },
          "reaper soft-delete runtime failed"
        )
      )
    } catch (err) {
      log.error(
        { sandboxId: row.id, err },
        "reapStuckProvisioningSandboxes failed for a row"
      )
    }
  }
  return { scanned: stuck.length, reaped }
}

/** Grace before a 'closing' sandbox is retried — long enough that a normal
 *  in-flight teardown (seconds) is never disturbed, short enough to converge a
 *  genuinely-stuck row without waiting for the next process restart. */
const CLOSING_RETRY_GRACE_SECONDS = 180

/**
 * F3 — periodic fail-closed retry for sandboxes STUCK in 'closing'. teardownSandbox
 * preserves a sandbox in 'closing' (rather than committing + soft-deleting) whenever
 * its post-kill liveness probe is 'alive' or 'unknown' — the deliberate PID-reuse-
 * safe / no-orphan choice. Without a periodic nudge such a row only reconverges at
 * the next process restart (reconcileSandboxes is boot-only). This re-drives the
 * FULL teardown for each stuck row: it re-probes and converges the instant the
 * runtime is CONFIRMED dead (a restarted API loses the in-process plane, so a
 * local:bare row converges immediately), and otherwise re-preserves + re-alerts —
 * never force-orphaning a possibly-live runtime. The close-gate bumps updated_at on
 * each pass, so this also paces the retry cadence.
 */
export async function retryStuckClosingSandboxes(
  deps: {
    executor?: Executor
  } = {}
): Promise<{ scanned: number; retried: number }> {
  const run = deps.executor ?? repo.defaultDbh()
  const stuck = await repo.listReapableClosingSandboxSessions(
    CLOSING_RETRY_GRACE_SECONDS,
    run
  )
  let retried = 0
  for (const row of stuck) {
    try {
      // (R5 #3) Pin the SPECIFIC 'closing' runtime so teardown converges IT, never
      // the newest (possibly re-provisioned) sandbox for the session.
      await teardownSandbox(row.sessionId, {
        executor: deps.executor,
        runtimeId: row.runtimeId,
      })
      retried += 1
    } catch (err) {
      log.error(
        { sessionId: row.sessionId, runtimeId: row.runtimeId, err },
        "retryStuckClosingSandboxes teardown re-drive failed"
      )
    }
  }
  return { scanned: stuck.length, retried }
}

/**
 * (R4 §1.7) Age grace for the off-box orphan sweep: a provider VM younger than
 * this is NEVER reaped — its mint may simply not have committed yet (the
 * create→mint race), and a genuinely-leaked young VM is caught by the create TTL.
 * Sized comfortably above a full provision cycle (create + working-set push +
 * active flip). The keepalive keeps in-use VMs out of the candidate set entirely.
 */
const OFFBOX_ORPHAN_MIN_AGE_MS = 600_000

/** (R5 #4) How long a 'closing' off-box VM with failed-recoverable mounts is kept
 *  alive (TTL refreshed) while recovery retries. Past this window the keepalive
 *  stops and the provider TTL reclaims a genuinely un-recoverable VM — bounded
 *  provider spend, no infinite renew. ~one TTL window. */
const RECOVERY_KEEPALIVE_WINDOW_SECONDS = 1800

/** (R5 #4, review-fix) Hard cap on off-box recovery re-drives for a stuck 'closing'
 *  row. teardown_epoch bumps on every close-gate flip — the initial teardown plus
 *  each closing-retry-reaper re-drive (~every CLOSING_RETRY_GRACE_SECONDS) — so this
 *  bounds how many times a failed-recoverable VM is kept alive before the keepalive
 *  stops (TTL reclaims the VM) and teardown converges terminal (accepts the loss +
 *  alerts). ~20 re-drives keeps provider spend under a bounded window per stuck VM,
 *  rather than the infinite renew an updated_at-only window allowed. */
const MAX_OFFBOX_RECOVERY_ATTEMPTS = 20

/** (R6 H-2) How long a recovery LEASE ('recovering' status) is honored before a
 *  crashed worker's claim is reclaimable by another sweep. Sized well above a normal
 *  reconnect+pull+commit (which the 600s envd stream timeout already bounds per file)
 *  so a healthy in-flight recovery is never stolen mid-pull. */
const RECOVERY_LEASE_TTL_SECONDS = 600

/** Resolve the CURRENTLY-configured adapter when it is off-box, else null. Shared
 *  by the off-box sweep + keepalive so both target the same provider. Injectable.
 *  (#13) Returns the NARROWED OffBoxBareAdapter so the sweep/keepalive call the
 *  off-box lifecycle methods without a truthiness guard. */
function configuredOffBoxAdapter(
  injected?: SandboxAdapter | null
): OffBoxBareAdapter | null {
  const adapter =
    injected !== undefined
      ? injected
      : resolveSandboxAdapter(config.sandbox.provider, config.sandbox.mode)
  return adapter && isOffBoxAdapter(adapter) ? adapter : null
}

export interface OffBoxOrphanSweepResult {
  scanned: number
  reaped: number
}

/**
 * (R4 §1.7 / #3) Off-box provider orphan sweep — the provider analogue of the
 * docker label reaper. For the configured off-box adapter, DELETE provider VMs
 * tagged as ours (provenance) whose resource id is NOT in the live/non-terminal
 * DB set and older than the grace: crash-between-create-and-mint leaks, plus any
 * post-teardown straggler whose row already went terminal. Best-effort and
 * per-orphan fault-tolerant; a listing failure reaps NOTHING (fail-safe, never
 * fail-destructive). No-op for host/resident/none providers (no self-managed
 * provider resources) and when the adapter lacks the orphan seams.
 */
export async function reapOffBoxSandboxOrphans(
  deps: {
    executor?: Executor
    adapter?: SandboxAdapter | null
    minAgeMs?: number
    /** Override the live/non-terminal resource-id reader (defaults to the repo). */
    listActiveResourceIds?: (
      adapter: string,
      run: Executor
    ) => Promise<string[]>
  } = {}
): Promise<OffBoxOrphanSweepResult> {
  const adapter = configuredOffBoxAdapter(deps.adapter)
  // (#13) off-box narrowed by configuredOffBoxAdapter → listOrphans/destroyResource
  // are type-guaranteed; only the "no off-box provider configured" null remains.
  if (!adapter) {
    return { scanned: 0, reaped: 0 }
  }
  const run = deps.executor ?? repo.defaultDbh()
  const minAgeMs = deps.minAgeMs ?? OFFBOX_ORPHAN_MIN_AGE_MS
  const listActive =
    deps.listActiveResourceIds ?? repo.listNonTerminalSandboxResourceIds
  let scanned = 0
  let reaped = 0
  try {
    const activeResourceIds = new Set(await listActive(adapter.meta.tag, run))
    const orphans = await adapter.listOrphans({ activeResourceIds, minAgeMs })
    scanned = orphans.length
    for (const orphan of orphans) {
      try {
        await adapter.destroyResource(orphan.resourceId)
        reaped += 1
        log.warn(
          { adapter: adapter.key, resourceId: orphan.resourceId },
          "off-box orphan sweep: destroyed untracked provider VM"
        )
      } catch (err) {
        log.error(
          { adapter: adapter.key, resourceId: orphan.resourceId, err },
          "off-box orphan destroy failed (will retry next sweep)"
        )
      }
    }
  } catch (err) {
    log.error({ adapter: adapter.key, err }, "off-box orphan sweep failed")
  }
  return { scanned, reaped }
}

export interface OffBoxKeepAliveResult {
  refreshed: number
  failed: number
}

/**
 * (R4 §1.7 keepalive) Push the hard provider auto-destroy deadline forward for
 * every IN-USE (provisioning/active) off-box VM, so a live session's VM never
 * self-destructs mid-session between maintenance ticks. This is what makes a
 * finite create TTL safe: an active session is continuously refreshed while an
 * ABANDONED VM (no keepalive owner — crashed API, orphaned create) expires within
 * one TTL as the paid-resource backstop. Best-effort per VM.
 */
export async function keepAliveOffBoxSandboxes(
  deps: {
    executor?: Executor
    adapter?: SandboxAdapter | null
    /** Override the in-use resource-id reader (defaults to the repo). */
    listInUseResourceIds?: (adapter: string, run: Executor) => Promise<string[]>
  } = {}
): Promise<OffBoxKeepAliveResult> {
  const adapter = configuredOffBoxAdapter(deps.adapter)
  // (#13) refreshResourceDeadline is type-guaranteed on the narrowed off-box adapter.
  if (!adapter) {
    return { refreshed: 0, failed: 0 }
  }
  const run = deps.executor ?? repo.defaultDbh()
  const listInUse =
    deps.listInUseResourceIds ??
    ((tag: string, r: Executor) =>
      repo.listKeepAliveSandboxResourceIds(
        tag,
        RECOVERY_KEEPALIVE_WINDOW_SECONDS,
        MAX_OFFBOX_RECOVERY_ATTEMPTS,
        r
      ))
  let resourceIds: string[]
  try {
    resourceIds = await listInUse(adapter.meta.tag, run)
  } catch (err) {
    log.error(
      { adapter: adapter.key, err },
      "off-box keepalive: candidate query failed"
    )
    return { refreshed: 0, failed: 0 }
  }
  let refreshed = 0
  let failed = 0
  for (const resourceId of resourceIds) {
    try {
      await adapter.refreshResourceDeadline(resourceId)
      refreshed += 1
    } catch (err) {
      failed += 1
      log.warn(
        { adapter: adapter.key, resourceId, err },
        "off-box keepalive: deadline refresh failed"
      )
    }
  }
  return { refreshed, failed }
}

/** Per-session sandbox root: <STORAGE_DIR>/sandboxes/<sessionId>. */
function sandboxRootFor(sessionId: string): string {
  return join(STORAGE_DIR, "sandboxes", sessionId)
}

function storageVolumeMountPoint(): string {
  return config.sandbox.docker.storageVolumeMount
}

/**
 * Pure layout computation (exported for the compose-layout test): the sandbox
 * root expressed RELATIVE to the storage volume's mount point. With
 * storageDir=/app/storage/files and mountPoint=/app/storage this yields
 * `files/sandboxes/<id>`. Throws if the root is not under the mount point.
 */
export function toSandboxVolumeSubpath(input: {
  storageDir: string
  mountPoint: string
  sessionId: string
}): string {
  const root = join(input.storageDir, "sandboxes", input.sessionId)
  const rel = relative(input.mountPoint, root)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxServiceError(
      `STORAGE_DIR (${input.storageDir}) is not under the sandbox storage ` +
        `volume mount point (${input.mountPoint}); set ` +
        `SANDBOX_DOCKER_STORAGE_VOLUME_MOUNT so volume-subpath can be derived. ` +
        `Computed relative path: '${rel}'`,
      500
    )
  }
  // Always POSIX separators — the path is consumed by the Linux container's
  // docker engine (host separator is POSIX here too, but normalize defensively).
  return rel.split(/[\\/]/).join("/")
}

function brokerDirFor(sessionId: string): string {
  return join(sandboxRootFor(sessionId), ".broker")
}
function mountDir(sessionId: string, subpath: MountSubpath): string {
  return join(sandboxRootFor(sessionId), subpath)
}

interface SpaceSpec {
  subpath: MountSubpath
  spaceId: string
  baseSnapshotId: string | null
  baseManifestSha: string | null
}

/** The three runtime spaces for a session (ensured + base snapshot resolved). */
async function ensureSessionSpaces(ctx: SessionContext): Promise<SpaceSpec[]> {
  const specs: Array<{ subpath: MountSubpath; ensure: () => Promise<string> }> =
    [
      {
        subpath: "conversation",
        ensure: async () =>
          (
            await ensureFileSpace(repo.defaultDbh(), {
              workspaceId: ctx.workspaceId,
              owner: conversationRef(ctx.conversationId),
            })
          ).id,
      },
      {
        subpath: "actor",
        ensure: async () =>
          (
            await ensureFileSpace(repo.defaultDbh(), {
              workspaceId: ctx.workspaceId,
              owner: actorRef(ctx.actorId),
            })
          ).id,
      },
      {
        subpath: "actor-conversation",
        ensure: async () =>
          (
            await ensureFileSpace(repo.defaultDbh(), {
              workspaceId: ctx.workspaceId,
              owner: actorRef(ctx.actorId),
              scope: conversationRef(ctx.conversationId),
            })
          ).id,
      },
    ]

  const out: SpaceSpec[] = []
  for (const s of specs) {
    const spaceId = await s.ensure()
    const space = await getFileSpace(repo.defaultDbh(), spaceId)
    const baseSnapshotId = space?.currentSnapshotId ?? null
    const baseManifestSha = baseSnapshotId
      ? await getSnapshotManifestSha(repo.defaultDbh(), baseSnapshotId)
      : null
    out.push({ subpath: s.subpath, spaceId, baseSnapshotId, baseManifestSha })
  }
  return out
}

export interface ProvisionSandboxOptions {
  /** Inject a HostProvider (local adapter wraps it). Test seam. */
  hostProvider?: HostProvider
  /** Max ms to wait for the runtime catalog to sync. */
  catalogTimeoutMs?: number
  /**
   * Max ms to wait for the runtime's tunnel endpoint to register in the
   * RuntimeEndpointRegistry (after catalog). A sandbox whose endpoint never
   * registers can't dispatch ANY tool, so provision fails+cleans rather than
   * marking such mounts active. Default 30s; set 0 to skip the wait (only for
   * tests that don't dispatch).
   */
  tunnelTimeoutMs?: number
  createdByWorkspaceMemberId?: string | null
}

/**
 * Provision a sandbox for a session's first turn (idempotent: a no-op if the
 * session already has active mounts). Ordered to satisfy the two-layer auth
 * dependency: materialize → pair+run → wait for catalog → build both grant
 * layers → mark mounts active.
 */
export async function provisionSandbox(
  sessionId: string,
  options: ProvisionSandboxOptions = {}
): Promise<SandboxProvisionResult> {
  const existing = await getActiveMountsForSession(repo.defaultDbh(), sessionId)
  // Fast path only when ALL mounts are 'active' (not mid-provision/commit) AND
  // the runtime is actually alive. getActiveMountsForSession returns the LIVE
  // set (status NOT IN closed/failed/recovering) which also includes 'provisioning';
  // short-circuiting on a non-'active' mount would hand back a half-built or
  // tearing-down sandbox. A dead runtime behind active mounts means the daemon
  // crashed — we recover by tearing the stale device down and re-provisioning
  // (the materialized live dirs are preserved across teardown's commit path).
  const allActive =
    existing.length > 0 && existing.every((m) => m.status === "active")
  // Fast path also requires a DISPATCHABLE tunnel endpoint, not just a live
  // runtime. After an API restart the in-memory RuntimeEndpointRegistry is empty
  // even though the runtime/container is still alive and reconnecting over the
  // control-plane; returning here would hand back a sandbox whose every
  // dispatchSyncTool call fails with no_tunnel_endpoint. So when the runtime is
  // alive we additionally wait (briefly) for the device_runtime service to
  // re-register its endpoint. If it never does, we DON'T fast-path — we fall
  // through to the stale-mount teardown + re-provision below.
  let fastPathOk = false
  // R3.4: reuse on 'alive' OR 'unknown' (a transient probe error must NOT force a
  // destructive teardown + reprovision of a possibly-live sandbox — the endpoint
  // wait below is the real reuse gate). Only a confirmed 'dead' runtime declines.
  const liveness: SandboxLiveness =
    existing.length > 0 && allActive
      ? await isSandboxRuntimeAlive(existing)
      : "dead"
  if (existing.length > 0 && allActive && liveness !== "dead") {
    const runtimeIdForEndpoint = runtimeIdFromMounts(existing)
    // R3.5 reuse-gate (the load-bearing convergence fix): only fast-path a
    // genuinely 'active' sandbox. A row still 'provisioning' or already 'closing'/
    // 'failed' must NOT be reused — fall through to the stale-mount teardown +
    // re-provision below. A null row (shouldn't happen for a live all-active
    // sandbox) is fail-safe → declines the fast path.
    const sandboxRow = runtimeIdForEndpoint
      ? await repo.getSandboxById(runtimeIdForEndpoint)
      : null
    if (sandboxRow?.state === "active") {
      // (R5 #2 = Option B) OFF-BOX sandboxes are NOT reused across turns. A reused
      // cube VM diverges from the host mirror between turns (background writers +
      // no host-side conflict detection), and the per-turn refresh/commit only touch
      // the host mirror — so a naive per-turn PUSH/PULL would clobber uncommitted VM
      // work. Instead each off-box turn does a clean teardown (PULL VM→mirror +
      // commit) + cold reprovision (re-materialize head + replicate-only PUSH), which
      // round-trips through CAS with the existing primitives. So DECLINE the fast path
      // for off-box → fall through to the stale-mount teardown + cold provision below.
      // Host bare/resident keep VM/process reuse (their plane IS the host mirror).
      let offBox = false
      try {
        offBox = isOffBoxAdapter(
          adapterForRow(sandboxRow.adapter, sandboxRow.mode)
        )
      } catch {
        offBox = false
      }
      if (!offBox) {
        // Mode gates the endpoint probe: 'bare' has no device_runtime service to
        // resolve (P4), 'resident' must wait for its tunnel endpoint.
        fastPathOk = await fastPathEndpointReady({
          sessionId,
          runtimeId: runtimeIdForEndpoint,
          mode: sandboxRow.mode,
          tunnelTimeoutMs: options.tunnelTimeoutMs ?? 30_000,
        })
      }
    }
  }
  if (fastPathOk) {
    // Already provisioned this session — report the ACTUAL state, not a
    // hardcoded false. Use the SAME source of truth as the cold provision path
    // (resolveRuntimeBuiltinIds → commandlineCapabilityId != null): an ACTIVE
    // commandline capability joined to its exposure, not merely a row in
    // runtime_exposures. A bare exposure check is looser — it would report
    // commandline "enabled" for a device whose capability was revoked or whose
    // exposure never went healthy, misleading the UI/caller.
    const runtimeId = runtimeIdFromMounts(existing)
    let commandlineEnabled = false
    if (runtimeId) {
      try {
        const builtins = await resolveRuntimeBuiltinIds(runtimeId)
        commandlineEnabled = builtins.commandlineCapabilityId != null
      } catch {
        // resolveRuntimeBuiltinIds throws only when the filesystem capability is
        // absent (catalog not synced) — for a live, all-active sandbox that
        // shouldn't happen, but treat it as "no commandline" rather than fail
        // the fast path.
        commandlineEnabled = false
      }
    }
    // P1/P2: do NOT hardcode sidecarRestoreOk=true on the fast path. A prior
    // provision this session may have failed to restore some sidecars (e.g. the
    // mount for a sidecar's subpath wasn't active yet, or a transient fs error)
    // while still marking the OTHER mounts active — so this fast path would
    // otherwise report "all restored" and let the worker clear a pending notice
    // whose on-disk copy never came back. Re-attempt the restore every provision:
    // it's idempotent and a cheap no-op when the pending stores are empty (a
    // single peek of collaboration_state), and self-heals once the needed mount
    // is active. Surface the real ok + failed leaves.
    let sidecarRestoreOk = true
    let failedSidecars: SidecarRestoreFailure[] = []
    try {
      const restore = await restorePendingSidecars(sessionId, existing)
      sidecarRestoreOk = restore.ok
      failedSidecars = restore.failedSidecars
    } catch (err) {
      // P2: a WHOLE-restore exception (e.g. a DB read in the peek path threw)
      // never populated the per-sidecar list. If we returned an empty
      // failedSidecars with ok=false, the worker — which partitions purely by the
      // failed set — would treat every pending sidecar as restored and tell the
      // agent to "read it" against a path that may not exist. Pessimistically
      // mark ALL pending sidecars as (transiently) unrestored so none is
      // presented as readable. Best-effort: if even this collection throws, fall
      // back to an empty list but keep ok=false.
      sidecarRestoreOk = false
      console.error(
        `[sandbox] failed to restore pending sidecars (fast path) for ${sessionId}:`,
        err
      )
      failedSidecars = await collectAllPendingSidecarPaths(sessionId)
        .then((paths) =>
          paths.map((sidecar) => ({
            sidecar,
            reason: "transient" as const,
          }))
        )
        .catch(() => [])
    }
    return {
      sessionId,
      sandboxRoot: sandboxRootFor(sessionId),
      runtimeId: runtimeId,
      commandlineEnabled,
      mountIds: existing.map((m) => m.id),
      sidecarRestoreOk,
      failedSidecars,
    }
  }

  // There are live mounts but the fast path declined them: a prior provision
  // crashed mid-flight, the runtime died behind active mounts, OR the runtime is
  // alive but never re-registered a dispatchable tunnel endpoint (post-restart).
  // Recover by tearing the stale sandbox down first — teardown commits any dirty
  // state, kills the (possibly dead) runtime via the persisted adapter, and
  // closes the mounts — so the fresh provision below starts from a clean slate.
  // Live dirs are preserved by teardown's commit path; their content is
  // re-materialized from CAS on re-provision.
  if (existing.length > 0) {
    // (R5 #7) BACK-OFF guard against the double-create race. provisionSandbox is
    // called inside the Redis session lock; the only same-session overlap is a
    // lock-expiry window where a SECOND worker enters while the first's provision is
    // still in flight. The first leaves fresh 'provisioning' mounts + a young sandbox
    // row within its deadline. Tearing those down here would KILL the first's fresh
    // VM (orphan) and fail it. So when the existing mounts belong to a genuinely
    // in-flight provision (a 'provisioning' row still within its deadline), do NOT
    // tear it down — fail retryable and let it complete. A crashed/stale provision
    // (past deadline) or an 'active' prior turn falls through to the teardown below.
    if (existing.some((m) => m.status === "provisioning")) {
      // (R6 H-3) Resolve the in-flight row by SESSION_ID, NOT via runtimeIdFromMounts
      // (mount.sandbox_id). sandbox_id is back-filled onto the mount only AFTER the
      // sandboxes row is minted inside the adapter's create(); during that window
      // runtimeIdFromMounts(existing) is null, so the old guard saw no in-flight row and
      // fell through to teardownSandbox — killing the first worker's fresh VM (the
      // double-create → unsandboxed turn). A session-scoped lookup sees the
      // 'provisioning' row the instant it exists.
      const inflight = await repo.getSandboxBySessionForControl(sessionId)
      if (
        inflight?.state === "provisioning" &&
        inflight.deadlineAt &&
        inflight.deadlineAt.getTime() > Date.now()
      ) {
        throw new SandboxServiceError(
          `session ${sessionId}: a provision is already in progress (retry)`,
          409
        )
      }
    }
    console.warn(
      `[sandbox] session ${sessionId} has ${existing.length} stale/dead mount(s); tearing down before re-provision`
    )
    await teardownSandbox(sessionId).catch((err) =>
      console.error(
        `[sandbox] stale-mount teardown failed for ${sessionId} (continuing to re-provision):`,
        err
      )
    )
  }

  const ctx = await loadSessionContext(sessionId)
  if (!ctx) throw new SandboxServiceError(`session ${sessionId} not found`, 404)

  const adapter = resolveAdapterForProvision(options)
  const fsHelperPath = resolveFsHelperPath()
  const sandboxRoot = sandboxRootFor(sessionId)

  // ② ensure spaces + ③ resolve base snapshots.
  const specs = await ensureSessionSpaces(ctx)

  // ④ insert mounts ('provisioning') + ⑤ materialize each base into a plain dir.
  await mkdir(brokerDirFor(sessionId), { recursive: true })
  const mounts: FileMountRow[] = []
  for (const spec of specs) {
    const dir = mountDir(sessionId, spec.subpath)
    await mkdir(dir, { recursive: true })
    const mount = await insertFileMount(repo.defaultDbh(), {
      workspaceId: ctx.workspaceId,
      sessionId,
      fileSpaceId: spec.spaceId,
      mountSubpath: spec.subpath,
      baseSnapshotId: spec.baseSnapshotId,
      materializedDir: dir,
    })
    mounts.push(mount)
    await materializeSnapshot({
      manifestSha256: spec.baseManifestSha ?? undefined,
      targetDir: dir,
    })
  }

  // Re-materialize any DURABLE pending conflict sidecars into the fresh live
  // dirs (round-11 #1). A prior turn's teardown deleted the old live dir, but
  // the pending commit/refresh notices on the session still point at
  // /<subpath>/.synapse-conflicts/<hash>. Rebuild each from its CAS payload
  // (file bytes by content_sha; symlink target as JSON) so the agent-visible
  // sidecar path resolves again and the preserved copy isn't orphaned.
  //
  // R12-3: if ANY sidecar failed to restore, surface it (sidecarRestoreOk=false)
  // so the worker does NOT clear the pending store after actorThink — the
  // unrestored copy stays retryable on the next provision rather than being
  // consumed against a path that doesn't exist.
  let sidecarRestoreOk = true
  let failedSidecars: SidecarRestoreFailure[] = []
  try {
    const restore = await restorePendingSidecars(sessionId, mounts)
    sidecarRestoreOk = restore.ok
    failedSidecars = restore.failedSidecars
  } catch (err) {
    // P2: same fail-closed reasoning as the fast path — a whole-restore
    // exception leaves the per-sidecar list empty, so pessimistically mark every
    // pending sidecar unrestored so the worker never tells the agent to read one.
    sidecarRestoreOk = false
    console.error(
      `[sandbox] failed to restore pending sidecars for ${sessionId}:`,
      err
    )
    failedSidecars = await collectAllPendingSidecarPaths(sessionId)
      .then((paths) =>
        paths.map((sidecar) => ({ sidecar, reason: "transient" as const }))
      )
      .catch(() => [])
  }

  // Hoisted so the catch can tear down whatever was created.
  let handle: SandboxHandle | null = null
  try {
    // ⑥ stand up the runtime via the selected adapter. Staged-persistence
    // callbacks write each fact onto ALL mounts the instant it exists so a
    // mid-provision crash leaves the startup reconciler enough to reattach or
    // safely clean up. Each callback is idempotent across the session's mounts.
    const persistAll = async (
      patch: Parameters<typeof updateFileMount>[2]
    ): Promise<void> => {
      await Promise.all(
        mounts.map((mount) =>
          updateFileMount(repo.defaultDbh(), mount.id, patch)
        )
      )
    }
    // Pairing + resource id live on the sandboxes row (docker consume sets
    // pairing_session_id; resource_id is written post-create via updateSandboxRow
    // below), and a pre-bootstrap docker container is reaped by its session LABEL
    // (reapDockerSandboxOrphans), so the mint callback only has to back-fill
    // file_mounts.sandbox_id.
    // onRuntimeReady still back-fills the mount's sole identity column, sandbox_id.
    const onRuntimeReady = (runtimeId: string): Promise<void> =>
      persistAll({ sandboxId: runtimeId })
    // (R4 §1.10) Build the DISCRIMINATED spec. The spine builds the HOST variant
    // only for a host-backed adapter (`!isOffBoxAdapter`); an OFF-BOX adapter
    // (cubesandbox) gets the core ONLY — no host path can reach it (the host-RCE
    // trap of mounting a session root into an off-box adapter is unrepresentable).
    const spec: SandboxSpec = isOffBoxAdapter(adapter)
      ? {
          offBox: true,
          sessionId,
          workspaceId: ctx.workspaceId,
          title: `Sandbox ${sessionId.slice(0, 8)}`,
          onRuntimeReady,
        }
      : {
          sessionId,
          workspaceId: ctx.workspaceId,
          sandboxRoot,
          // Docker-ONLY: where this session's root lives RELATIVE to the storage
          // volume mount (computed from STORAGE_DIR, never hardcoded). Undefined
          // for local — computing it there throws when STORAGE_DIR isn't under the
          // volume mount point (bare-metal default /tmp/synapse-storage).
          storageVolumeSubpath: sandboxSpecVolumeSubpath(adapter.provider, {
            storageDir: STORAGE_DIR,
            mountPoint: storageVolumeMountPoint(),
            sessionId,
          }),
          fsHelperPath,
          // The device dials back to the API. LOCAL adapter: SANDBOX_SERVER_ORIGIN
          // (loopback for a containerized local deploy) or config.app.baseUrl. The
          // docker adapter ignores this and builds its own origin from env.
          serverOrigin: sandboxLocalServerOrigin(),
          // ALWAYS run this per-session device in sandbox mode (--cmd-sandbox),
          // even when bwrap is unavailable. The device-runtime's --cmd-sandbox
          // branch fail-closes: bwrap present → confined commandline; bwrap absent
          // → NO commandline tool at all. `commandlineEnabled` only decides whether
          // WE pre-authorize the commandline grant, not whether the device runs
          // unconfined.
          confineCommands: true,
          title: `Sandbox ${sessionId.slice(0, 8)}`,
          onRuntimeReady,
        }
    handle = await adapter.create(spec)
    liveSandboxHandles.set(handle.sandboxId, handle)

    const runtimeId = handle.runtimeLink.runtimeId
    // CORRECTION 4 — POST-create back-fill ONLY. The sandboxes row is now
    // committed (docker: bootstrap-consumed; local: minted at create() start), so
    // this is the FIRST safe point to write file_mounts.sandbox_id (the mount's sole
    // identity) and the sandbox row's resource_id/host_pid. resource_id/host_pid live
    // ONLY on the sandboxes row now (P3) — the container id arrives before the docker
    // consume mints the row, so it is written HERE (post-create), not from
    // onResourceCreated (which would 0-row-UPDATE a not-yet-existent row).
    await persistAll({ sandboxId: runtimeId })
    // R3.6: for a LOCAL sandbox capture the child pid's durable identity token
    // ('<boot_id>:<starttime>') the instant we know the pid, so recovery/teardown
    // can signal it PID-reuse-safely. NULL for docker/off-box (no host pid) and
    // non-Linux hosts (readHostPidIdentity returns null there).
    const hostPidIdentity =
      adapter.provider === "local" && handle.hostPid !== undefined
        ? readHostPidIdentity(handle.hostPid)
        : null
    await repo.updateSandboxRow(runtimeId, {
      // R4 §1.7: an OFF-BOX adapter already wrote the AUTHORITATIVE resource_id in
      // its mint INSERT (the VM id is known before mint), closing the crash-window
      // where a '' -then-backfill would leave kill() DELETEing an empty id. Only
      // the host/resident path back-fills here (docker:resident's container id
      // genuinely arrives after the bootstrap-consume mints the row).
      resourceId: isOffBoxAdapter(adapter)
        ? undefined
        : handle.resourceId || null,
      hostPid: handle.hostPid ?? null,
      hostPidIdentity,
      // R3.P2b: stamp the provision budget so a stuck 'provisioning' row is
      // TTL-reapable, while a healthy in-flight provision (well under the budget)
      // is never touched.
      deadlineAt: new Date(Date.now() + PROVISION_DEADLINE_MS),
    })

    // ⑦/⑦b — readiness (R4 §1.5/§6.9). The catalog fork lives in the adapter's
    // ready(): resident → wait for device.catalog.sync + the tunnel endpoint to
    // register (Mode-A path, injected waiters); bare HOST (local/docker) → the API
    // already authored + persisted the catalog in create() and there is no tunnel to
    // register, so ready() is immediate; OFF-BOX (cube) → ready() negotiates control
    // reachability + an envd-version gate + a domain-suffix (SSRF-inversion) guard +
    // envd data-plane reachability before the active-flip. A `{ ok:false }` fails
    // provision (the catch tears the half-built sandbox down) rather than flipping a
    // broken sandbox active.
    const readiness = await adapter.ready(handle, {
      primaryTimeoutMs: options.catalogTimeoutMs ?? 30_000,
      reachabilityProbeTimeoutMs: options.tunnelTimeoutMs ?? 30_000,
    })
    if (!readiness.ok) {
      throw new SandboxServiceError(
        `provision for ${sessionId} failed readiness: ${readiness.reason ?? "not ready"}`,
        503
      )
    }

    // ⑦c (R4 §1.4 / §6.3, P0) — OFF-BOX PROVISION PUSH. Each mount's base was
    // materialized into its host MIRROR (materializedDir) above, but an off-box VM
    // does NOT share that dir — so replicate each mount's base INTO the VM over the
    // TOKEN-BEARING envd working-set bridge (delete-aware; a fresh VM starts empty,
    // so this is all writes). Without this the VM starts with an EMPTY working set
    // and the turn's edits are computed against nothing. Host adapters need no push
    // (their plane reads/writes the SAME <sandboxRoot>/<subpath> the fs-helper
    // materialized), so the redundant second host materialize is gated off here.
    if (isOffBoxAdapter(adapter)) {
      const pushBridge = adapter.workingSet(handle)
      try {
        for (let i = 0; i < mounts.length; i++) {
          const dir = mounts[i].materializedDir
          if (!dir) continue
          await pushBridge.applyManifest({
            manifestSha256: specs[i]?.baseManifestSha ?? undefined,
            targetDir: dir,
          })
        }
      } finally {
        // (R4 review fix) release the bridge's undici Agent (no per-push leak).
        await pushBridge.dispose?.()
      }
    }

    // ⑧ build both authorization layers (once, full capability list).
    // The device fail-closes at boot: it advertises a commandline builtin in its
    // catalog ONLY when ITS OWN host can confine commands (bwrap+userns). So the
    // resolved catalog — not a probe of the API process's PATH — is the single
    // source of truth for whether to pre-authorize the commandline grant. This
    // is correct for BOTH adapters: the local device runs on the API host, while
    // the docker device runs in the cloud-sandbox image (which has bubblewrap)
    // even though the API image ships only the docker CLI.
    const builtins = await resolveRuntimeBuiltinIds(runtimeId)
    const commandlineEnabled = builtins.commandlineCapabilityId != null
    await createSandboxGrants({
      workspaceId: ctx.workspaceId,
      runtimeId,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
      builtins,
      includeCommandline: commandlineEnabled,
      // P4a S13: a bare adapter whose descriptor declares confinedFs:'unsupported'
      // (degraded) mints a whole-sandbox-scope fs grant instead of the sub-prefix
      // one. A resident adapter has no descriptor (null) → 'native' default.
      confinedFs: adapter.capabilities?.confinedFs ?? "native",
      createdByWorkspaceMemberId: options.createdByWorkspaceMemberId ?? null,
    })

    // ⑨ mark mounts active + flip the sandbox row provisioning→active (fully
    // provisioned: catalog synced, tunnel up, grants built).
    await persistAll({ status: "active" })
    // R3.P2b: CAS the active flip — only flip a row that is STILL 'provisioning'.
    // If a periodic TTL reaper already moved it to 'failed' (deadline exceeded),
    // the flip finds 0 rows and we run the provision-failure cleanup below instead
    // of resurrecting a reaped row (the actual provision↔reaper race-closer).
    const flippedActive = await repo.casFlipSandboxActive(runtimeId)
    if (!flippedActive) {
      throw new SandboxServiceError(
        `provision for ${sessionId} lost the active-flip race — the sandbox row is ` +
          `no longer 'provisioning' (a TTL reaper won); re-provision next turn`,
        409
      )
    }

    return {
      sessionId,
      sandboxRoot,
      runtimeId: runtimeId,
      commandlineEnabled,
      mountIds: mounts.map((m) => m.id),
      sidecarRestoreOk,
      failedSidecars,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Best-effort cleanup of everything provisioned before the failure — the
    // mounts get marked 'failed' (so getActiveMountsForSession excludes them
    // and teardown can't recover), which means cleanup MUST happen here:
    //  - kill the runtime the adapter started + drop its in-process handle,
    //  - revoke any partial grants + soft-delete the sandbox runtime,
    //  - mark the sandboxes row 'failed',
    //  - remove the on-disk scratch dirs (CAS untouched).
    const pairedRuntimeId = handle?.runtimeLink.runtimeId ?? null
    // R4 §1.7/§6.9 — off-box provision-fail fork. A ready()/provision failure
    // must NOT `handle.kill()` (DELETE) a possibly-STILL-LIVE off-box VM without a
    // re-probe. For an off-box adapter, re-probe liveness: on 'alive'/'unknown'
    // LEAVE the row 'closing' (the closing reaper + the Phase-1d orphan sweep
    // converge it on a confirmed-dead re-probe / TTL) and keep the VM + its
    // soft-delete UNwritten; only a confirmed-'dead' VM falls through to the
    // terminal DELETE+soft-delete cleanup. Host adapters keep kill-then-fail
    // (compute-only; a stray host child is cheap to SIGTERM).
    let offBoxPreserve = false
    if (handle && isOffBoxAdapter(adapter)) {
      const liveness = await handle.probeLiveness().catch(() => "unknown")
      offBoxPreserve = liveness !== "dead"
    }
    if (handle && !offBoxPreserve) {
      await handle.kill().catch(() => {})
      liveSandboxHandles.delete(handle.sandboxId)
    } else if (handle) {
      // Preserve the live off-box VM: drop only the in-process handle registration
      // (a fresh reconnect re-attaches it) — do NOT kill.
      liveSandboxHandles.delete(handle.sandboxId)
    }
    if (pairedRuntimeId) {
      await revokeSandboxGrants({
        workspaceId: ctx.workspaceId,
        runtimeId: pairedRuntimeId,
        actorId: ctx.actorId,
        conversationId: ctx.conversationId,
      }).catch(() => {})
      await repo
        .updateSandboxRow(pairedRuntimeId, {
          // Leave a possibly-live off-box VM in 'closing' (reaper/orphan-sweep
          // converges it); a host or confirmed-dead off-box row goes 'failed'.
          state: offBoxPreserve ? "closing" : "failed",
          errorMessage: message,
        })
        .catch(() => {})
      // Only soft-delete the runtime when we are NOT preserving a live off-box VM
      // (a soft-delete would strand the VM: teardown resolves via the sandboxes
      // row + runtime, and the closing reaper needs a non-deleted runtime).
      if (!offBoxPreserve) {
        await deleteRuntime(ctx.workspaceId, pairedRuntimeId).catch(() => {})
      }
    }
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {})
    for (const mount of mounts) {
      await updateFileMount(repo.defaultDbh(), mount.id, {
        status: "failed",
        errorMessage: message,
      }).catch(() => {})
    }
    throw err instanceof SandboxServiceError
      ? err
      : new SandboxServiceError(`provisionSandbox failed: ${message}`, 500)
  }
}

/** Poll runtime_exposures until the filesystem builtin is healthy, or time out. */
async function waitForCatalog(
  runtimeId: string,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<void> {
  const pollMs = opts.pollMs ?? 250
  const deadline = Date.now() + opts.timeoutMs

  while (true) {
    const ready = await repo.isFilesystemExposureHealthy(runtimeId)
    if (ready) return
    if (Date.now() >= deadline) {
      throw new SandboxServiceError(
        `runtime ${runtimeId} catalog did not sync within ${opts.timeoutMs}ms`,
        504
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Poll the in-process RuntimeEndpointRegistry until this service's tunnel endpoint
 * is registered (the device-runtime sent device.tunnel.up and it passed the
 * SSRF/token gate), or time out. A sandbox whose endpoint never appears can't
 * dispatch any tool, so a timeout aborts provision (the caller's catch tears
 * the half-built sandbox down). An empty runtimeServiceId (shouldn't happen for a
 * freshly created handle) is treated as "never registers" → times out.
 * Exported for the fast-path endpoint integration test.
 */
export async function waitForTunnelEndpoint(
  runtimeServiceId: string,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<void> {
  const pollMs = opts.pollMs ?? 250
  const deadline = Date.now() + opts.timeoutMs
  const registry = getRuntimeEndpointRegistry()

  while (true) {
    if (runtimeServiceId && registry.resolve(runtimeServiceId)) return
    if (Date.now() >= deadline) {
      throw new SandboxServiceError(
        `device_service ${runtimeServiceId || "(none)"} did not register a tunnel ` +
          `endpoint within ${opts.timeoutMs}ms — the sandbox would be unreachable ` +
          `for tool dispatch`,
        504
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Resolve the device_runtime service id for a device (the id dispatchSyncTool
 * keys the tunnel registry on). Returns null if the device has no device_runtime
 * service yet. Mirrors the lookup the docker bootstrap poller + dispatch use.
 */
async function resolveDeviceRuntimeServiceId(
  runtimeId: string
): Promise<string | null> {
  return repo.resolveDeviceRuntimeServiceId(runtimeId)
}

/** Injectable seams for {@link fastPathEndpointReady} (tests stub these so the
 *  empty-registry → timeout → reprovision branch is exercised without a DB). */
export interface FastPathEndpointDeps {
  resolveServiceId: (runtimeId: string) => Promise<string | null>
  waitForEndpoint: (serviceId: string, timeoutMs: number) => Promise<void>
}

function defaultFastPathEndpointDeps(): FastPathEndpointDeps {
  return {
    resolveServiceId: resolveDeviceRuntimeServiceId,
    waitForEndpoint: (serviceId, timeoutMs) =>
      waitForTunnelEndpoint(serviceId, { timeoutMs }),
  }
}

/**
 * Decide whether the fast path may reuse an existing live sandbox: it can ONLY
 * when the device's runtime service has a dispatchable tunnel endpoint. After an
 * API restart the in-memory RuntimeEndpointRegistry is empty even though the
 * runtime/container is still alive, so we wait (briefly) for re-registration.
 * Returns false (→ caller tears down + re-provisions) when there is no
 * device_runtime service or the endpoint never (re)registers within the timeout.
 * tunnelTimeoutMs<=0 skips the wait entirely (tests that don't dispatch).
 *
 * Exported with injectable deps so the empty-registry timeout path is unit
 * testable without standing up a full sandbox.
 */
export async function fastPathEndpointReady(
  args: {
    sessionId: string
    runtimeId: string
    mode: "resident" | "bare"
    tunnelTimeoutMs: number
  },
  deps: FastPathEndpointDeps = defaultFastPathEndpointDeps()
): Promise<boolean> {
  // P4 (bare fast-path): a bare (Mode-B) runtime has NO device_runtime service
  // — its dispatch rides the in-process/remote data plane, so resolveServiceId
  // would return null and force a teardown + reprovision EVERY turn. The runtime
  // was already proven alive to reach here (isSandboxRuntimeAlive), and bare
  // dispatch self-heals via lazy plane rebuild (a missing bare_dataplane row
  // already hard-denies at dispatch). So reuse it directly rather than probing a
  // device_runtime endpoint it will never have. No bare_dataplane liveness ping.
  if (args.mode === "bare") return true
  const serviceId = args.runtimeId
    ? await deps.resolveServiceId(args.runtimeId)
    : null
  if (!serviceId) return false
  if (args.tunnelTimeoutMs <= 0) return true
  try {
    await deps.waitForEndpoint(serviceId, args.tunnelTimeoutMs)
    return true
  } catch {
    // Endpoint never re-registered → the live runtime is unreachable for
    // dispatch. The caller falls through to teardown + re-provision (a fresh
    // sandbox that DOES register an endpoint before going active).
    console.warn(
      `[sandbox] fast path: session ${args.sessionId} runtime is alive but no tunnel ` +
        `endpoint re-registered within ${args.tunnelTimeoutMs}ms; tearing down + re-provisioning`
    )
    return false
  }
}

export interface RefreshDeps {
  dbh: Executor
  runInTx: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>
  sync: (input: {
    dir: string
    baseManifestSha256?: string
    toManifestSha256: string
    deferConflictApply?: boolean
  }) => Promise<DirSyncResult>
  /** Phase 2 of a deferred refresh (R12-1): apply head at the conflict paths
   * after the pending record is durably persisted. */
  applyHead: (input: {
    dir: string
    toManifestSha256: string
    paths: string[]
  }) => Promise<void>
}

function defaultRefreshDeps(): RefreshDeps {
  return {
    dbh: repo.defaultDbh(),
    runInTx: (fn) => repo.runInTx(fn),
    sync: syncDir,
    applyHead: applyHeadForConflicts,
  }
}

/**
 * Turn-start refresh: 3-way merge each multi-writer space's (/conversation,
 * /actor) new head into the live dir without unmounting, then advance the
 * mount's base_snapshot_id to the merged-in head. /actor-conversation is single
 * writer — not refreshed.
 *
 * Returns, per subpath: the deferred conflict paths (head won the live path;
 * the agent must reconcile) and the actual sidecar paths written (agent-visible
 * VFS paths where each conflicting file's pre-conflict local copy was preserved
 * — file/symlink conflicts only). The caller surfaces both to the agent.
 *
 * Per-mount isolation: each mount's refresh is independent. If one mount's
 * syncDir fails — either by returning `incomplete` (the helper stopped mid-way
 * but the partial sidecars are valid, round-9 #2) or by throwing outright — we
 * record it in `syncFailuresBySubpath`, surface any sidecars already written,
 * leave that mount's base UNadvanced (so next turn re-runs the merge and
 * self-heals), and CONTINUE with the other mounts — so a failure in one space
 * never discards the already-computed conflict notices of a space that refreshed
 * cleanly (round-8 follow-up + round-9 #2).
 */
/**
 * (R6 #2) Whether the session's CURRENT sandbox is off-box (a remote-VM provider).
 * Resolved from the newest non-deleted sandbox row's adapter; any lookup/resolution
 * failure ⇒ false (treat as host → refresh runs normally, the pre-R6 behavior).
 */
async function sessionSandboxIsOffBox(
  sessionId: string,
  run: Executor
): Promise<boolean> {
  const sb = await repo
    .getSandboxBySessionForControl(sessionId, run)
    .catch(() => null)
  if (!sb) return false
  try {
    return isOffBoxAdapter(adapterForRow(sb.adapter, sb.mode))
  } catch {
    return false
  }
}

export async function refreshSpaces(
  sessionId: string,
  depsOverride?: Partial<RefreshDeps>
): Promise<PendingRefreshConflicts> {
  const deps: RefreshDeps = { ...defaultRefreshDeps(), ...depsOverride }
  const mounts = await getActiveMountsForSession(deps.dbh, sessionId)
  // (R6 #2) For an OFF-BOX mount the mirror is a STAGING area — the actor works in the
  // remote VM, not the mirror, and the VM is pulled ONLY at teardown. Advancing the
  // mount base to a concurrently-committed head H2 here (without re-pushing the VM)
  // makes the teardown pull's stale VM bytes look like a LOCAL edit vs H2 and SILENTLY
  // OVERWRITE the other actor's commit, no conflict. So refresh is a NO-OP for off-box:
  // leave base = the pushed snapshot; the teardown pull→commit then does a correct
  // 3-way merge (base=H, latest=Hn, working=VM) that surfaces the concurrent change as
  // a real conflict + sidecar. (Do NOT re-push the refreshed head into the VM — that
  // would clobber the actor's uncommitted VM work, the reason Option B avoids it.)
  if (await sessionSandboxIsOffBox(sessionId, deps.dbh)) {
    return {
      deferredConflictsBySubpath: {},
      sidecarsBySubpath: {},
      syncFailuresBySubpath: {},
    }
  }
  const deferredConflictsBySubpath: Record<string, string[]> = {}
  const sidecarsBySubpath: Record<string, ConflictSidecarRef[]> = {}
  const syncFailuresBySubpath: Record<string, string> = {}
  for (const mount of mounts) {
    if (mount.mountSubpath === "actor-conversation") continue
    if (!mount.materializedDir) continue

    try {
      const space = await getFileSpace(deps.dbh, mount.fileSpaceId)
      const head = space?.currentSnapshotId ?? null
      if (!head || head === mount.baseSnapshotId) continue // nothing new

      const headManifest = await getSnapshotManifestSha(deps.dbh, head)
      if (!headManifest) continue
      const baseManifest = mount.baseSnapshotId
        ? await getSnapshotManifestSha(deps.dbh, mount.baseSnapshotId)
        : null

      // R12-1: DEFER the head-overwrite of conflicting live paths. The sync
      // writes the recoverable sidecars + applies non-conflicting incoming
      // changes, but leaves each conflicting live path holding the agent's copy.
      // We then durably persist the pending record, apply head, and only then
      // advance base — so a failure before the live path is overwritten leaves
      // working != head and the next turn re-derives the conflict (no silent
      // loss of the notice).
      const sync = await deps.sync({
        dir: mount.materializedDir,
        baseManifestSha256: baseManifest ?? undefined,
        toManifestSha256: headManifest,
        deferConflictApply: true,
      })
      if (sync.deferred_conflicts.length > 0) {
        deferredConflictsBySubpath[mount.mountSubpath] = sync.deferred_conflicts
      }
      // Surface every sidecar the helper actually wrote — INCLUDING when the
      // sync stopped early (round-9 #2). The Rust paths are mount-relative
      // (original = the real tree path, sidecar = a flat hashed leaf under
      // .synapse-conflicts); prefix both with the mount subpath to make them
      // agent-visible. `kind` distinguishes a readable-bytes file sidecar from a
      // readable-JSON symlink sidecar (round-10 #3). `contentSha`/`target` carry
      // the CAS-durable recovery payload (round-11 #1) so the sidecar can be
      // re-materialized after teardown.
      const mountSidecars: ConflictSidecarRef[] = sync.conflict_sidecars.map(
        (c) => ({
          original: `/${mount.mountSubpath}${c.original}`,
          sidecar: `/${mount.mountSubpath}${c.sidecar}`,
          kind: c.kind,
          contentSha: c.content_sha ?? undefined,
          target: c.target ?? undefined,
        })
      )
      if (mountSidecars.length > 0) {
        sidecarsBySubpath[mount.mountSubpath] = mountSidecars
      }
      if (sync.incomplete) {
        // The helper STOPPED EARLY on a per-path failure: the live dir is only
        // partially synced (no valid new base), so do NOT advance base — leaving
        // head!=base re-runs the sync next turn and self-heals (round-8
        // fail-closed). But the sidecars written before the stop ARE surfaced
        // above, so the agent still learns where its preserved copies are
        // (round-9 #2: don't orphan an already-written sidecar).
        syncFailuresBySubpath[mount.mountSubpath] = sync.incomplete
        console.error(
          `[sandbox] refresh sync incomplete for mount ${mount.id} (${mount.mountSubpath}); base left unadvanced for next-turn retry: ${sync.incomplete}`
        )
        continue
      }
      // R12-1 ordering (durable BEFORE destructive): for a conflicted mount,
      //   (1) persist the pending record durably (the notice + sidecar pointers),
      //   (2) apply head to the conflict live paths (now safe — record is durable),
      //   (3) advance base.
      // A failure at (1) leaves base unadvanced AND the live conflict path still
      // the agent's copy → next turn re-derives the conflict. A failure at (2)
      // leaves base unadvanced + record durable → next turn re-derives and
      // re-applies. A failure at (3) leaves live==head but base==old → next turn
      // re-syncs (working==head, no new conflict) and advances base; idempotent.
      // Non-conflicting incoming changes were already applied by the sync above.
      if (sync.deferred_conflicts.length > 0 || mountSidecars.length > 0) {
        // (1) durable record FIRST.
        await deps.runInTx((txq) =>
          recordPendingRefreshConflictsOn(txq, sessionId, {
            deferredConflictsBySubpath:
              sync.deferred_conflicts.length > 0
                ? { [mount.mountSubpath]: sync.deferred_conflicts }
                : {},
            sidecarsBySubpath:
              mountSidecars.length > 0
                ? { [mount.mountSubpath]: mountSidecars }
                : {},
          })
        )
        // (2) NOW overwrite the conflicting live paths with head.
        if (sync.deferred_conflicts.length > 0) {
          await deps.applyHead({
            dir: mount.materializedDir,
            toManifestSha256: headManifest,
            paths: sync.deferred_conflicts,
          })
        }
        // (3) advance base last.
        await updateFileMount(deps.dbh, mount.id, { baseSnapshotId: head })
      } else {
        // No conflict on this mount → the sync already applied everything; just
        // advance base.
        await updateFileMount(deps.dbh, mount.id, { baseSnapshotId: head })
      }
    } catch (err) {
      // The helper threw outright (e.g. an RPC/spawn error before any partial
      // result) — the live dir may be partially synced and base is NOT advanced.
      // Record the failure so the caller can tell the agent this space's view is
      // stale, and so commit skips it this turn; next turn re-runs the merge from
      // the same base and self-heals. CONTINUE so other mounts still refresh +
      // surface notices.
      const msg = err instanceof Error ? err.message : String(err)
      syncFailuresBySubpath[mount.mountSubpath] = msg
      console.error(
        `[sandbox] refresh sync failed for mount ${mount.id} (${mount.mountSubpath}); base left unadvanced for next-turn retry:`,
        err
      )
    }
  }
  const result: PendingRefreshConflicts = {
    deferredConflictsBySubpath,
    sidecarsBySubpath,
    syncFailuresBySubpath,
  }
  return result
}

export interface CommitResult {
  /** subpath → new snapshot id (only spaces that produced a new snapshot). */
  snapshotIdBySubpath: Record<string, string>
  /** subpath → conflict paths surfaced (per-file isolation). */
  conflictsBySubpath: Record<string, string[]>
  /**
   * subpath → sidecars the post-commit reconcile preserved (original VFS path →
   * sidecar path + kind). The agent's pre-conflict copy of each lost file lives
   * here, so the next-turn notice can point at it instead of claiming the work
   * was simply lost (round-7 #C).
   */
  sidecarsBySubpath: Record<string, ConflictSidecarRef[]>
}

/**
 * Test seam for the commit path (round-8 follow-up: lets the loss-safety-
 * critical reconcile-failure / head-race branches be driven at the function
 * level). Defaults bind to production globals. A test injects a real test-DB
 * executor + a matching `runInTx` (so the inner FOR UPDATE/appendSnapshot runs
 * on the SAME pinned connection, no nested BEGIN), and can stub `reconcile` to
 * deterministically force a reconcile failure.
 */
export interface CommitDeps {
  /** Executor for non-transactional reads/updates (default: top-level db). */
  dbh: Executor
  /** Run `fn` in a DB transaction (default: the global `transaction` helper). */
  runInTx: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>
  /**
   * Resolve the session's workspace/conversation/actor (default: global kysely
   * db). Injected so a test on a single pinned/rolled-back connection can see
   * its own uncommitted session row.
   */
  loadCtx: (sessionId: string) => Promise<SessionContext | null>
  /**
   * Reconcile the live dir to a committed manifest (head-wins + sidecar losers),
   * DEFERRING the destructive head-overwrite of the conflicting live paths so the
   * caller can durably persist the pending record FIRST (P1 durable-before-
   * destructive, mirroring refresh's R12-1).
   *
   * Returns `{ ok, sidecars, deferredConflicts }`: `ok` = the reconcile applied
   * cleanly up to (but not including) the deferred conflict overwrites — i.e. the
   * non-conflicting incoming bytes landed and every loser was sidecar'd, so once
   * the record is durable the caller may safely apply head + advance base.
   * `sidecars` = every preserved copy written, surfaced to the agent EVEN WHEN
   * ok=false (round-9 #2: a sidecar written before a mid-way failure must not be
   * orphaned). `deferredConflicts` = the live paths still holding the agent's
   * pre-conflict copy (NOT yet overwritten with head) — the caller passes these
   * to `applyHead` AFTER persisting. When ok=false the caller MUST NOT apply head
   * or advance base (round-7 #A self-heal). Default drives the real fs-helper via
   * syncDir with deferConflictApply.
   */
  reconcile: (
    mount: FileMountRow,
    baseManifestSha: string | null,
    committedManifestSha: string,
    hadConflicts: boolean
  ) => Promise<{
    ok: boolean
    sidecars: ConflictSidecarRef[]
    deferredConflicts: string[]
  }>
  /**
   * Phase 2 of a deferred commit reconcile (P1): overwrite the live conflict
   * `paths` with the committed manifest's version AFTER the pending record is
   * durably persisted. Until this runs the conflict paths hold the agent's copy,
   * so a persist failure self-heals (next turn re-derives the conflict). Default
   * drives the real fs-helper via applyHeadForConflicts.
   */
  applyHead: (
    mount: FileMountRow,
    committedManifestSha: string,
    paths: string[]
  ) => Promise<void>
}

function defaultCommitDeps(): CommitDeps {
  return {
    dbh: repo.defaultDbh(),
    runInTx: (fn) => repo.runInTx(fn),
    loadCtx: loadSessionContext,
    reconcile: async (
      mount,
      baseManifestSha,
      committedManifestSha,
      hadConflicts
    ) => {
      if (!hadConflicts)
        return { ok: true, sidecars: [], deferredConflicts: [] }
      try {
        // P1: DEFER the head-overwrite of the conflict live paths. The sync
        // writes the recoverable sidecars + applies non-conflicting incoming
        // bytes, but leaves each conflicting live path holding the agent's copy.
        // The caller persists the pending record, THEN calls applyHead, THEN
        // advances base — so a persist failure leaves working != committed and
        // the next turn re-derives the conflict (no silent loss).
        const res = await syncDir({
          dir: mount.materializedDir!,
          baseManifestSha256: baseManifestSha ?? undefined,
          toManifestSha256: committedManifestSha,
          deferConflictApply: true,
        })
        const sidecars = res.conflict_sidecars.map((c) => ({
          original: `/${mount.mountSubpath}${c.original}`,
          sidecar: `/${mount.mountSubpath}${c.sidecar}`,
          kind: c.kind,
          contentSha: c.content_sha ?? undefined,
          target: c.target ?? undefined,
        }))
        if (res.incomplete) {
          // Partial reconcile: surface the sidecars written so far, but signal
          // NOT-ok so the caller leaves base unadvanced (round-9 #2 + round-7 #A)
          // and never applies head.
          console.error(
            `[sandbox] post-commit reconcile incomplete for mount ${mount.id}: ${res.incomplete}`
          )
          return { ok: false, sidecars, deferredConflicts: [] }
        }
        return { ok: true, sidecars, deferredConflicts: res.deferred_conflicts }
      } catch (err) {
        console.error(
          `[sandbox] post-commit reconcile failed for mount ${mount.id}:`,
          err
        )
        return { ok: false, sidecars: [], deferredConflicts: [] }
      }
    },
    applyHead: async (mount, committedManifestSha, paths) => {
      await applyHeadForConflicts({
        dir: mount.materializedDir!,
        toManifestSha256: committedManifestSha,
        paths,
      })
    },
  }
}

/**
 * Commit dirty spaces. `which` selects subpaths (default: the multi-writer
 * spaces /conversation + /actor; teardown also commits /actor-conversation).
 * scan+ingest runs OUTSIDE the DB row lock (slow); the short locked txn just
 * re-checks head + appends the snapshot, re-scanning if head moved.
 */
export async function commitSpaces(
  sessionId: string,
  which?: MountSubpath[],
  depsOverride?: Partial<CommitDeps>
): Promise<CommitResult> {
  const deps: CommitDeps = { ...defaultCommitDeps(), ...depsOverride }
  const ctx = await deps.loadCtx(sessionId)
  if (!ctx) throw new SandboxServiceError(`session ${sessionId} not found`, 404)
  const mounts = await getActiveMountsForSession(deps.dbh, sessionId)
  const subpaths = which ?? ["conversation", "actor"]
  const out: CommitResult = {
    snapshotIdBySubpath: {},
    conflictsBySubpath: {},
    sidecarsBySubpath: {},
  }

  for (const mount of mounts) {
    if (!subpaths.includes(mount.mountSubpath)) continue
    if (!mount.materializedDir) continue

    const result = await commitOneMount(ctx.workspaceId, sessionId, mount, deps)
    if (result.snapshotId) {
      out.snapshotIdBySubpath[mount.mountSubpath] = result.snapshotId
    }
    if (result.conflicts.length > 0) {
      out.conflictsBySubpath[mount.mountSubpath] = result.conflicts
    }
    if (result.sidecars.length > 0) {
      out.sidecarsBySubpath[mount.mountSubpath] = result.sidecars
    }
  }
  // P1: the pending commit conflict is now persisted PER-MOUNT inside
  // commitOneMount — BEFORE the destructive head-overwrite of the deferred
  // conflict live paths and the base-advance (durable-before-destructive,
  // mirroring refresh's R12-1). So there is no longer an end-of-commitSpaces
  // persist here: doing it after reconcile already overwrote the live loser +
  // advanced base would re-open the very gap this fix closes (a persist failure
  // after base advanced silently loses the notice, since next turn head==base).
  // A persist failure inside commitOneMount propagates out of this function, so
  // teardown's commit still fail-closes and preserves the live dir (R12-2).
  return out
}

/**
 * Stash turn-end commit conflicts on the session for the next turn to surface.
 * MERGES with any already-pending conflicts (union by subpath: deduped paths +
 * deduped sidecars) rather than replacing — otherwise a still-undelivered notice
 * from a turn whose actorThink threw (so it wasn't cleared) would be clobbered by
 * a new conflict. Each subpath carries both the lost paths and the sidecars where
 * the agent's pre-conflict copy was preserved (round-7 #C). The read-merge-write
 * core (FOR UPDATE on the injected runInTx) lives in repo.ts.
 */
const recordPendingCommitConflicts = repo.recordPendingCommitConflicts

/**
 * Read (WITHOUT clearing) any commit conflicts stashed by a previous turn's
 * teardown/commit. At-least-once delivery: the caller surfaces these to the
 * agent, then calls clearPendingCommitConflicts ONLY after the model has
 * actually consumed them (post-actorThink), so a crash in between re-delivers
 * rather than drops the notice. (DB read lives in repo.ts; re-exported here so
 * index.ts / the session-thinking worker keep importing it from this module.)
 */
export const peekPendingCommitConflicts = repo.peekPendingCommitConflicts

/** Clear the stashed commit conflicts (after the agent has consumed them). */
export const clearPendingCommitConflicts = repo.clearPendingCommitConflicts

/**
 * Executor-bound core of the refresh-conflict persist: read-merge-write the
 * pending refresh blob on the given (already-open) transaction. Used by
 * refreshSpaces to couple the persist with the per-mount base advance in ONE
 * transaction (round-11 #2: a persist failure must roll back the base advance,
 * so head!=base self-heals instead of silently degrading durability). The DB
 * body (FOR UPDATE + jsonb merge-write) lives in repo.ts.
 */
const recordPendingRefreshConflictsOn = repo.recordPendingRefreshConflictsOn

/**
 * Read (WITHOUT clearing) refresh conflicts stashed by a previous turn whose
 * notice the actor may not have consumed (at-least-once delivery, round-10 #1).
 * Returns the persisted deferred paths + sidecars (NOT syncFailures — those are
 * recomputed fresh each turn). The caller clears only after actorThink returns.
 * (DB read lives in repo.ts; re-exported here for index.ts / the worker.)
 */
export const peekPendingRefreshConflicts = repo.peekPendingRefreshConflicts

/** Clear the stashed refresh conflicts (after the agent has consumed them). */
export const clearPendingRefreshConflicts = repo.clearPendingRefreshConflicts

/**
 * Re-materialize every durable pending conflict sidecar (commit + refresh) into
 * the freshly-provisioned live dirs (round-11 #1). The pending notices reference
 * `/<subpath>/.synapse-conflicts/<hash>` paths that a prior teardown deleted;
 * rebuild each from its CAS-durable payload so the agent-visible path resolves
 * again. Best-effort per sidecar — a missing payload (e.g. a pre-round-11 record
 * without contentSha) is skipped with a warning rather than failing provision.
 */
async function restorePendingSidecars(
  sessionId: string,
  mounts: FileMountRow[]
): Promise<{ ok: boolean; failedSidecars: SidecarRestoreFailure[] }> {
  return restorePendingSidecarsImpl(sessionId, mounts, {
    peekCommit: peekPendingCommitConflicts,
    peekRefresh: peekPendingRefreshConflicts,
  })
}

/**
 * Testable core of restorePendingSidecars: peek functions injected so a test can
 * drive it on a pinned/rolled-back connection without the heavyweight
 * provisionSandbox pairing/spawn path. Exported for unit coverage (round-11 #1).
 */
export async function restorePendingSidecarsImpl(
  sessionId: string,
  mounts: Pick<FileMountRow, "mountSubpath" | "materializedDir">[],
  deps: {
    peekCommit: (s: string) => Promise<Record<string, PendingCommitConflict>>
    peekRefresh: (
      s: string
    ) => Promise<
      Pick<
        PendingRefreshConflicts,
        "deferredConflictsBySubpath" | "sidecarsBySubpath"
      >
    >
  }
): Promise<{ ok: boolean; failedSidecars: SidecarRestoreFailure[] }> {
  const dirBySubpath = new Map<string, string>()
  for (const m of mounts) {
    if (m.materializedDir) dirBySubpath.set(m.mountSubpath, m.materializedDir)
  }

  // Collect EVERY pending sidecar ref up front (deduped by leaf). Even if there
  // are no live mount dirs this provision we must know the full set so a
  // whole-restore failure can mark them all unrestored (P2) rather than silently
  // treating them as delivered.
  const commit = await deps.peekCommit(sessionId)
  const refresh = await deps.peekRefresh(sessionId)
  const allRefs: ConflictSidecarRef[] = [
    ...Object.values(commit).flatMap((c) => c.sidecars),
    ...Object.values(refresh.sidecarsBySubpath).flat(),
  ]
  if (allRefs.length === 0) return { ok: true, failedSidecars: [] }

  // Dedup by sidecar leaf (the same preserved copy may appear in both stores or
  // multiple subpath entries); restore each once.
  const seen = new Set<string>()
  const failedSidecars: SidecarRestoreFailure[] = []
  const fail = (sidecar: string, reason: SidecarRestoreFailureReason) =>
    failedSidecars.push({ sidecar, reason })
  for (const ref of allRefs) {
    if (seen.has(ref.sidecar)) continue
    seen.add(ref.sidecar)
    // Intrinsic (mount-INDEPENDENT) unrecoverability FIRST: a ref whose own
    // record can never rebuild — missing payload, unknown kind, OR a sidecar path
    // that isn't a safe /<mount>/.synapse-conflicts/<flat-leaf> — is PERMANENT
    // regardless of mount state. Checking it up front (via the shared predicate,
    // the same one partitionSidecars uses) keeps the two in exact lockstep AND
    // (P1) guarantees restore can only ever write inside the .synapse-conflicts
    // scratch namespace, never onto a real tree path.
    if (isSidecarPayloadIrrecoverable(ref)) {
      console.warn(
        `[sandbox] cannot restore sidecar ${JSON.stringify(ref.sidecar)} ` +
          `(kind=${ref.kind}, irrecoverable record — missing payload, unknown ` +
          `kind, or non-sidecar/unsafe path); skipping permanently`
      )
      fail(ref.sidecar, "permanent")
      continue
    }
    // Route to the mount: predicate guarantees a well-formed sidecar path, so
    // parseSidecarRoute returns the subpath + the mount-relative scratch leaf.
    const route = parseSidecarRoute(ref.sidecar)!
    const { subpath, leaf } = route
    const dir = dirBySubpath.get(subpath)
    if (!dir) {
      // No live mount for this subpath this provision — can't restore now, but a
      // LATER provision (with this mount active) can; keep it retryable (R12-3
      // fail-closed) rather than treating it as delivered. TRANSIENT.
      fail(ref.sidecar, "transient")
      continue
    }
    try {
      await restoreSidecar({
        dir,
        sidecarVfs: leaf,
        kind: ref.kind,
        contentSha: ref.contentSha,
        target: ref.target,
      })
    } catch (err) {
      // A write/IO error — the payload exists, so a retry next provision may
      // succeed. TRANSIENT.
      console.error(`[sandbox] failed to restore sidecar ${ref.sidecar}:`, err)
      fail(ref.sidecar, "transient")
    }
  }
  return { ok: failedSidecars.length === 0, failedSidecars }
}

/**
 * Every pending conflict sidecar VFS path on the session (commit + refresh,
 * deduped). Used to fail-closed (P2): when restorePendingSidecars throws as a
 * whole — so the per-sidecar failure list never populated — provisionSandbox
 * marks ALL of these as transiently unrestored, so the worker never tells the
 * agent to "read" a sidecar whose restore status is actually unknown.
 */
async function collectAllPendingSidecarPaths(
  sessionId: string
): Promise<string[]> {
  const commit = await peekPendingCommitConflicts(sessionId)
  const refresh = await peekPendingRefreshConflicts(sessionId)
  const seen = new Set<string>()
  for (const c of Object.values(commit))
    for (const s of c.sidecars) seen.add(s.sidecar)
  for (const arr of Object.values(refresh.sidecarsBySubpath))
    for (const s of arr) seen.add(s.sidecar)
  return Array.from(seen)
}

async function commitOneMount(
  workspaceId: string,
  sessionId: string,
  mount: FileMountRow,
  deps: CommitDeps,
  attempt = 0
): Promise<{
  snapshotId: string | null
  conflicts: string[]
  sidecars: ConflictSidecarRef[]
}> {
  if (attempt > 3) {
    throw new SandboxServiceError(
      `commit for mount ${mount.id} kept losing the head race`,
      409
    )
  }
  // Read current head OUTSIDE the lock as `latest`.
  const space = await getFileSpace(deps.dbh, mount.fileSpaceId)
  const latestSnapshotId = space?.currentSnapshotId ?? null
  const baseManifest = mount.baseSnapshotId
    ? await getSnapshotManifestSha(deps.dbh, mount.baseSnapshotId)
    : null
  const latestManifest = latestSnapshotId
    ? await getSnapshotManifestSha(deps.dbh, latestSnapshotId)
    : null

  // Scan + CAS-ingest the live dir (slow; no DB lock held). The routing ctx lets
  // scanCommitDir push the new blobs to their durable backend BEFORE we commit
  // the snapshot row (plan §9.2); a {workspaceId, fileSpaceId} is enough for the
  // default policy (routes to local_cas — byte-identical to today).
  const scan = await scanCommitDir({
    dir: mount.materializedDir!,
    baseManifestSha256: baseManifest ?? undefined,
    latestManifestSha256: latestManifest ?? undefined,
    routing: { workspaceId, fileSpaceId: mount.fileSpaceId },
    executor: deps.dbh,
  })

  // CRITICAL (round-6 #1): scan_commit only COMPUTES the merged manifest — it
  // does NOT touch the live dir. On a conflict the merged manifest keeps HEAD,
  // but the live dir still holds the agent's local loser L. If we advance base
  // to the committed manifest without reconciling the live dir, next turn's
  // refresh sees head==base and skips, leaving L in place; the following commit
  // then treats L as a fresh edit on the new base and SILENTLY OVERWRITES the
  // concurrent writer. So whenever there were conflicts, sync the live dir to
  // the committed manifest (head-wins) and sidecar the local losers — exactly
  // like refresh — so live == committed and base-advance is safe.
  //
  // deps.reconcile returns { ok, sidecars, deferredConflicts }: `sidecars` =
  // every preserved copy written (mount-subpath-prefixed, so the caller can tell
  // the agent where its pre-conflict copy is — round-7 #C + round-9 #2: surfaced
  // EVEN when ok=false); `deferredConflicts` = the live paths still holding the
  // agent's copy (NOT yet overwritten with head — P1 durable-before-destructive),
  // passed to deps.applyHead AFTER the pending record is persisted; `ok=false` =
  // the reconcile did not fully bring the live dir to committed, so the caller
  // MUST NOT apply head or advance base — leaving head!=base lets next turn's
  // refresh re-run the reconcile and self-heal, whereas advancing base now would
  // re-open the round-6 #1 silent-overwrite bug (round-7 #A).
  const reconcileLiveDir = (committedManifestSha: string) =>
    deps.reconcile(
      mount,
      baseManifest,
      committedManifestSha,
      scan.conflict_paths.length > 0
    )

  // Nothing to commit beyond the current head (no local changes, or all local
  // changes lost to head on conflict): the merged manifest equals latest. Don't
  // bump the version, BUT reconcile the live dir + advance the mount base to
  // latest so the next commit doesn't re-derive the same conflict (and doesn't
  // overwrite head with the stale local copy).
  if (latestManifest && scan.manifest_sha256 === latestManifest) {
    const { ok, sidecars, deferredConflicts } =
      await reconcileLiveDir(latestManifest)
    // P1 durable-before-destructive (mirrors refresh R12-1):
    //   (1) persist the pending notice + sidecar pointers FIRST — whenever there
    //       were conflicts, even if the reconcile did not fully apply (ok=false):
    //       the agent's loser blob is reachable ONLY via this record (a GC root),
    //       and the notice must survive (at-least-once). A persist failure
    //       propagates so teardown fail-closes + preserves the live dir (R12-2).
    //   (2) only if ok: overwrite the deferred conflict live paths with head, then
    //       (3) advance base. While the live path still holds the agent's copy a
    //       persist/apply failure self-heals (working != head → next turn
    //       re-derives the conflict; no silent loss).
    if (scan.conflict_paths.length > 0) {
      await recordPendingCommitConflicts(
        sessionId,
        { [mount.mountSubpath]: { paths: scan.conflict_paths, sidecars } },
        deps.runInTx
      )
    }
    if (!ok) {
      // Reconcile not fully applied → do NOT apply head or advance base. Next
      // turn's refresh (head!=base) re-runs the reconcile and self-heals;
      // advancing now would let the stale local loser silently overwrite head on
      // the following commit (round-7 #A). The pending record (persisted above)
      // keeps the notice + sidecar blob alive for the retry (round-9 #2).
      return { snapshotId: null, conflicts: scan.conflict_paths, sidecars }
    }
    if (deferredConflicts.length > 0) {
      await deps.applyHead(mount, latestManifest, deferredConflicts)
    }
    if (latestSnapshotId && mount.baseSnapshotId !== latestSnapshotId) {
      await updateFileMount(deps.dbh, mount.id, {
        baseSnapshotId: latestSnapshotId,
      })
    }
    return { snapshotId: null, conflicts: scan.conflict_paths, sidecars }
  }

  // Short locked txn: re-check head, ingest blobs, append snapshot. Use the
  // pg-client transaction (a Executor) so space.ts helpers run on one
  // connection inside BEGIN/COMMIT.
  try {
    const snapshot = await deps.runInTx(async (txq) => {
      // Ingest the manifest blob + all new file blobs FIRST (FK target).
      // New sandbox blobs land in the shared local CAS cache (local_cas).
      await ensureContentBlob(txq, {
        sha256: scan.manifest_sha256,
        sizeBytes: 0, // manifest size is not tracked; 0 is a valid placeholder
        backend: "local_cas",
      })
      for (const blobSha of scan.new_blobs) {
        await ensureContentBlob(txq, {
          sha256: blobSha,
          sizeBytes: 0,
          backend: "local_cas",
        })
      }
      return appendSnapshot(txq, {
        workspaceId,
        fileSpaceId: mount.fileSpaceId,
        expectedParentSnapshotId: latestSnapshotId,
        manifestSha256: scan.manifest_sha256,
        entryCount: scan.entry_count,
        totalBytes: scan.total_bytes,
        createdBySessionId: sessionId,
      })
    })
    // Reconcile the live dir to the committed manifest (head-wins + sidecar the
    // losers), DEFERRING the destructive conflict overwrite, BEFORE advancing
    // base — so the next turn never overwrites head with a stale local copy.
    // (No-op → ok with [] when there were no conflicts.)
    const { ok, sidecars, deferredConflicts } = await reconcileLiveDir(
      scan.manifest_sha256
    )
    // The snapshot DID commit (head advanced to snapshot.id) — record it for
    // audit up-front so it's durable regardless of what the reconcile/persist do.
    await updateFileMount(deps.dbh, mount.id, {
      resultSnapshotId: snapshot.id,
    })
    // P1 durable-before-destructive (mirrors refresh R12-1):
    //   (1) persist the pending notice + sidecar pointers FIRST — whenever there
    //       were conflicts, even when the reconcile did not fully apply (ok=false):
    //       the loser blob is reachable ONLY via this record (a GC root) and the
    //       notice must survive (at-least-once). A persist failure propagates so
    //       teardown fail-closes + preserves the live dir (R12-2).
    //   (2) only if ok: overwrite the deferred conflict live paths with the
    //       committed version, then (3) advance base. While the live path holds the
    //       agent's copy a persist/apply failure self-heals next turn.
    if (scan.conflict_paths.length > 0) {
      await recordPendingCommitConflicts(
        sessionId,
        { [mount.mountSubpath]: { paths: scan.conflict_paths, sidecars } },
        deps.runInTx
      )
    }
    if (!ok) {
      // Reconcile not fully applied AFTER the snapshot committed. Do NOT apply
      // head or advance base — next turn's refresh (head=snapshot.id != base=old)
      // re-runs the reconcile and self-heals. Advancing base here would re-open
      // round-6 #1 (the stale local loser would silently overwrite head)
      // (round-7 #A). The partial sidecars are surfaced + persisted above.
      return {
        snapshotId: snapshot.id,
        conflicts: scan.conflict_paths,
        sidecars,
      }
    }
    if (deferredConflicts.length > 0) {
      await deps.applyHead(mount, scan.manifest_sha256, deferredConflicts)
    }
    // Advance the mount base to the snapshot we just produced.
    await updateFileMount(deps.dbh, mount.id, {
      baseSnapshotId: snapshot.id,
      resultSnapshotId: snapshot.id,
    })
    return { snapshotId: snapshot.id, conflicts: scan.conflict_paths, sidecars }
  } catch (err) {
    // Head moved during scan → re-scan against the new head (cheap: blobs are
    // already in CAS). Never merge the already-merged manifest again.
    if (err instanceof Error && /head moved/.test(err.message)) {
      return commitOneMount(workspaceId, sessionId, mount, deps, attempt + 1)
    }
    throw err
  }
}

export interface TeardownSandboxOptions {
  /**
   * Inject the DB executor used for ALL reads AND writes on the teardown/crash-
   * recovery path. Defaults to the top-level db (repo.defaultDbh()) so prod
   * turn-end / provision-recover / reconcile behaviour is unchanged. The
   * reconcile reaper threads its pinned executor through here so the loopback
   * reaper test can drive the REAL commit → kill → close-mounts → revoke-grants →
   * soft-delete spine against a single rolled-back transaction (P1.7). Without
   * this seam teardown re-acquires the global db and the reaper test fake-greens.
   */
  executor?: Executor
  /**
   * (R5 #3) Converge THIS SPECIFIC runtime, not "the newest sandbox for the
   * session." The closing reaper passes the exact 'closing' row's id so teardown
   * never re-resolves (via mounts / createdAt-DESC) to a newer, re-provisioned
   * sandbox and kills IT. When set AND a newer live sandbox already owns the
   * session, teardown runs a DATA-FREE convergence of this stale runtime (kill its
   * OWN provider resource + soft-delete it) — the session's mounts/mirror/CAS
   * belong to the new owner and are never touched.
   */
  runtimeId?: string
}

/**
 * (R5 #3) DATA-FREE convergence of a stale runtime whose session was already
 * re-provisioned by a newer live sandbox. Kill ONLY this runtime's own provider
 * resource + revoke ITS grants + soft-delete IT. NEVER load session mounts, commit
 * the session mirror, or rm(sandboxRootFor(sessionId)) — those are the NEW owner's.
 */
/**
 * (#6) True iff this teardown still holds the lease captured at its close-gate flip
 * — the sandbox row's teardown_epoch still equals N. A concurrent teardown/reaper
 * that re-flipped the row bumped the epoch past N (→ false), and a fully-removed row
 * reads null (→ false). Called RIGHT BEFORE each irreversible teardown cluster so a
 * superseded teardown aborts instead of double-destroying.
 */
async function stillHoldsTeardownLease(
  runtimeId: string,
  epoch: bigint,
  run: Executor
): Promise<boolean> {
  const current = await repo
    .readSandboxTeardownEpoch(runtimeId, run)
    .catch(() => null)
  return current === epoch
}

async function teardownStaleRuntimeDataFree(
  sessionId: string,
  runtimeId: string,
  run: Executor
): Promise<void> {
  const row = await repo.getSandboxById(runtimeId, run)
  if (!row || row.state === "closed" || row.state === "failed") return
  const { flipped, epoch } = await repo
    .casFlipSandboxClosing(runtimeId, run)
    .catch(() => ({ flipped: false, epoch: null as bigint | null }))
  if (!flipped || epoch === null) return
  markBareDataPlaneClosing(runtimeId)
  try {
    let adapter: SandboxAdapter | null = null
    try {
      adapter = adapterForRow(row.adapter, row.mode)
    } catch {
      adapter = null
    }
    // (#6) Re-check the teardown lease RIGHT BEFORE the irreversible destroy: a
    // concurrent teardown/reaper that re-flipped the row bumped the epoch past N, so
    // we abort (leaving it 'closing' for that owner) rather than redundantly destroy.
    if (!(await stillHoldsTeardownLease(runtimeId, epoch, run))) {
      log.info(
        { sessionId, runtimeId },
        "data-free teardown: superseded (teardown_epoch advanced) — leaving to the current owner"
      )
      return
    }
    // (R6 #4) If THIS straggler still owns un-pulled failed-recoverable bytes, its VM
    // is the SOLE copy — DEFER destruction while recovery attempts remain (the failed-
    // mount recovery sweep re-pulls from its OWN VM, resolved by sandbox_id). Only
    // converge (destroy + accept loss) once the epoch attempt-cap is exhausted. Scoped
    // to sandbox_id=runtimeId, never the session, so a sibling generation's mounts
    // neither block this convergence nor get pulled from the wrong VM.
    if (
      epoch < BigInt(MAX_OFFBOX_RECOVERY_ATTEMPTS) &&
      adapter &&
      isOffBoxAdapter(adapter) &&
      (await sandboxHasFailedRecoverableMounts(run, runtimeId))
    ) {
      log.warn(
        { sessionId, runtimeId, attempt: epoch.toString() },
        "data-free teardown: straggler still owns failed-recoverable mounts — deferring destroy for recovery re-pull"
      )
      return
    }
    // Kill the stale runtime's OWN provider resource by its own resource_id — an
    // off-box VM via destroyResource; a host resource is left to the docker/reconcile
    // orphan reaper (a stray host child/container is cheap + swept). NEVER the session
    // mirror or the newer runtime's mounts.
    if (adapter && isOffBoxAdapter(adapter) && row.resourceId) {
      await adapter
        .destroyResource(row.resourceId)
        .catch((err) =>
          log.error(
            { runtimeId, resourceId: row.resourceId, err },
            "data-free teardown: destroyResource failed (orphan sweep backstops)"
          )
        )
    }
    // (R6 review-fix) The convergence past the attempt cap ACCEPTS THE LOSS + destroys
    // the VM — so it must TERMINATE this straggler's OWN failed/recovering mounts too.
    // SANDBOX-scoped (never closeSessionFailedMounts, which would wipe a live sibling
    // generation's mounts). Without this the mounts stay failed-recoverable and the
    // periodic recovery sweep re-claims them forever, reconnecting to the now-destroyed
    // VM every tick — an unbounded livelock (the sibling teardown convergence closes its
    // mounts at 2790; this data-free path previously omitted the equivalent).
    await closeSandboxFailedMounts(run, runtimeId).catch((err) =>
      log.error(
        { runtimeId, err },
        "data-free teardown: closing straggler mounts failed"
      )
    )
    const ctx = await loadSessionContext(sessionId, run)
    if (ctx) {
      await revokeSandboxGrants({
        workspaceId: ctx.workspaceId,
        runtimeId,
        actorId: ctx.actorId,
        conversationId: ctx.conversationId,
        executor: run,
      }).catch((err) =>
        log.error(
          { runtimeId, err },
          "data-free teardown: revoke grants failed"
        )
      )
    }
    // (R6 #5) Soft-delete the runtime ONLY when the epoch-fenced terminal write WON —
    // i.e. we still hold the lease. If a concurrent teardown took the lease in the
    // window, casClose no-ops and we must NOT soft-delete (the winner owns it), closing
    // the re-check→CAS TOCTOU.
    const closed = await repo
      .casCloseSandboxAtEpoch(runtimeId, epoch, { state: "closed" }, run)
      .catch(() => false)
    if (closed) {
      await deleteRuntime(row.workspaceId, runtimeId, run).catch((err) =>
        log.error({ runtimeId, err }, "data-free teardown: soft-delete failed")
      )
    }
    unregisterBareDataPlane(runtimeId)
    log.info(
      { sessionId, runtimeId },
      "data-free teardown: converged a stale 'closing' runtime whose session was re-provisioned"
    )
  } finally {
    clearBareDataPlaneClosing(runtimeId)
  }
}

/**
 * P1.5: a bare data-plane dispatch reported `resource_gone` (the sandbox
 * container/process vanished out from under us mid-turn). Flip the sandbox to
 * 'closing' — the state that NEEDS teardown convergence — via the SAME CAS the
 * teardown close-gate uses, so the row stops being treated as live yet a subsequent
 * teardown (the pre-provision stale-mount teardown, the closing reaper, or the
 * turn-end putSessionToIdle) COMMITS whatever survived (a host adapter's mirror still
 * holds the turn's bytes even though the container is gone), CLOSES the mounts,
 * revokes grants, and soft-deletes.
 *
 * (R4 review fix) This function does NO cleanup itself, so it MUST NOT leave the row
 * 'failed': the R4 Link A close-gate CAS matches only provisioning/active/closing, so
 * a 'failed' row made every later teardown BAIL — stranding the still-'active' mounts,
 * which then collided on the partial unique index and broke re-provision FOREVER (plus
 * leaked the runtime + its grants). 'closing' keeps mounts convergeable. CAS so a
 * teardown that already drove the row terminal wins (never resurrect a closed row).
 * Best-effort — the dispatch has already failed and returned its error.
 */
export async function markSandboxResourceGone(
  runtimeId: string,
  run: Executor = repo.defaultDbh()
): Promise<void> {
  const { flipped } = await repo
    .casFlipSandboxClosing(runtimeId, run)
    .catch((err) => {
      log.warn(
        { runtimeId, err },
        "markSandboxResourceGone: CAS flip to 'closing' failed"
      )
      return { flipped: false, epoch: null as bigint | null }
    })
  if (!flipped) {
    log.info(
      { runtimeId },
      "markSandboxResourceGone: row already terminal / owned by a concurrent teardown — no-op"
    )
  }
  // NOTE: this only arms the 'closing' convergence — it destroys nothing itself, so
  // no teardown_epoch lease re-check is needed here (the subsequent teardown holds
  // the lease and fences its own irreversible cluster).
}

interface TeardownOffBoxArgs {
  sessionId: string
  run: Executor
  ctx: SessionContext | null
  mounts: FileMountRow[]
  runtimeId: string
  ref: SandboxRef
  // (#13) narrowed off-box adapter → reconnectDataPlane is called without a `!`.
  adapter: OffBoxBareAdapter
  options: TeardownSandboxOptions
}

/**
 * (R4 §6.3, P0) OFF-BOX teardown — drain → reconnect → PULL → commit → gate-DELETE.
 * The VM is the SOLE store of the turn's work, so it MUST be pulled out BEFORE the
 * DELETE; the DELETE is gated on pull+commit success, and on failure the VM is
 * KEPT (state left 'closing' for the closing reaper's recovery re-pull, §6.5).
 *
 * Ordering rationale (see report): the ORIGINAL live plane is DRAINED (dispose,
 * which awaits our in-flight fs/exec REMOTE CALLS to settle) WITHOUT control.kill.
 * (R6 H-1) The drain is NOT a VM writer-freeze — it bounds only the calls WE issued,
 * not VM-side execution. This deployment's control client exposes no pause/suspend
 * (and pausing a microVM risks suspending envd itself, making the pull unreachable),
 * so a VM process that OUTLIVES its exec call — a detached `nohup &`, or a slow
 * background child — may still write during the PULL. The PULL is therefore a
 * point-in-time snapshot, not a frozen one: a write racing the scan is captured-or-not
 * atomically per file and reconciled by the commit's 3-way merge (never torn), and a
 * write landing after the scan is simply not captured this turn. This residual is
 * bounded by how briefly a teardown runs; there is no cheap active-kill (no
 * selective-signal API — only DELETE, which must follow the pull). The PULL runs on a
 * freshly-RECONNECTED token-bearing transport (never the disposed plane, never a
 * token-less connect).
 */
async function teardownOffBoxSandbox(args: TeardownOffBoxArgs): Promise<void> {
  const { sessionId, run, ctx, mounts, runtimeId, ref, adapter, options } = args

  // ① CLOSE-GATE (non-swallowing, §6.6 #5-A): CAS the row to 'closing' ONLY when it
  // is still non-terminal. A false means the row is already terminal or another
  // teardown owns the lifecycle → ABORT rather than kill+commit under an unset
  // fence (which would violate the R3.8 exactly-one-when-active invariant).
  const { flipped, epoch } = await repo.casFlipSandboxClosing(runtimeId, run)
  if (!flipped || epoch === null) {
    log.warn(
      { sessionId, runtimeId },
      "off-box teardown: close-gate CAS lost (row terminal or a concurrent teardown owns it) — aborting"
    )
    return
  }
  markBareDataPlaneClosing(runtimeId)

  try {
    // ② DRAIN the ORIGINAL live plane (awaitFsIdle/awaitExecIdle live inside
    // dispose) WITHOUT control.kill — settle writers that already passed the gate.
    const livePlane = unregisterBareDataPlane(runtimeId)
    if (livePlane) await livePlane.dispose().catch(() => {})
    const liveHandle = liveSandboxHandles.get(sessionId)
    if (liveHandle) liveSandboxHandles.delete(sessionId)

    // ③ PAUSE — SKIPPED (see doc-comment). ④ RECONNECT + ⑤ PULL + ⑥ COMMIT.
    let pullOk = true
    let commitOk = true
    if (mounts.length > 0) {
      let wsBridge: OffBoxWorkingSetBridge | null = null
      try {
        // Decrypt the persisted creds so reconnect can FALL BACK to them when the
        // deployment's connect does not re-mint (§6.2).
        const persisted =
          (await repo.getBareSandboxForDispatch(runtimeId, run))?.credentials ??
          null
        const rc = await adapter.reconnectDataPlane(ref, {
          persistedCredentials: persisted,
          executor: run,
          workspaceId: ctx?.workspaceId,
        })
        // The reconnect's confined plane is unused here — we drive the raw
        // working-set transport (built from the same token-bearing creds).
        await rc.plane.dispose().catch(() => {})
        wsBridge = adapter.workingSet({
          resourceId: ref.resourceId,
          credentials: rc.credentials,
        })
        // ⑤ PULL each mount VM→mirror(materializedDir) with delete-prune (F1). The
        // off-box bridge's `pull` is type-REQUIRED (#6) — no optional guard.
        for (const mount of mounts) {
          if (mount.materializedDir) {
            const outcome = await wsBridge.pull({ dir: mount.materializedDir })
            // (R6 #3) DURABILITY: if any file could not be read/streamed, the pull did
            // NOT capture the VM's bytes — treat it as a FAILED pull so the ⑦ gate
            // preserves the VM (never delete the sole copy) instead of the R5 behavior
            // that silently lost >10 MiB files.
            if (outcome.unreadable.length > 0) {
              pullOk = false
              log.error(
                {
                  sessionId,
                  runtimeId,
                  mount: mount.id,
                  unreadable: outcome.unreadable,
                },
                "off-box teardown PULL left unreadable file(s) — VM preserved (not durable)"
              )
            }
          }
        }
      } catch (err) {
        pullOk = false
        log.error(
          { sessionId, runtimeId, err },
          "off-box teardown reconnect/pull failed — preserving VM for recovery re-pull"
        )
      } finally {
        // (R4 review fix) release the pull bridge's undici Agent.
        await wsBridge?.dispose?.()
      }

      // ⑥ COMMIT (scan the PULLED mirror = materializedDir) only if the pull
      // succeeded. Same fail-closed commit semantics as the host path.
      if (pullOk) {
        try {
          const commitOverride: Partial<CommitDeps> | undefined =
            options.executor
              ? {
                  dbh: run,
                  loadCtx: (sid) => loadSessionContext(sid, run),
                  runInTx: (fn) => fn(run),
                }
              : undefined
          await commitSpaces(
            sessionId,
            ["conversation", "actor", "actor-conversation"],
            commitOverride
          )
        } catch (err) {
          commitOk = false
          log.error({ sessionId, err }, "off-box teardown commit failed")
        }
      } else {
        commitOk = false
      }
    }

    // ⑦-guard: a 'closing' off-box row RE-DRIVEN by the closing reaper with NO
    // active mounts may still have FAILED mounts pending a recovery re-pull (their
    // materializedDir under sandboxRootFor is the preserved, not-yet-committed
    // work). DELETEing the VM + rm(sandboxRoot) now would destroy it — defer to
    // recoverFailedSandboxMounts (which reconnect→pull→commits, THEN kills).
    if (
      mounts.length === 0 &&
      (await sessionHasFailedRecoverableMounts(run, sessionId))
    ) {
      // (R5 #4 review-fix) Defer for recovery re-pull ONLY while attempts remain.
      // teardown_epoch (== the lease captured at THIS flip) counts close-gate re-
      // drives; once it hits the cap, the keepalive has already stopped and the
      // provider TTL has reclaimed the VM, so the preserved-but-un-pulled work is
      // unrecoverable — converge terminal + ACCEPT THE LOSS loudly instead of
      // re-driving (and renewing) forever.
      if (epoch < BigInt(MAX_OFFBOX_RECOVERY_ATTEMPTS)) {
        log.warn(
          { sessionId, runtimeId, attempt: epoch.toString() },
          "off-box teardown: no active mounts but FAILED recoverable mounts pending — leaving VM + state='closing' for recovery re-pull"
        )
        return
      }
      log.error(
        { sessionId, runtimeId, attempts: epoch.toString() },
        "off-box teardown: recovery attempts EXHAUSTED — converging terminal + ACCEPTING DATA LOSS (VM presumed reclaimed by its provider TTL)"
      )
      await closeSessionFailedMounts(run, sessionId).catch(() => {})
      await rm(sandboxRootFor(sessionId), {
        recursive: true,
        force: true,
      }).catch(() => {})
      await cleanupDirs([sandboxRootFor(sessionId)]).catch(() => {})
      if (ctx) {
        await revokeSandboxGrants({
          workspaceId: ctx.workspaceId,
          runtimeId,
          actorId: ctx.actorId,
          conversationId: ctx.conversationId,
          executor: run,
        }).catch((err) => log.error({ sessionId, err }, "revoke grants failed"))
        const closed = await repo
          .casCloseSandboxAtEpoch(runtimeId, epoch, { state: "failed" }, run)
          .catch(() => false)
        // (R6 #5) soft-delete only when the terminal CAS won (still hold the lease).
        if (closed) {
          await deleteRuntime(ctx.workspaceId, runtimeId, run).catch((err) =>
            log.error({ sessionId, err }, "soft-delete runtime failed")
          )
        }
      }
      return
    }

    // (#6) Re-check the teardown lease BEFORE EITHER terminal branch — the DELETE
    // cluster AND the ⑦-fail mark-mounts-'failed' branch. A concurrent teardown
    // (another replica) that re-flipped this row bumped the epoch past N, so a
    // SUPERSEDED teardown must touch NOTHING and abort (leaving state='closing' for
    // the current owner to converge). CRITICAL that this is NOT gated on
    // pull+commit success: a superseded loser whose pull FAILED *because the winner
    // already DELETEd the shared VM* (pullOk=false) would otherwise fall through to
    // the ⑦-fail branch and clobber the winner's just-'closed' mounts back to
    // 'failed'. The pull+commit above are non-destructive/idempotent, so a loser
    // having run them is harmless. (This must run AFTER the ⑦-guard so a legit
    // failed-recoverable defer still wins.)
    if (!(await stillHoldsTeardownLease(runtimeId, epoch, run))) {
      log.info(
        { sessionId, runtimeId },
        "off-box teardown: superseded (teardown_epoch advanced) — leaving to the current owner (no DELETE, no mount-state change)"
      )
      return
    }

    // ⑦ GATE the DELETE on pull+commit success.
    if (pullOk && commitOk) {
      // Pull+commit durable → NOW DELETE the VM (best-effort; the row goes terminal
      // regardless — a stranded VM is swept by its create() TTL / the orphan sweep).
      try {
        const killHandle = liveHandle ?? (await adapter.connect(ref))
        await killHandle.kill().catch(() => {})
      } catch (err) {
        log.error(
          { sessionId, runtimeId, err },
          "off-box teardown: VM DELETE failed after successful pull+commit (TTL/orphan-sweep backstops)"
        )
      }
      // delete the live mirror dirs (CAS is the source of truth) + close mounts.
      await rm(sandboxRootFor(sessionId), {
        recursive: true,
        force: true,
      }).catch(() => {})
      await cleanupDirs([sandboxRootFor(sessionId)]).catch(() => {})
      for (const mount of mounts) {
        await updateFileMount(run, mount.id, {
          status: "closed",
          closedAt: true,
        }).catch(() => {})
      }
      // revoke grants + terminal state + soft-delete (state already 'closing' from
      // the close-gate, so this satisfies the R3.8 exactly-one-when-active trigger).
      if (ctx) {
        await revokeSandboxGrants({
          workspaceId: ctx.workspaceId,
          runtimeId,
          actorId: ctx.actorId,
          conversationId: ctx.conversationId,
          executor: run,
        }).catch((err) => log.error({ sessionId, err }, "revoke grants failed"))
        // (#6) epoch-fenced terminal write — no-ops if a concurrent teardown took the
        // lease in the window since the re-check (row then stays 'closing' for the
        // reaper to converge; the VM is already gone, so kill is idempotent).
        const closed = await repo
          .casCloseSandboxAtEpoch(runtimeId, epoch, { state: "closed" }, run)
          .catch(() => false)
        // (R6 #5) soft-delete ONLY when the terminal CAS WON (we still hold the lease)
        // — closes the re-check→CAS TOCTOU so a superseded teardown can't soft-delete
        // a runtime the current owner is mid-teardown on.
        if (closed) {
          await deleteRuntime(ctx.workspaceId, runtimeId, run).catch((err) =>
            log.error({ sessionId, err }, "soft-delete runtime failed")
          )
        }
      }
    } else {
      // ⑦-fail: PULL/COMMIT FAILED → KEEP the VM alive (its unpulled bytes are the
      // sole source of truth), mark mounts 'failed' (preserving materializedDir),
      // and LEAVE state='closing' so the closing reaper re-drives recovery (§6.5).
      // NEVER kill / soft-delete here — that would DELETE unpulled agent work.
      const stage = pullOk ? "commit" : "pull"
      for (const mount of mounts) {
        await updateFileMount(run, mount.id, {
          status: "failed",
          errorMessage: `off-box teardown ${stage} failed (VM preserved for recovery re-pull)`,
        }).catch(() => {})
      }
      log.error(
        { sessionId, runtimeId, pullOk, commitOk },
        `off-box teardown ${stage} failed — VM preserved, left state='closing' for the closing reaper`
      )
    }
  } finally {
    // Always clear the in-process close-gate tombstone. The DB state
    // ('closing'/'closed') keeps denying rebuilds thereafter.
    clearBareDataPlaneClosing(runtimeId)
  }
}

/**
 * Teardown (R3.7 REORDERED — no lost write, trigger-safe). The order is now
 * CLOSE-GATE → STOP writer → CONFIRM-DEAD → FINAL commit → cleanup, so:
 *   1. CLOSE-GATE: flip the sandbox OUT of state='active' (→ 'closing') AND set an
 *      in-process bare tombstone BEFORE anything else. This (a) closes the
 *      dispatch window — no new/reused bare plane can start in this process while
 *      we tear down (the DB 'closing' closes the cross-process window), and (b)
 *      satisfies the R3.8 trigger: every subsequent service detach / soft-delete
 *      happens while state is non-'active', so the exactly-one-when-active
 *      invariant is never violated at commit.
 *   2. STOP the writer (kill: bare-plane dispose / local SIGTERM+KILL on identity
 *      match / docker stop+rm) — the plane's own dispose is the in-boundary drain.
 *   3. CONFIRM-DEAD via the R3.4 tristate probe. 'alive' OR 'unknown' ⇒ do NOT
 *      commit-then-delete (that could lose a write to a live process or snapshot a
 *      dir under active write, and would strand a live container). Leave state=
 *      'closing' + preserve dirs/mounts/grants for the reaper, and RETURN.
 *   4. FINAL commit runs ONLY on confirmed 'dead' — so no writer can mutate the dir
 *      after the commit scan (the lost-write the old commit-before-stop order had).
 *   5. cleanup: on commit success delete dirs + close mounts; on failure PRESERVE
 *      dirs + mark mounts 'failed' (uncommitted data is never thrown away). Then
 *      revoke grants + flip state closed/failed + soft-delete the runtime.
 * The in-process tombstone is always cleared in the finally (both branches).
 */
export async function teardownSandbox(
  sessionId: string,
  options: TeardownSandboxOptions = {}
): Promise<void> {
  // ALL reads AND writes on the teardown path run on `run`: the injected
  // executor (crash-recovery WRITE path / reaper test) or the top-level db in
  // prod. Threading it through the reads too (loadSessionContext,
  // getActiveMountsForSession, the commit's loadCtx) is load-bearing — a test on
  // a single rolled-back connection can only see its own uncommitted session +
  // mounts, and without it the grant/runtime terminal block below is skipped.
  const run = options.executor ?? repo.defaultDbh()

  // (R5 #3) When the caller (the closing reaper) targets a SPECIFIC runtime, and a
  // NEWER live sandbox already owns the session (re-provisioned while this 'closing'
  // straggler lingered), converge the straggler DATA-FREE — never fall through to the
  // session-scoped resolution below, which would grab the NEW runtime's mounts/handle/
  // mirror and kill/wipe/commit IT (the design-review wrong-VM hazard).
  if (options.runtimeId) {
    if (
      await repo.sessionHasNewerLiveSandbox(sessionId, options.runtimeId, run)
    ) {
      await teardownStaleRuntimeDataFree(sessionId, options.runtimeId, run)
      return
    }
  }

  const ctx = await loadSessionContext(sessionId, run)
  const mounts = await getActiveMountsForSession(run, sessionId)

  // Resolve the owning runtime id. When the caller pinned a runtimeId (#3), that is
  // authoritative (bypasses the mounts / createdAt-DESC resolver — the wrong-VM
  // source). Otherwise: from mounts OR (R3.5(D) mount-less sandbox) the by-session
  // control resolver, so a mount-less non-terminal sandbox is still reapable. A
  // session with NO mounts AND no owning row is a true no-op.
  let runtimeId = options.runtimeId || runtimeIdFromMounts(mounts) || null
  if (!runtimeId) {
    runtimeId =
      (await repo.getSandboxBySessionForControl(sessionId, run))?.id ?? null
  }
  if (mounts.length === 0 && !runtimeId) return

  // (R4 §6.3, P0) OFF-BOX teardown fork. An off-box VM is the SOLE store of the
  // turn's work — it must be PULLED before the VM is DELETEd. Resolve the owning
  // adapter (row-driven) and, when it is off-box, hand off to the
  // drain→reconnect→PULL→commit→gate-DELETE ordering. Host adapters (compute-only,
  // bytes in the host dir throughout) keep the kill-then-commit order below.
  // adapterForRow is wrapped so an unknown/legacy tag can't throw — it falls
  // through to the host path (which resolves its own connect-only adapter).
  if (runtimeId) {
    // (R6 #5) resolve the ref from the PINNED runtime so the reconnect/PULL/DELETE
    // targets exactly the runtime we flipped, never a newer session sandbox.
    const offBoxRef = await buildSandboxRefFromSandboxRow(
      mounts,
      run,
      sessionId,
      runtimeId
    )
    if (offBoxRef) {
      let offBoxAdapter: SandboxAdapter | null = null
      try {
        offBoxAdapter = adapterForRow(offBoxRef.adapter, offBoxRef.mode)
      } catch {
        offBoxAdapter = null
      }
      if (offBoxAdapter && isOffBoxAdapter(offBoxAdapter)) {
        await teardownOffBoxSandbox({
          sessionId,
          run,
          ctx,
          mounts,
          runtimeId,
          ref: offBoxRef,
          adapter: offBoxAdapter,
          options,
        })
        return
      }
    }
  }

  // ① CLOSE-GATE (R3.7 step 1): state OUT of 'active' + in-process tombstone,
  // BEFORE stopping the writer. Deny same-process bare dispatch (tombstone) +
  // cross-process rebuild (DB 'closing'); satisfy the R3.8 exactly-one-when-active
  // invariant for every write below.
  // (R4 §3.4 #5 Link A) The fence-lay write is a CAS that must NOT be swallowed: if
  // it flips 0 rows the row already went terminal (closed/failed) — another teardown
  // / reaper owns the lifecycle and ALREADY closed this row's mounts (every terminal
  // transition does) — so BAIL rather than kill+commit under an unset fence. (A
  // 'closing'→'closing' self-flip returns true, so the closing-retry reaper still
  // re-drives an in-progress teardown.)
  // (#6) The teardown LEASE captured at the close-gate flip. Non-null whenever
  // runtimeId is truthy and we pass the gate below; re-checked before the
  // irreversible tail so a concurrent teardown that took the lease aborts this one.
  let teardownEpoch: bigint | null = null
  if (runtimeId) {
    let flip: { flipped: boolean; epoch: bigint | null }
    try {
      flip = await repo.casFlipSandboxClosing(runtimeId, run)
    } catch (err) {
      // A transient DB error leaves the fence state UNKNOWN — do NOT proceed to
      // kill+commit under an unset fence; bail so the closing reaper / reconcile
      // re-drives on a later pass.
      log.error(
        { sessionId, runtimeId, err },
        "teardown: close-gate CAS threw — bailing (retry next reaper pass)"
      )
      return
    }
    if (!flip.flipped || flip.epoch === null) {
      log.info(
        { sessionId, runtimeId },
        "teardown: close-gate CAS flipped 0 rows (already terminal / owned elsewhere) — bailing without kill/commit"
      )
      return
    }
    teardownEpoch = flip.epoch
    markBareDataPlaneClosing(runtimeId)
  }

  try {
    // ② STOP the writer + ③ CONFIRM-DEAD (R3.7 steps 2-4). Prefer the in-process
    // handle (keyed by sessionId); else rebuild a SandboxRef via the STATE-AGNOSTIC
    // control resolver (by explicit sessionId, so a mount-less sandbox resolves)
    // and reconnect via the SAME adapter that created it. kill() disposes the bare
    // plane (aborting its exec children — the in-boundary drain) / SIGTERM+KILLs a
    // local child on identity match / docker stop+rm. The R3.4 tristate probe then
    // decides: only a CONFIRMED 'dead' runtime proceeds to commit+delete.
    const liveHandle = liveSandboxHandles.get(sessionId)
    let stillAlive = false
    if (liveHandle) {
      await liveHandle.kill().catch(() => {})
      // R3.4: shield on 'alive' OR 'unknown' (a torn/failed probe must NOT lead to
      // deleting the sole tracking record of a possibly-live runtime).
      const live = await liveHandle
        .probeLiveness()
        .catch((): SandboxLiveness => "unknown")
      stillAlive = live !== "dead"
      if (!stillAlive) liveSandboxHandles.delete(sessionId)
    } else {
      // (R6 #5) target the PINNED runtime (runtimeId is authoritative here).
      const ref = await buildSandboxRefFromSandboxRow(
        mounts,
        run,
        sessionId,
        runtimeId ?? undefined
      )
      if (ref) {
        try {
          const adapter = adapterForKind(ref)
          const handle = await adapter.connect(ref)
          await handle.kill()
          const live = await handle
            .probeLiveness()
            .catch((): SandboxLiveness => "unknown")
          stillAlive = live !== "dead"
        } catch (err) {
          log.error(
            { sessionId, adapter: ref.adapter, err },
            "teardown could not kill runtime via adapter"
          )
          // Could not even connect/kill → possibly-alive → leave for the reaper.
          stillAlive = true
        }
      }
    }

    // ③ (R3.4/R3.7): survived the kill OR liveness UNKNOWN → do NOT commit-then-
    // delete. State is already 'closing' (still reconcile-visible); PRESERVE
    // dirs/mounts/grants so reconcileSandboxes retries the whole teardown next
    // startup. (For docker the label reaper backstops a genuinely-wedged
    // container; for local on a non-Linux host an unverifiable pid stays 'closing'
    // — the accepted PID-reuse-safe trade-off.)
    if (stillAlive) {
      log.warn(
        { sessionId, runtimeId },
        "teardown: runtime still alive/unknown after kill — left state='closing' for the reaper (tracking + live dirs preserved)"
      )
      return
    }

    // ④ FINAL commit (R3.7 step 5) — now that the writer is CONFIRMED dead, commit
    // all dirty spaces. No writer can mutate the dir past this point, so no write
    // is lost (the bug the old commit-before-stop order carried). Skipped when
    // there are no mounts (a mount-less orphan sandbox).
    let commitOk = true
    let commitError: unknown = null
    if (mounts.length > 0) {
      try {
        const commitOverride: Partial<CommitDeps> | undefined = options.executor
          ? {
              dbh: run,
              loadCtx: (sid) => loadSessionContext(sid, run),
              runInTx: (fn) => fn(run),
            }
          : undefined
        await commitSpaces(
          sessionId,
          ["conversation", "actor", "actor-conversation"],
          commitOverride
        )
      } catch (err) {
        commitOk = false
        commitError = err
        log.error({ sessionId, err }, "teardown commit failed")
      }

      if (!commitOk) {
        // Commit failed → PRESERVE the live dirs. Mark mounts 'failed' (keeping
        // materialized_dir) so the data can be recovered/retried later.
        const message =
          commitError instanceof Error
            ? commitError.message
            : String(commitError)
        for (const mount of mounts) {
          await updateFileMount(run, mount.id, {
            status: "failed",
            errorMessage: `teardown commit failed (live dir preserved at ${mount.materializedDir}): ${message}`,
          }).catch(() => {})
        }
        log.error(
          { sessionId, sandboxRoot: sandboxRootFor(sessionId) },
          "teardown commit failed — preserved live dirs for recovery"
        )
      }
    }

    // (#6) Re-check the teardown lease RIGHT BEFORE the irreversible tail (rm the
    // live dirs + close mounts + terminal state + soft-delete). commitSpaces above is
    // non-destructive (re-scanning the same mirror is idempotent), so a superseded
    // teardown having committed is harmless; but the rm + terminal writes must be
    // single-owner. If a concurrent teardown/reaper took the lease (epoch != N) we
    // ABORT here, leaving state='closing' + the live dirs for that owner — critically
    // preventing a stale loser from rm'ing the dir out from under the winner's commit,
    // then stamping 'failed' over the winner's 'closed'. (No fence was laid for a
    // runtime-less orphan, so it keeps its unfenced tail.)
    if (
      runtimeId &&
      teardownEpoch !== null &&
      !(await stillHoldsTeardownLease(runtimeId, teardownEpoch, run))
    ) {
      log.info(
        { sessionId, runtimeId },
        "teardown: superseded (teardown_epoch advanced) before the destructive tail — leaving to the current owner"
      )
      return
    }

    if (mounts.length > 0 && commitOk) {
      // delete the live dirs (CAS is the source of truth; dirs are scratch).
      await rm(sandboxRootFor(sessionId), {
        recursive: true,
        force: true,
      }).catch(() => {})
      await cleanupDirs([sandboxRootFor(sessionId)]).catch(() => {})
      for (const mount of mounts) {
        await updateFileMount(run, mount.id, {
          status: "closed",
          closedAt: true,
        }).catch(() => {})
      }
    }

    // ⑤ revoke grants + flip the sandbox row terminal + ⑥ soft-delete the runtime
    // (keeps children for audit). CRITICAL (R3.8): state is already 'closing'
    // (non-'active') from the CLOSE-GATE, so this terminal flip + soft-delete
    // satisfies the exactly-one-when-active trigger. The runtime is per-session and
    // can't be reused, so it's removed even on a failed commit.
    //
    // ctx is GUARANTEED non-null whenever runtimeId resolved: both resolvers above
    // are session-keyed (runtimeIdFromMounts / getSandboxBySessionForControl match on
    // sandboxes.session_id = sessionId), and sandboxes.session_id is ON DELETE SET
    // NULL — so a purged session NULLs session_id, which makes the sandbox
    // unresolvable here at all (and drops it from reconcile's session_id candidate
    // list) rather than reaching this block with a null ctx. loadSessionContext
    // therefore always finds the row. (Verified against the schema FKs — do not add a
    // no-ctx branch; it would be unreachable.)
    if (ctx && runtimeId) {
      await revokeSandboxGrants({
        workspaceId: ctx.workspaceId,
        runtimeId,
        actorId: ctx.actorId,
        conversationId: ctx.conversationId,
        executor: run,
      }).catch((err) => log.error({ sessionId, err }, "revoke grants failed"))
      // (#6) epoch-fenced terminal write when a lease was laid (runtimeId path always
      // lays one). No-ops if a concurrent teardown took the lease in the window since
      // the re-check above → the row stays 'closing' for that owner to converge,
      // instead of this teardown stamping a stale terminal state.
      const terminalState = commitOk ? "closed" : "failed"
      // (R6 #5) soft-delete only when the terminal write LANDED under our lease. With a
      // lease, that is the epoch CAS winning; without one (a runtime-less orphan lays no
      // lease), the plain write always lands.
      let terminalWon = true
      if (teardownEpoch !== null) {
        terminalWon = await repo
          .casCloseSandboxAtEpoch(
            runtimeId,
            teardownEpoch,
            { state: terminalState },
            run
          )
          .catch(() => false)
      } else {
        await repo
          .updateSandboxRow(runtimeId, { state: terminalState }, run)
          .catch(() => {})
      }
      if (terminalWon) {
        await deleteRuntime(ctx.workspaceId, runtimeId, run).catch((err) =>
          log.error({ sessionId, err }, "soft-delete runtime failed")
        )
      }
    }
  } finally {
    // R3.7: always clear the in-process close-gate tombstone (both the preserve
    // and terminal branches). The DB state='closing'/'closed' keeps denying
    // rebuilds thereafter, so clearing the in-memory set is safe.
    if (runtimeId) clearBareDataPlaneClosing(runtimeId)
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }, 2_000).unref?.()
}

export interface RecoverFailedMountsResult {
  attempted: number
  recovered: number
  stillFailed: number
}

/**
 * Startup reconciler: retry the commit for mounts left in 'failed' state with a
 * preserved live dir (a teardown commit that failed earlier). On success the
 * mount's snapshot is appended and the mount is closed + its live dir removed;
 * on repeated failure it's left 'failed' for the next sweep / manual triage.
 *
 * SAFETY (round-3 #2): teardown swallows a failed kill, so a 'failed' mount may
 * still have a LIVE runtime/command writing into its live dir. Committing then
 * would snapshot a moving target. Before committing a session's mounts we
 * confirm the runtime is gone — and if it isn't, we try once more to kill it via
 * the persisted ref; if it's STILL alive we skip that session this round (leaving
 * it 'failed' for the next sweep) rather than snapshot a dir under active write.
 *
 * This is the code-level recovery entry for the "preserve on commit failure"
 * teardown path — without it a failed mount's data would only be recoverable by
 * hand. Best-effort and idempotent: safe to call on every API startup.
 */
export async function recoverFailedSandboxMounts(): Promise<RecoverFailedMountsResult> {
  const run = repo.defaultDbh()
  // (R6 H-2) CLAIM a durable lease on each failed-recoverable mount BEFORE touching its
  // VM: CAS 'failed'→'recovering' under FOR UPDATE SKIP LOCKED so a second replica / the
  // racing periodic sweep can't double-recover the same VM+dir. Claimed rows stay
  // failed-recoverable (keepalive + #4 defer keep the VM) but are not live mounts. Any
  // claim that does NOT reach 'closed' this sweep is released back to 'failed' in the
  // finally; a crash skips the release and the TTL reclaims the stale lease.
  const claimed = await claimFailedRecoverableMounts(
    run,
    RECOVERY_LEASE_TTL_SECONDS
  )
  const claimedIds = claimed.map((m) => m.id as string)

  let recovered = 0
  let stillFailed = 0
  try {
    // (R6 #4/#5) Group by SANDBOX_ID — each sandbox is an INDEPENDENT VM. #4 keeps a
    // superseded straggler + its VM alive while it owns failed-recoverable mounts, so
    // two generations' failed mounts can coexist for ONE session; a single session-
    // resolved ref would pull the WRONG VM into another generation's mirror. Grouping by
    // sandbox_id + pinning the ref to that runtime pulls each mount from its OWN VM. A
    // mount with no sandbox_id (should not occur for a failed recoverable mount) falls
    // back to a session-keyed group resolved by-session (host path).
    const bySandbox = new Map<string, FileMountRow[]>()
    for (const mount of claimed) {
      const key =
        (mount.sandboxId as string | null) ?? `session:${mount.sessionId}`
      const list = bySandbox.get(key)
      if (list) list.push(mount)
      else bySandbox.set(key, [mount])
    }

    for (const [groupKey, sessionMounts] of bySandbox) {
      const sessionId = sessionMounts[0]!.sessionId as string
      const pinnedRuntimeId = groupKey.startsWith("session:")
        ? undefined
        : groupKey
      // (R4 §6.5, F2) OFF-BOX recovery fork. An off-box VM whose bytes are UNPULLED
      // must be RECONNECTED + PULLED + committed BEFORE it is killed — never the
      // host "confirm-dead then commit the host dir" path (which would commit a
      // never-pulled empty mirror and lose all VM work). Resolve the owning adapter
      // row-driven (pinned to THIS sandbox); when off-box, hand off to recoverOffBoxSession.
      const recoveryRef = await buildSandboxRefFromSandboxRow(
        sessionMounts,
        repo.defaultDbh(),
        sessionId,
        pinnedRuntimeId
      )
      if (recoveryRef) {
        let recoveryAdapter: SandboxAdapter | null = null
        try {
          recoveryAdapter = adapterForRow(recoveryRef.adapter, recoveryRef.mode)
        } catch {
          recoveryAdapter = null
        }
        if (recoveryAdapter && isOffBoxAdapter(recoveryAdapter)) {
          const res = await recoverOffBoxSession(
            sessionId,
            sessionMounts,
            recoveryRef,
            recoveryAdapter
          )
          recovered += res.recovered
          stillFailed += res.stillFailed
          continue
        }
      }

      // Confirm the runtime is stopped before snapshotting. If it's still alive
      // (teardown's kill was swallowed), make ONE more attempt to stop it via the
      // persisted ref, then re-check. A runtime that survives both is left for the
      // next sweep — never committed under it.
      const stopped = await ensureRuntimeStoppedForRecovery(
        sessionId,
        sessionMounts
      )
      if (!stopped) {
        stillFailed += sessionMounts.length
        console.error(
          `[sandbox] recovery: runtime for session ${sessionId} is still alive after a kill attempt; ` +
            `leaving ${sessionMounts.length} mount(s) 'failed' rather than snapshot a live dir`
        )
        continue
      }
      for (const mount of sessionMounts) {
        const outcome = await recoverOneFailedMount(mount)
        if (outcome === "recovered") recovered++
        else if (outcome === "stillFailed") stillFailed++
        // "skipped" (live dir already gone) counts as neither — it's a clean close.
      }
    }
  } finally {
    // (R6 H-2) release every lease that did NOT reach 'closed' this sweep back to
    // 'failed', so the next sweep re-claims it immediately (a clean, non-crash failure).
    // A worker that CRASHED skips this — its 'recovering' rows are reclaimed via the TTL.
    await releaseRecoveryClaims(run, claimedIds).catch(() => {})
  }
  return { attempted: claimed.length, recovered, stillFailed }
}

/**
 * (R6 H-5) Tear down the off-box sandbox of every crash-'blocked' session. On restart
 * recoverInterruptedExecutions marks each interrupted session 'blocked' but does NOT
 * tear down its sandbox; reconcile then SHIELDS a healthy off-box VM, so the provider
 * keepalive renews its TTL forever (the infinite-renew leak). Tear each down
 * best-effort (a pinned-runtime teardown → pull the VM into the mirror, commit, delete)
 * so the work commits and the VM is released. Off-box ONLY: host/resident sandboxes
 * have no provider TTL (resource_id='') and their dead process is reaped by reconcile;
 * docker is provider-backed but not off-box, so the adapter check skips it. Runs BEFORE
 * recoverFailedSandboxMounts so a teardown that leaves a mount 'failed' is re-pulled by
 * the same startup sweep.
 */
export async function teardownBlockedSessionOffBoxSandboxes(): Promise<{
  tornDown: number
}> {
  const run = repo.defaultDbh()
  const candidates = await repo.listBlockedSessionLiveSandboxes(run)
  let tornDown = 0
  for (const c of candidates) {
    let offBox = false
    try {
      const adapter = adapterForRow(c.adapter, c.mode)
      offBox = isOffBoxAdapter(adapter)
    } catch {
      offBox = false // unknown/legacy tag → not off-box, leave to reconcile
    }
    if (!offBox) continue
    try {
      // Pin the runtime so the teardown targets exactly this blocked sandbox (never a
      // resolver-picked sibling), and pull-before-delete preserves its unpulled work.
      await teardownSandbox(c.sessionId, { runtimeId: c.runtimeId })
      tornDown++
    } catch (err) {
      log.error(
        { sessionId: c.sessionId, runtimeId: c.runtimeId, err },
        "H-5: blocked-session off-box teardown failed (keepalive TTL + reaper backstop)"
      )
    }
  }
  return { tornDown }
}

/**
 * (R4 §6.5, F2) OFF-BOX recovery — reconnect → PULL → commit → THEN kill. A
 * 'failed'-mount off-box sandbox reached recovery because a prior teardown pull/
 * commit failed and LEFT the VM alive with unpulled work; re-pull it (over a
 * token-bearing reconnect transport) into each mount's mirror, commit the mirror,
 * and only after ALL mounts commit DELETE the VM + soft-delete the runtime. On a
 * pull failure the mounts stay 'failed' and the VM stays alive for the next sweep
 * (never a kill-before-pull that would lose the bytes).
 */
async function recoverOffBoxSession(
  sessionId: string,
  sessionMounts: FileMountRow[],
  ref: SandboxRef,
  // (#13) narrowed off-box adapter → reconnectDataPlane is called without a `!`.
  adapter: OffBoxBareAdapter
): Promise<{ recovered: number; stillFailed: number }> {
  const run = repo.defaultDbh()
  const runtimeId = ref.runtimeId
  // ① reconnect a token-bearing transport + PULL each mount VM→mirror (VM alive).
  let wsBridge: OffBoxWorkingSetBridge | null = null
  try {
    const persisted =
      (await repo.getBareSandboxForDispatch(runtimeId, run))?.credentials ??
      null
    const rc = await adapter.reconnectDataPlane(ref, {
      persistedCredentials: persisted,
      executor: run,
      workspaceId: sessionMounts[0]?.workspaceId,
    })
    await rc.plane.dispose().catch(() => {})
    wsBridge = adapter.workingSet({
      resourceId: ref.resourceId,
      credentials: rc.credentials,
    })
    for (const mount of sessionMounts) {
      // (#6) off-box `pull` is type-REQUIRED — no optional guard.
      if (mount.materializedDir) {
        const outcome = await wsBridge.pull({ dir: mount.materializedDir })
        // (R6 #3) an unreadable file means the recovery pull is NOT durable — throw so
        // the catch leaves the mounts 'failed' + the VM preserved for a later re-pull,
        // rather than committing a partial mirror.
        if (outcome.unreadable.length > 0) {
          throw new SandboxServiceError(
            `off-box recovery pull left unreadable file(s): ${outcome.unreadable.join(", ")}`,
            503
          )
        }
      }
    }
  } catch (err) {
    console.error(
      `[sandbox] off-box recovery: reconnect/pull failed for session ${sessionId}; ` +
        `leaving ${sessionMounts.length} mount(s) 'failed', VM preserved:`,
      err
    )
    return { recovered: 0, stillFailed: sessionMounts.length }
  } finally {
    // (R4 review fix) release the recovery pull bridge's undici Agent.
    await wsBridge?.dispose?.()
  }

  // ② commit each mount (scans the mirror the pull populated) — same engine as host.
  let recovered = 0
  let stillFailed = 0
  let allCommitted = true
  for (const mount of sessionMounts) {
    const outcome = await recoverOneFailedMount(mount)
    if (outcome === "recovered") recovered++
    else if (outcome === "stillFailed") {
      stillFailed++
      allCommitted = false
    }
    // "skipped" (dir already gone) counts as neither.
  }

  // ③ only after EVERY mount committed → DELETE the VM + terminal + soft-delete.
  if (allCommitted) {
    try {
      const handle = await adapter.connect(ref)
      await handle.kill().catch(() => {})
    } catch (err) {
      console.error(
        `[sandbox] off-box recovery: VM DELETE failed for ${sessionId} (TTL/orphan-sweep backstops):`,
        err
      )
    }
    const ctx = await loadSessionContext(sessionId, run)
    if (ctx) {
      await repo
        .updateSandboxRow(runtimeId, { state: "closed" }, run)
        .catch(() => {})
      await deleteRuntime(ctx.workspaceId, runtimeId, run).catch(() => {})
    }
  }
  return { recovered, stillFailed }
}

/**
 * Confirm the per-session sandbox runtime is NOT alive before recovery commits
 * snapshot its live dirs. Returns true when it's already gone or we successfully
 * killed it; false when it's still alive after a kill attempt (caller must skip).
 *
 * (R4 §6.5, F2) An OFF-BOX runtime must NEVER reach here — its bytes live in the
 * VM and are pulled by recoverOffBoxSession, not confirmed-dead-then-host-committed.
 * As defense-in-depth, if an off-box ref is somehow routed here, return FALSE (skip
 * the generic host commit) so a never-pulled empty mirror is never snapshotted.
 */
async function ensureRuntimeStoppedForRecovery(
  sessionId: string,
  mounts: FileMountRow[]
): Promise<boolean> {
  // (R4 §6.5, F2) Defense-in-depth: an off-box runtime's mirror is populated by a
  // PULL, not by confirming the VM dead. If one is routed here, refuse the generic
  // host commit (return false) so an unpulled empty mirror is never snapshotted.
  const ref = await buildSandboxRefFromSandboxRow(mounts, repo.defaultDbh())
  if (ref) {
    try {
      if (isOffBoxAdapter(adapterForRow(ref.adapter, ref.mode))) {
        console.warn(
          `[sandbox] recovery: off-box runtime for session ${sessionId} reached the ` +
            `host-commit gate; skipping (off-box recovery pulls first)`
        )
        return false
      }
    } catch {
      // unknown/legacy tag → fall through to the host liveness path.
    }
  }
  const live0 = await isSandboxRuntimeAlive(mounts)
  if (live0 === "dead") return true // confirmed gone → safe to commit
  if (live0 === "unknown") {
    // R3.4: we could NOT confirm the runtime is dead (transport error / non-Linux
    // unverifiable pid). Fail-closed against a torn snapshot: skip the commit this
    // round rather than snapshot a dir that may still be under active write.
    console.warn(
      `[sandbox] recovery: runtime for session ${sessionId} liveness is UNKNOWN; ` +
        `skipping commit this round (fail-closed against a torn snapshot)`
    )
    return false
  }
  // 'alive' — try to stop it. Prefer the in-process handle; else rebuild a ref and
  // kill via the owning adapter (docker rm / identity-gated pid signal).
  console.warn(
    `[sandbox] recovery: runtime for session ${sessionId} is still alive; attempting to stop before commit`
  )
  const liveHandle = liveSandboxHandles.get(sessionId)
  if (liveHandle) {
    await liveHandle.kill().catch(() => {})
    liveSandboxHandles.delete(sessionId)
  } else {
    const ref = await buildSandboxRefFromSandboxRow(mounts)
    if (ref) {
      try {
        const handle = await adapterForKind(ref).connect(ref)
        await handle.kill()
      } catch (err) {
        console.error(
          `[sandbox] recovery: could not kill runtime for ${sessionId}:`,
          err
        )
        // R3.6: a raw persisted-pid signal is a PID-reuse hazard — signal ONLY on a
        // positive durable-identity match (never on 'mismatch'/'unknown').
        if (
          ref.hostPid !== undefined &&
          verifyPidIdentity(ref.hostPid, ref.hostPidIdentity ?? null) ===
            "match"
        ) {
          killPid(ref.hostPid)
        }
      }
    }
  }
  // Re-check: only a CONFIRMED 'dead' allows the commit; 'alive'/'unknown' skip.
  return (await isSandboxRuntimeAlive(mounts)) === "dead"
}

/** Recover a single failed mount (caller has already confirmed the runtime is
 *  stopped). Returns the outcome for the recovered/stillFailed tally. */
async function recoverOneFailedMount(
  mount: FileMountRow
): Promise<"recovered" | "stillFailed" | "skipped"> {
  if (!mount.materializedDir) return "skipped"
  // The dir may have been cleaned already (e.g. by a later successful run);
  // skip if it's gone — there's nothing to recover.
  if (!existsSync(mount.materializedDir)) {
    await updateFileMount(repo.defaultDbh(), mount.id, {
      status: "closed",
      closedAt: true,
      errorMessage: "recovered: live dir already gone, nothing to commit",
    }).catch(() => {})
    return "skipped"
  }
  try {
    const result = await commitOneMount(
      mount.workspaceId,
      mount.sessionId,
      mount,
      defaultCommitDeps()
    )
    // Commit succeeded (or there was nothing new) → close + remove the dir.
    await updateFileMount(repo.defaultDbh(), mount.id, {
      status: "closed",
      closedAt: true,
      resultSnapshotId: result.snapshotId ?? mount.resultSnapshotId,
      errorMessage: result.conflicts.length
        ? `recovered with conflicts: ${result.conflicts.join(", ")}`
        : null,
    })
    await rm(mount.materializedDir, { recursive: true, force: true }).catch(
      () => {}
    )
    return "recovered"
  } catch (err) {
    console.error(
      `[sandbox] recovery commit still failing for mount ${mount.id}:`,
      err
    )
    return "stillFailed"
  }
}
