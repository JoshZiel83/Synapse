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
import { deleteDevice } from "../devices/service.js"
import { getDeviceTunnelRegistry } from "../devices/tunnel-registry.js"
import {
  ensureFileSpace,
  insertFileMount,
  updateFileMount,
  getActiveMountsForSession,
  getFailedRecoverableMounts,
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
import { createLocalHostProvider, type HostProvider } from "./host-provider.js"
import {
  createLocalSandboxBackend,
  type SandboxBackend,
  type SandboxBackendKind,
  type SandboxHandle,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"
import {
  reapDockerSandboxOrphans,
  type SpawnImpl,
} from "./docker-sandbox-backend.js"
import {
  resolveSandboxAdapter,
  adapterForRow,
  dockerBackendOptionsFromEnv,
  type SandboxAdapter,
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
  normalizePendingConflicts,
  normalizePendingRefresh,
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
 * Resolve the sandbox ADAPTER for the provision path (§4.1). Forks on BOTH
 * provider AND mode via the registry (the P2 selectSandboxBackend forked only on
 * provider, so SANDBOX_MODE=bare was inert). A test may inject a fully-built
 * adapter (sandboxAdapter) or a legacy resident backend (sandboxBackend, wrapped
 * as a control_plane resident adapter). The catalogSource on the returned adapter
 * is what the provision spine forks on (waitForCatalog/waitForTunnelEndpoint vs
 * the api-authored skip).
 */
function resolveAdapterForProvision(
  options: ProvisionSandboxOptions
): SandboxAdapter {
  if (options.sandboxAdapter) return options.sandboxAdapter
  if (options.sandboxBackend) {
    return wrapResidentBackendAsAdapter(options.sandboxBackend)
  }
  const adapter = resolveSandboxAdapter(
    config.sandbox.provider,
    config.sandbox.mode,
    { hostProvider: options.hostProvider }
  )
  if (!adapter) {
    throw new SandboxServiceError(
      `no sandbox adapter registered for provider='${config.sandbox.provider}' mode='${config.sandbox.mode}'`,
      500
    )
  }
  return adapter
}

/** Wrap an injected resident SandboxBackend (test seam) as a control_plane
 *  adapter so the provision spine keeps waitForCatalog/waitForTunnelEndpoint. */
function wrapResidentBackendAsAdapter(backend: SandboxBackend): SandboxAdapter {
  return {
    key: `${backend.kind}:resident`,
    provider: backend.kind,
    mode: "resident",
    kind: backend.kind,
    catalogSource: "control_plane",
    transportDefault: "direct",
    capabilities: null,
    create: (spec) => backend.create(spec),
    connect: (ref) => backend.connect(ref),
  }
}

// dockerBackendOptionsFromEnv now lives in adapter-registry.ts (so the registry
// can build the LAZY provision backend without a value cycle). Re-exported here
// for compatibility with existing importers.
export { dockerBackendOptionsFromEnv }

type SessionContext = repo.SessionContext

/**
 * Origin the LOCAL sandbox device-runtime dials back to (passed as `--server=`
 * and to startPairing). Honors SYNAPSE_SANDBOX_SERVER_ORIGIN — a containerized
 * local deploy sets it to http://127.0.0.1:3001 (loopback) so the same-host
 * child doesn't have to round-trip the public domain (DNS/hairpin-NAT). Falls
 * back to config.app.baseUrl (the prior unconditional value) when unset.
 *
 * NOTE: this is the LOCAL backend's source. The docker backend does NOT read
 * spec.serverOrigin — it builds its own from the same env in
 * dockerBackendOptionsFromEnv (opts.serverOrigin) — so this never affects it.
 */
export function sandboxLocalServerOrigin(): string {
  return config.sandbox.serverOrigin
}

/**
 * The spec.storageVolumeSubpath value for a given backend. It is a DOCKER-ONLY
 * field (the docker backend mounts the session's subpath of the shared storage
 * volume into the container; the local backend ignores it). Computing it for
 * the local backend was a latent bug: toSandboxVolumeSubpath REQUIRES STORAGE_DIR
 * to live under the volume mount point (default /app/storage) and throws
 * otherwise — which on a bare-metal API (default STORAGE_DIR=/tmp/synapse-storage)
 * aborts provision before the backend even starts. So compute it only for docker;
 * local gets undefined.
 *
 * Pure (takes storageDir/mountPoint explicitly rather than reading the module
 * STORAGE_DIR const) so it is deterministically unit-testable.
 */
export function sandboxSpecVolumeSubpath(
  kind: SandboxBackendKind,
  input: { storageDir: string; mountPoint: string; sessionId: string }
): string | undefined {
  return kind === "docker" ? toSandboxVolumeSubpath(input) : undefined
}

/**
 * A backend usable for `connect()` only (teardown / cross-process kill), built
 * from the persisted SandboxRef kind. `create()` is never called on these.
 *
 * Crucially this must NOT depend on the current provision env: a docker sandbox
 * has to stay reapable even after the API fell back to the local backend, had
 * sandboxes disabled, or lost its FRP_SHARED_TOKEN — so we use the connect-only
 * docker backend (docker CLI + persisted container id, no image/network/volume/
 * frp config), never createDockerSandboxBackend(dockerBackendOptionsFromEnv()).
 */
function backendForKind(
  ref: SandboxRef,
  dockerSpawnImpl?: SpawnImpl
): SandboxAdapter {
  // Row-driven (adapter + mode), NEVER current config (inv-45). For docker this
  // resolves the ENV-FREE reconnect backend (F-A); create() is never called on a
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
 * NEVER uses the state-filtered getLiveSandboxBySession (that is reuse-only).
 * runtimeServiceId is intentionally omitted — the kill/liveness path (docker rm
 * by resource id / pid signal) never needs it.
 */
async function buildSandboxRefFromSandboxRow(
  mounts: FileMountRow[],
  run: Executor = repo.defaultDbh()
): Promise<SandboxRef | null> {
  const sessionId = mounts[0]?.sessionId ?? ""
  const mountSandboxId = mounts.find((m) => m.sandboxId)?.sandboxId ?? null
  let row: repo.SandboxRow | null = null
  if (mountSandboxId) {
    row = await repo.getSandboxById(mountSandboxId, run)
  }
  if (!row && sessionId) {
    row = await repo.getSandboxBySessionForControl(sessionId, run)
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
    }
  }
  // No owning sandbox row resolvable (crash before the sandbox was minted, or a
  // mount with no runtime yet) → nothing killable. The pre-P2 device-shaped
  // file_mounts fallback is gone (P3): the sandboxes row is the sole identity.
  return null
}

/**
 * Source the runtime id from a session's mounts: the P2/P3 back-filled sandbox_id
 * (== runtimeId). The pre-P2 device_id fallback is gone (P3) — every live mount has
 * a sandbox_id.
 */
function runtimeIdFromMounts(mounts: FileMountRow[]): string {
  return mounts.find((m) => m.sandboxId)?.sandboxId ?? ""
}

/**
 * Whether the runtime behind a session's mounts is actually alive. Prefers the
 * in-process handle (cheap); otherwise rebuilds a SandboxRef via the STATE-AGNOSTIC
 * control-path resolver and probes via the owning adapter (docker inspect / pid
 * signal). On any error, treat as NOT alive so the caller recovers rather than
 * handing back a dead sandbox.
 */
export async function isSandboxRuntimeAlive(
  mounts: FileMountRow[],
  opts: { run?: Executor; dockerSpawnImpl?: SpawnImpl } = {}
): Promise<boolean> {
  const sessionId = mounts[0]?.sessionId
  if (sessionId) {
    const live = liveSandboxHandles.get(sessionId)
    if (live) {
      try {
        return await live.isRunning()
      } catch {
        return false
      }
    }
  }
  const ref = await buildSandboxRefFromSandboxRow(
    mounts,
    opts.run ?? repo.defaultDbh()
  )
  if (!ref) return false
  try {
    const handle = await backendForKind(ref, opts.dockerSpawnImpl).connect(ref)
    return await handle.isRunning()
  } catch {
    return false
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
 *   active/committing set/null        normal teardown (commit→kill runtime)
 *   failed/closing    set/null        state-agnostic resolve still kills it
 *
 * Label-only orphans — a container the API `docker run` started but crashed
 * BEFORE the sandboxes row was minted (docker pre-bootstrap), so no row can build a
 * killable ref — are reaped separately via {@link reapDockerSandboxOrphans}, which
 * scans `docker ps` by the session LABEL and removes any whose session isn't in the
 * live set. Only runs when the docker backend has history. Bounded; best-effort; logs.
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
      // A sandboxes-only candidate (no live mounts) is NOT shielded here — for
      // Mode-A this cannot happen (an active sandbox always co-holds its 3 live
      // mounts). Liveness moves off mounts only in S11.
      if (mounts.length === 0) continue
      const allActive = mounts.every((m) => m.status === "active")
      if (
        allActive &&
        (await isSandboxRuntimeAlive(mounts, {
          run,
          dockerSpawnImpl: deps.dockerSpawnImpl,
        }))
      ) {
        // Healthy + alive — keep it (and shield its container from the orphan
        // reaper below).
        liveSessionIds.add(sessionId)
        continue
      }
      console.warn(
        `[sandbox] reconcile: tearing down stale session ${sessionId} (allActive=${allActive})`
      )
      await teardownSandbox(sessionId)
    } catch (err) {
      console.error(`[sandbox] reconcile failed for ${sessionId}:`, err)
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
        console.warn(
          `[sandbox] reconcile: reaped ${removed.length} label-only docker orphan(s): ${removed.join(", ")}`
        )
      }
    } catch (err) {
      console.error("[sandbox] reconcile: docker orphan reap failed:", err)
    }
  }
}

const loadSessionContext = repo.loadSessionContext

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
        `SYNAPSE_SANDBOX_STORAGE_VOLUME_MOUNT so volume-subpath can be derived. ` +
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
  /** Inject a HostProvider (local backend wraps it). Test seam. */
  hostProvider?: HostProvider
  /** Inject a fully-built resident backend (overrides hostProvider + env). */
  sandboxBackend?: SandboxBackend
  /** Inject a fully-built ADAPTER (overrides everything — bare/Mode-B test seam). */
  sandboxAdapter?: SandboxAdapter
  /** Max ms to wait for the device catalog to sync. */
  catalogTimeoutMs?: number
  /**
   * Max ms to wait for the device's tunnel endpoint to register in the
   * DeviceTunnelRegistry (after catalog). A sandbox whose endpoint never
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
  // set (status NOT IN closed/failed) which also includes 'provisioning' and
  // 'committing'; short-circuiting on those would hand back a half-built or
  // tearing-down sandbox. A dead runtime behind active mounts means the daemon
  // crashed — we recover by tearing the stale device down and re-provisioning
  // (the materialized live dirs are preserved across teardown's commit path).
  const allActive =
    existing.length > 0 && existing.every((m) => m.status === "active")
  // Fast path also requires a DISPATCHABLE tunnel endpoint, not just a live
  // runtime. After an API restart the in-memory DeviceTunnelRegistry is empty
  // even though the runtime/container is still alive and reconnecting over the
  // control-plane; returning here would hand back a sandbox whose every
  // dispatchSyncTool call fails with no_tunnel_endpoint. So when the runtime is
  // alive we additionally wait (briefly) for the device_runtime service to
  // re-register its endpoint. If it never does, we DON'T fast-path — we fall
  // through to the stale-mount teardown + re-provision below.
  let fastPathOk = false
  if (
    existing.length > 0 &&
    allActive &&
    (await isSandboxRuntimeAlive(existing))
  ) {
    const runtimeIdForEndpoint = runtimeIdFromMounts(existing)
    fastPathOk = await fastPathEndpointReady({
      sessionId,
      deviceId: runtimeIdForEndpoint,
      tunnelTimeoutMs: options.tunnelTimeoutMs ?? 30_000,
    })
  }
  if (fastPathOk) {
    // Already provisioned this session — report the ACTUAL state, not a
    // hardcoded false. Use the SAME source of truth as the cold provision path
    // (resolveDeviceBuiltinIds → commandlineCapabilityId != null): an ACTIVE
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
        // resolveDeviceBuiltinIds throws only when the filesystem capability is
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
      deviceId: runtimeId,
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
  // state, kills the (possibly dead) runtime via the persisted backend, and
  // closes the mounts — so the fresh provision below starts from a clean slate.
  // Live dirs are preserved by teardown's commit path; their content is
  // re-materialized from CAS on re-provision.
  if (existing.length > 0) {
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
    // ⑥ stand up the runtime via the selected backend. Staged-persistence
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
    const spec: SandboxSpec = {
      sessionId,
      workspaceId: ctx.workspaceId,
      sandboxRoot,
      // Docker-ONLY: where this session's root lives RELATIVE to the storage
      // volume mount (computed from STORAGE_DIR, never hardcoded). Undefined for
      // the local backend — computing it there throws when STORAGE_DIR isn't
      // under the volume mount point (bare-metal default /tmp/synapse-storage).
      storageVolumeSubpath: sandboxSpecVolumeSubpath(adapter.kind, {
        storageDir: STORAGE_DIR,
        mountPoint: storageVolumeMountPoint(),
        sessionId,
      }),
      fsHelperPath,
      // The device dials back to the API. LOCAL backend: SYNAPSE_SANDBOX_SERVER_ORIGIN
      // (loopback for a containerized local deploy) or config.app.baseUrl. The
      // docker backend ignores this and builds its own origin from env.
      serverOrigin: sandboxLocalServerOrigin(),
      // ALWAYS run this per-session device in sandbox mode (--cmd-sandbox), even
      // when bwrap is unavailable. The device-runtime's --cmd-sandbox branch
      // fail-closes: bwrap present → confined commandline; bwrap absent → NO
      // commandline tool at all. `commandlineEnabled` only decides whether WE
      // pre-authorize the commandline grant, not whether the device runs unconfined.
      confineCommands: true,
      title: `Sandbox ${sessionId.slice(0, 8)}`,
      // P3: the mount no longer carries pairing_session_id / sandbox_resource_id /
      // host_pid. Pairing + resource id live on the sandboxes row (docker consume
      // sets pairing_session_id; resource_id is written post-create via
      // updateSandboxRow below), and a pre-bootstrap docker container is reaped by
      // its session LABEL (reapDockerSandboxOrphans), not by a mount column — so
      // onPairingCreated / onResourceCreated have nothing to persist and are dropped.
      // onRuntimeReady still back-fills the mount's sole identity column, sandbox_id.
      onRuntimeReady: (runtimeId) => persistAll({ sandboxId: runtimeId }),
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
    await repo.updateSandboxRow(runtimeId, {
      resourceId: handle.resourceId || null,
      hostPid: handle.hostPid ?? null,
    })

    // ⑦/⑦b — catalog + tunnel readiness. Forked on adapter.catalogSource:
    //   control_plane (resident) → wait for device.catalog.sync + the tunnel
    //     endpoint to register (UNCHANGED Mode-A path).
    //   api_authored (bare) → the API already authored + persisted the catalog
    //     synchronously in create() (mintBareSandboxRuntimeTx) and there is NO
    //     tunnel/endpoint to register (the data plane is dialed directly), so
    //     BOTH waits are skipped. resolveRuntimeBuiltinIds below reads the same
    //     already-committed catalog either way.
    if (adapter.catalogSource === "control_plane") {
      await waitForCatalog(runtimeId, {
        timeoutMs: options.catalogTimeoutMs ?? 30_000,
      })
      const tunnelTimeoutMs = options.tunnelTimeoutMs ?? 30_000
      if (tunnelTimeoutMs > 0) {
        await waitForTunnelEndpoint(handle.runtimeLink.runtimeServiceId, {
          timeoutMs: tunnelTimeoutMs,
        })
      }
    }

    // ⑧ build both authorization layers (once, full capability list).
    // The device fail-closes at boot: it advertises a commandline builtin in its
    // catalog ONLY when ITS OWN host can confine commands (bwrap+userns). So the
    // resolved catalog — not a probe of the API process's PATH — is the single
    // source of truth for whether to pre-authorize the commandline grant. This
    // is correct for BOTH backends: the local device runs on the API host, while
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
    await repo.updateSandboxRow(runtimeId, { state: "active" })

    return {
      sessionId,
      sandboxRoot,
      deviceId: runtimeId,
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
    //  - kill the runtime the backend started + drop its in-process handle,
    //  - revoke any partial grants + soft-delete the sandbox runtime,
    //  - mark the sandboxes row 'failed',
    //  - remove the on-disk scratch dirs (CAS untouched).
    const pairedRuntimeId = handle?.runtimeLink.runtimeId ?? null
    if (handle) {
      await handle.kill().catch(() => {})
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
          state: "failed",
          errorMessage: message,
        })
        .catch(() => {})
      await deleteDevice(ctx.workspaceId, pairedRuntimeId).catch(() => {})
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
  deviceId: string,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<void> {
  const pollMs = opts.pollMs ?? 250
  const deadline = Date.now() + opts.timeoutMs

  while (true) {
    const ready = await repo.isFilesystemExposureHealthy(deviceId)
    if (ready) return
    if (Date.now() >= deadline) {
      throw new SandboxServiceError(
        `device ${deviceId} catalog did not sync within ${opts.timeoutMs}ms`,
        504
      )
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/**
 * Poll the in-process DeviceTunnelRegistry until this service's tunnel endpoint
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
  const registry = getDeviceTunnelRegistry()

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
  deviceId: string
): Promise<string | null> {
  return repo.resolveDeviceRuntimeServiceId(deviceId)
}

/** Injectable seams for {@link fastPathEndpointReady} (tests stub these so the
 *  empty-registry → timeout → reprovision branch is exercised without a DB). */
export interface FastPathEndpointDeps {
  resolveServiceId: (deviceId: string) => Promise<string | null>
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
 * API restart the in-memory DeviceTunnelRegistry is empty even though the
 * runtime/container is still alive, so we wait (briefly) for re-registration.
 * Returns false (→ caller tears down + re-provisions) when there is no
 * device_runtime service or the endpoint never (re)registers within the timeout.
 * tunnelTimeoutMs<=0 skips the wait entirely (tests that don't dispatch).
 *
 * Exported with injectable deps so the empty-registry timeout path is unit
 * testable without standing up a full sandbox.
 */
export async function fastPathEndpointReady(
  args: { sessionId: string; deviceId: string; tunnelTimeoutMs: number },
  deps: FastPathEndpointDeps = defaultFastPathEndpointDeps()
): Promise<boolean> {
  const serviceId = args.deviceId
    ? await deps.resolveServiceId(args.deviceId)
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
export async function refreshSpaces(
  sessionId: string,
  depsOverride?: Partial<RefreshDeps>
): Promise<PendingRefreshConflicts> {
  const deps: RefreshDeps = { ...defaultRefreshDeps(), ...depsOverride }
  const mounts = await getActiveMountsForSession(deps.dbh, sessionId)
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
  hostProvider?: HostProvider
}

/**
 * Teardown: commit all dirty spaces, stop the daemon, then — only if the commit
 * succeeded — delete the live dirs and close the mounts. If the commit FAILS,
 * the live dirs are PRESERVED and the mounts are marked 'failed' (not deleted),
 * so uncommitted sandbox data is never thrown away; an operator / reconciler can
 * retry the commit from the preserved materialized_dir. The daemon is stopped
 * and the device deleted regardless (the process/device can't linger).
 */
export async function teardownSandbox(
  sessionId: string,
  _options: TeardownSandboxOptions = {}
): Promise<void> {
  const ctx = await loadSessionContext(sessionId)
  const mounts = await getActiveMountsForSession(repo.defaultDbh(), sessionId)
  if (mounts.length === 0) return

  // ① commit ALL dirty spaces (incl /actor-conversation, and any /conversation
  // ·/actor that an exception skipped at turn-end). Track success: a failure
  // here MUST NOT lead to deleting the live dirs (that would lose data).
  let commitOk = true
  let commitError: unknown = null
  try {
    await commitSpaces(sessionId, [
      "conversation",
      "actor",
      "actor-conversation",
    ])
  } catch (err) {
    commitOk = false
    commitError = err
    console.error(`[sandbox] teardown commit failed for ${sessionId}:`, err)
  }

  const runtimeId = runtimeIdFromMounts(mounts) || null

  // ② stop the runtime the backend started. Prefer the in-process handle
  // (keyed by sessionId); else rebuild a SandboxRef via the STATE-AGNOSTIC
  // control-path resolver and reconnect via the SAME adapter that created it
  // (recorded on sandboxes.adapter), so a docker sandbox is `docker rm`'d and a
  // local one is SIGTERM'd — never guessed from the current config. Always — a
  // failed commit doesn't justify leaving the runtime alive.
  const liveHandle = liveSandboxHandles.get(sessionId)
  if (liveHandle) {
    await liveHandle.kill().catch(() => {})
    liveSandboxHandles.delete(sessionId)
  } else {
    const ref = await buildSandboxRefFromSandboxRow(mounts)
    if (ref) {
      try {
        const backend = backendForKind(ref)
        const handle = await backend.connect(ref)
        await handle.kill()
      } catch (err) {
        console.error(
          `[sandbox] teardown could not kill runtime for ${sessionId} via ${ref.adapter} adapter:`,
          err
        )
        // Last-resort local fallback: signal the persisted pid directly.
        if (ref.hostPid) killPid(ref.hostPid)
      }
    }
  }

  if (commitOk) {
    // ③ delete the live dirs (CAS is the source of truth; dirs are scratch).
    await rm(sandboxRootFor(sessionId), {
      recursive: true,
      force: true,
    }).catch(() => {})
    await cleanupDirs([sandboxRootFor(sessionId)]).catch(() => {})

    // ④ close mounts.
    for (const mount of mounts) {
      await updateFileMount(repo.defaultDbh(), mount.id, {
        status: "closed",
        closedAt: true,
      }).catch(() => {})
    }
  } else {
    // Commit failed → PRESERVE the live dirs. Mark mounts 'failed' (keeping
    // materialized_dir + host) so the data can be recovered/retried, and record
    // the error. Do NOT rm the sandbox root.
    const message =
      commitError instanceof Error ? commitError.message : String(commitError)
    for (const mount of mounts) {
      await updateFileMount(repo.defaultDbh(), mount.id, {
        status: "failed",
        errorMessage: `teardown commit failed (live dir preserved at ${mount.materializedDir}): ${message}`,
      }).catch(() => {})
    }
    console.error(
      `[sandbox] teardown for ${sessionId}: commit failed — preserved live dirs under ${sandboxRootFor(sessionId)} for recovery`
    )
  }

  // ⑤ revoke grants + close the sandbox row + ⑥ soft-delete the runtime (keeps
  // children for audit). The runtime is per-session and can't be reused, so it's
  // removed even on a failed commit; the preserved live dirs do not depend on it.
  if (ctx && runtimeId) {
    await revokeSandboxGrants({
      workspaceId: ctx.workspaceId,
      runtimeId,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
    }).catch((err) =>
      console.error(`[sandbox] revoke grants failed for ${sessionId}:`, err)
    )
    await repo
      .updateSandboxRow(runtimeId, { state: commitOk ? "closed" : "failed" })
      .catch(() => {})
    await deleteDevice(ctx.workspaceId, runtimeId).catch((err) =>
      console.error(
        `[sandbox] soft-delete runtime failed for ${sessionId}:`,
        err
      )
    )
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
  const mounts = await getFailedRecoverableMounts(repo.defaultDbh())
  // Group by session so we make the live-runtime decision ONCE per runtime (the
  // runtime is per-session, not per-mount) before touching any of its dirs.
  const bySession = new Map<string, FileMountRow[]>()
  for (const mount of mounts) {
    const sid = mount.sessionId as string
    const list = bySession.get(sid)
    if (list) list.push(mount)
    else bySession.set(sid, [mount])
  }

  let recovered = 0
  let stillFailed = 0
  for (const [sessionId, sessionMounts] of bySession) {
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
  return { attempted: mounts.length, recovered, stillFailed }
}

/**
 * Confirm the per-session sandbox runtime is NOT alive before recovery commits
 * snapshot its live dirs. Returns true when it's already gone or we successfully
 * killed it; false when it's still alive after a kill attempt (caller must skip).
 */
async function ensureRuntimeStoppedForRecovery(
  sessionId: string,
  mounts: FileMountRow[]
): Promise<boolean> {
  if (!(await isSandboxRuntimeAlive(mounts))) return true
  // Still alive — try to stop it. Prefer the in-process handle; else rebuild a
  // ref and kill via the owning backend (docker rm / pid signal).
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
        const handle = await backendForKind(ref).connect(ref)
        await handle.kill()
      } catch (err) {
        console.error(
          `[sandbox] recovery: could not kill runtime for ${sessionId}:`,
          err
        )
        if (ref.hostPid) killPid(ref.hostPid)
      }
    }
  }
  // Re-check: killing is async (docker rm / SIGTERM grace), so a still-true here
  // means we shouldn't risk a commit this round.
  return !(await isSandboxRuntimeAlive(mounts))
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
