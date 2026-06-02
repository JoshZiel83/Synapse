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
import { join } from "node:path"
import { actorRef, conversationRef } from "@synapse/shared"
import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { STORAGE_DIR } from "../../infrastructure/storage/index.js"
import { config } from "../../config/index.js"
import { startPairing, deleteDevice } from "../devices/service.js"
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
  resolveDeviceBuiltinIds,
  createSandboxGrants,
  revokeSandboxGrants,
} from "./grants.js"
import {
  isSandboxCommandlineAvailable,
  type SandboxProvisionResult,
  type SidecarRestoreFailure,
  type SidecarRestoreFailureReason,
} from "./model.js"

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
// The backend + sandbox_resource_id (+ host_pid for local) are ALSO persisted
// on file_mounts so a different process / post-restart teardown can rebuild a
// SandboxRef and kill it without the in-process handle.
const liveSandboxHandles = new Map<string, SandboxHandle>()

/**
 * Select the sandbox backend. `local` (default) spawns a same-host
 * device-runtime child; `docker` (Phase 3) runs the cloud-sandbox image via
 * DooD. A caller may inject its own backend/hostProvider for tests.
 */
function selectSandboxBackend(
  options: ProvisionSandboxOptions
): SandboxBackend {
  if (options.sandboxBackend) return options.sandboxBackend
  const kind = (process.env.SYNAPSE_SANDBOX_BACKEND || "local").toLowerCase()
  if (kind === "docker") {
    // Phase 3 wires createDockerSandboxBackend here. Until then, fail loudly
    // rather than silently falling back to local (which would mask a
    // misconfigured deployment).
    throw new SandboxServiceError(
      "SYNAPSE_SANDBOX_BACKEND=docker is not yet available in this build",
      500
    )
  }
  const hostProvider = options.hostProvider ?? createLocalHostProvider()
  return createLocalSandboxBackend({
    hostProvider,
    beginLocalPairing: async (spec) => {
      const pairing = await startPairing({
        workspaceId: spec.workspaceId,
        mode: "local_qr",
        serverBaseUrl: spec.serverOrigin,
        title: spec.title ?? `Sandbox ${spec.sessionId.slice(0, 8)}`,
      })
      if (!pairing.pairing_code) {
        throw new SandboxServiceError(
          "startPairing returned no pairing_code",
          500
        )
      }
      return {
        pairingCode: pairing.pairing_code,
        brokerDir: brokerDirFor(spec.sessionId),
        pairingSessionId: pairing.pairing_session_id,
      }
    },
  })
}

interface SessionContext {
  workspaceId: string
  conversationId: string
  actorId: string
}

/**
 * A backend usable for `connect()` only (teardown / cross-process kill), built
 * from the persisted SandboxRef kind. `create()` is never called on these, so
 * the local backend's pairing dep is a throwing stub.
 */
function backendForKind(kind: SandboxBackendKind): SandboxBackend {
  if (kind === "docker") {
    throw new SandboxServiceError(
      "docker sandbox backend is not yet available in this build",
      500
    )
  }
  return createLocalSandboxBackend({
    hostProvider: createLocalHostProvider(),
    beginLocalPairing: async () => {
      throw new SandboxServiceError(
        "beginLocalPairing is not available on a connect-only backend",
        500
      )
    },
  })
}

/**
 * Rebuild a SandboxRef from the persisted file_mounts columns so teardown can
 * reconnect+kill a runtime started by another process / before a restart.
 * Returns null when there's no device to kill.
 */
function buildSandboxRefFromMounts(
  sessionId: string,
  mounts: FileMountRow[]
): SandboxRef | null {
  const deviceId = mounts.find((m) => m.device_id)?.device_id ?? null
  if (!deviceId) return null
  const backend = (mounts.find((m) => m.sandbox_backend)?.sandbox_backend ??
    "local") as SandboxBackendKind
  const sandboxResourceId =
    mounts.find((m) => m.sandbox_resource_id)?.sandbox_resource_id ?? ""
  const pairingSessionId =
    mounts.find((m) => m.pairing_session_id)?.pairing_session_id ?? undefined
  const hostPid = mounts.find((m) => m.host_pid)?.host_pid ?? undefined
  return {
    backend,
    sandboxId: sessionId,
    sandboxResourceId,
    deviceId,
    pairingSessionId,
    hostPid: hostPid ?? undefined,
  }
}

async function loadSessionContext(
  sessionId: string
): Promise<SessionContext | null> {
  const row = await db
    .selectFrom("sessions")
    .select(["workspace_id", "conversation_id", "actor_id"])
    .where("id", "=", sessionId)
    .executeTakeFirst()
  if (!row) return null
  return {
    workspaceId: row.workspace_id as string,
    conversationId: row.conversation_id as string,
    actorId: row.actor_id as string,
  }
}

/** Per-session sandbox root: <STORAGE_DIR>/sandboxes/<sessionId>. */
function sandboxRootFor(sessionId: string): string {
  return join(STORAGE_DIR, "sandboxes", sessionId)
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
            await ensureFileSpace(db, {
              workspaceId: ctx.workspaceId,
              owner: conversationRef(ctx.conversationId),
            })
          ).id,
      },
      {
        subpath: "actor",
        ensure: async () =>
          (
            await ensureFileSpace(db, {
              workspaceId: ctx.workspaceId,
              owner: actorRef(ctx.actorId),
            })
          ).id,
      },
      {
        subpath: "actor-conversation",
        ensure: async () =>
          (
            await ensureFileSpace(db, {
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
    const space = await getFileSpace(db, spaceId)
    const baseSnapshotId = space?.current_snapshot_id ?? null
    const baseManifestSha = baseSnapshotId
      ? await getSnapshotManifestSha(db, baseSnapshotId)
      : null
    out.push({ subpath: s.subpath, spaceId, baseSnapshotId, baseManifestSha })
  }
  return out
}

export interface ProvisionSandboxOptions {
  /** Inject a HostProvider (local backend wraps it). Test seam. */
  hostProvider?: HostProvider
  /** Inject a fully-built backend (overrides hostProvider + env selection). */
  sandboxBackend?: SandboxBackend
  /** Max ms to wait for the device catalog to sync. */
  catalogTimeoutMs?: number
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
  const existing = await getActiveMountsForSession(db, sessionId)
  if (existing.length > 0) {
    // Already provisioned this session — report the ACTUAL state, not a
    // hardcoded false: commandline is enabled iff the paired device exposes a
    // commandline builtin (it only does so when bwrap confinement was available
    // at spawn — see the fail-closed gate in bin.ts).
    const deviceId = existing.find((m) => m.device_id)?.device_id ?? ""
    let commandlineEnabled = false
    if (deviceId) {
      const cmd = await db
        .selectFrom("device_exposures")
        .select("id")
        .where("device_id", "=", deviceId)
        .where("builtin_kind", "=", "commandline")
        .limit(1)
        .executeTakeFirst()
      commandlineEnabled = Boolean(cmd)
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
      deviceId,
      commandlineEnabled,
      mountIds: existing.map((m) => m.id),
      sidecarRestoreOk,
      failedSidecars,
    }
  }

  const ctx = await loadSessionContext(sessionId)
  if (!ctx) throw new SandboxServiceError(`session ${sessionId} not found`, 404)

  const backend = selectSandboxBackend(options)
  const fsHelperPath = resolveFsHelperPath()
  const sandboxRoot = sandboxRootFor(sessionId)
  const commandlineEnabled = isSandboxCommandlineAvailable()

  // ② ensure spaces + ③ resolve base snapshots.
  const specs = await ensureSessionSpaces(ctx)

  // ④ insert mounts ('provisioning') + ⑤ materialize each base into a plain dir.
  await mkdir(brokerDirFor(sessionId), { recursive: true })
  const mounts: FileMountRow[] = []
  for (const spec of specs) {
    const dir = mountDir(sessionId, spec.subpath)
    await mkdir(dir, { recursive: true })
    const mount = await insertFileMount(db, {
      workspaceId: ctx.workspaceId,
      sessionId,
      fileSpaceId: spec.spaceId,
      mountSubpath: spec.subpath,
      baseSnapshotId: spec.baseSnapshotId,
      materializedDir: dir,
      sandboxBackend: backend.kind,
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
        mounts.map((mount) => updateFileMount(db, mount.id, patch))
      )
    }
    const spec: SandboxSpec = {
      sessionId,
      workspaceId: ctx.workspaceId,
      sandboxRoot,
      fsHelperPath,
      // The device dials back to the API. config.app.baseUrl for local;
      // SYNAPSE_SANDBOX_SERVER_ORIGIN (internal address) is applied by the
      // docker backend in Phase 4.
      serverOrigin: config.app.baseUrl,
      // ALWAYS run this per-session device in sandbox mode (--cmd-sandbox), even
      // when bwrap is unavailable. The device-runtime's --cmd-sandbox branch
      // fail-closes: bwrap present → confined commandline; bwrap absent → NO
      // commandline tool at all. `commandlineEnabled` only decides whether WE
      // pre-authorize the commandline grant, not whether the device runs unconfined.
      confineCommands: true,
      title: `Sandbox ${sessionId.slice(0, 8)}`,
      onPairingCreated: (pairingSessionId) => persistAll({ pairingSessionId }),
      onResourceCreated: (sandboxResourceId) =>
        persistAll({ sandboxResourceId }),
      onDeviceClaimed: (deviceId) => persistAll({ deviceId }),
    }
    handle = await backend.create(spec)
    liveSandboxHandles.set(handle.sandboxId, handle)

    // Record device + resource handle on all mounts (teardown/recovery need it;
    // the staged callbacks above already wrote device_id, this also pins
    // host_pid for the local backend's pid-based kill fallback).
    await persistAll({
      deviceId: handle.deviceId,
      hostPid: handle.hostPid ?? null,
      sandboxResourceId: handle.sandboxResourceId || null,
    })

    // ⑦ wait for device.catalog.sync to land (filesystem exposure visible).
    await waitForCatalog(handle.deviceId, {
      timeoutMs: options.catalogTimeoutMs ?? 30_000,
    })

    // ⑧ build both authorization layers (once, full capability list).
    const builtins = await resolveDeviceBuiltinIds(handle.deviceId)
    await createSandboxGrants({
      workspaceId: ctx.workspaceId,
      deviceId: handle.deviceId,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
      builtins,
      includeCommandline: commandlineEnabled,
      createdByWorkspaceMemberId: options.createdByWorkspaceMemberId ?? null,
    })

    // ⑨ mark mounts active.
    await persistAll({ status: "active" })

    return {
      sessionId,
      sandboxRoot,
      deviceId: handle.deviceId,
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
    //  - revoke any partial grants + delete the paired device (cascades),
    //  - remove the on-disk scratch dirs (CAS untouched).
    const pairedDeviceId = handle?.deviceId ?? null
    if (handle) {
      await handle.kill().catch(() => {})
      liveSandboxHandles.delete(handle.sandboxId)
    }
    if (pairedDeviceId) {
      await revokeSandboxGrants({
        workspaceId: ctx.workspaceId,
        deviceId: pairedDeviceId,
        actorId: ctx.actorId,
        conversationId: ctx.conversationId,
      }).catch(() => {})
      await deleteDevice(ctx.workspaceId, pairedDeviceId).catch(() => {})
    }
    await rm(sandboxRoot, { recursive: true, force: true }).catch(() => {})
    for (const mount of mounts) {
      await updateFileMount(db, mount.id, {
        status: "failed",
        errorMessage: message,
      }).catch(() => {})
    }
    throw err instanceof SandboxServiceError
      ? err
      : new SandboxServiceError(`provisionSandbox failed: ${message}`, 500)
  }
}

/** Poll device_exposures until the filesystem builtin is healthy, or time out. */
async function waitForCatalog(
  deviceId: string,
  opts: { timeoutMs: number; pollMs?: number }
): Promise<void> {
  const pollMs = opts.pollMs ?? 250
  const deadline = Date.now() + opts.timeoutMs
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ready = await db
      .selectFrom("device_exposures")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("builtin_kind", "=", "filesystem")
      .where("runtime_status", "=", "healthy")
      .limit(1)
      .executeTakeFirst()
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
 * Test seam for refreshSpaces (mirrors CommitDeps). Defaults bind to production
 * globals; a test injects a pinned executor + matching runInTx + a stub sync.
 */
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
    dbh: db,
    runInTx: (fn) => withDbTransaction(fn),
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
    if (mount.mount_subpath === "actor-conversation") continue
    if (!mount.materialized_dir) continue

    try {
      const space = await getFileSpace(deps.dbh, mount.file_space_id)
      const head = space?.current_snapshot_id ?? null
      if (!head || head === mount.base_snapshot_id) continue // nothing new

      const headManifest = await getSnapshotManifestSha(deps.dbh, head)
      if (!headManifest) continue
      const baseManifest = mount.base_snapshot_id
        ? await getSnapshotManifestSha(deps.dbh, mount.base_snapshot_id)
        : null

      // R12-1: DEFER the head-overwrite of conflicting live paths. The sync
      // writes the recoverable sidecars + applies non-conflicting incoming
      // changes, but leaves each conflicting live path holding the agent's copy.
      // We then durably persist the pending record, apply head, and only then
      // advance base — so a failure before the live path is overwritten leaves
      // working != head and the next turn re-derives the conflict (no silent
      // loss of the notice).
      const sync = await deps.sync({
        dir: mount.materialized_dir,
        baseManifestSha256: baseManifest ?? undefined,
        toManifestSha256: headManifest,
        deferConflictApply: true,
      })
      if (sync.deferred_conflicts.length > 0) {
        deferredConflictsBySubpath[mount.mount_subpath] =
          sync.deferred_conflicts
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
          original: `/${mount.mount_subpath}${c.original}`,
          sidecar: `/${mount.mount_subpath}${c.sidecar}`,
          kind: c.kind,
          contentSha: c.content_sha ?? undefined,
          target: c.target ?? undefined,
        })
      )
      if (mountSidecars.length > 0) {
        sidecarsBySubpath[mount.mount_subpath] = mountSidecars
      }
      if (sync.incomplete) {
        // The helper STOPPED EARLY on a per-path failure: the live dir is only
        // partially synced (no valid new base), so do NOT advance base — leaving
        // head!=base re-runs the sync next turn and self-heals (round-8
        // fail-closed). But the sidecars written before the stop ARE surfaced
        // above, so the agent still learns where its preserved copies are
        // (round-9 #2: don't orphan an already-written sidecar).
        syncFailuresBySubpath[mount.mount_subpath] = sync.incomplete
        console.error(
          `[sandbox] refresh sync incomplete for mount ${mount.id} (${mount.mount_subpath}); base left unadvanced for next-turn retry: ${sync.incomplete}`
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
                ? { [mount.mount_subpath]: sync.deferred_conflicts }
                : {},
            sidecarsBySubpath:
              mountSidecars.length > 0
                ? { [mount.mount_subpath]: mountSidecars }
                : {},
          })
        )
        // (2) NOW overwrite the conflicting live paths with head.
        if (sync.deferred_conflicts.length > 0) {
          await deps.applyHead({
            dir: mount.materialized_dir,
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
      syncFailuresBySubpath[mount.mount_subpath] = msg
      console.error(
        `[sandbox] refresh sync failed for mount ${mount.id} (${mount.mount_subpath}); base left unadvanced for next-turn retry:`,
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

/** A conflicting file whose pre-conflict local copy was preserved at a sidecar. */
export interface ConflictSidecarRef {
  original: string
  sidecar: string
  /** "file" = readable bytes; "symlink" = readable JSON metadata (round-10 #3). */
  kind: string
  /**
   * CAS-durable recovery payload (round-11 #1) so the sidecar survives teardown
   * (which deletes the live dir; .synapse-conflicts is scan-excluded so never in
   * CAS via the snapshot path). For a FILE sidecar this is the content sha256
   * (the bytes are already in CAS from the scan). For a SYMLINK sidecar the
   * `target` string is the payload (no CAS bytes). On the next provision the
   * sidecar is re-materialized into the fresh live dir from these.
   */
  contentSha?: string
  /** Symlink target (round-11 #1), present only for kind="symlink". */
  target?: string
}

/**
 * The mount-relative directory every conflict sidecar lives under. Must match
 * CONFLICTS_DIRNAME in sidecars/fs-helper/src/manifest.rs.
 */
const CONFLICTS_DIRNAME = ".synapse-conflicts"

/**
 * The ONLY shape a legitimate sidecar VFS path can take:
 *   /<mount-subpath>/.synapse-conflicts/<flat-leaf>
 * where <mount-subpath> and <flat-leaf> are each a single path segment with no
 * slashes and are not "." or "..". The leaf is a flat hashed name produced by
 * `sidecar_path_for` in the fs-helper (`/.synapse-conflicts/<hex>`), so there is
 * never a nested path or a "normal" tree path here.
 *
 * This is deliberately STRICT (P1): a loose `/<subpath>/<rest>` match would let a
 * corrupt record like `/actor/x.txt` route to a live regular-file path, and
 * restore would then silently OVERWRITE the current head content with the agent's
 * preserved bytes. Restricting to the .synapse-conflicts namespace with a single
 * safe leaf means a restore can only ever (re)create the helper-owned scratch
 * sidecar, never clobber a real tree file. Capture groups: [1]=mount subpath,
 * [2]=flat leaf.
 */
export const SIDECAR_ROUTE_RE = /^\/([^/]+)\/\.synapse-conflicts\/([^/]+)$/

/** Whether a single path segment is safe (non-empty, not "." or ".."). */
function isSafeSegment(seg: string): boolean {
  return seg.length > 0 && seg !== "." && seg !== ".."
}

/**
 * Parse a sidecar VFS path into its mount subpath + mount-relative leaf, or null
 * if it is not a well-formed `/<mount>/.synapse-conflicts/<flat-leaf>` path with
 * safe segments. The leaf returned is the mount-relative path the fs-helper
 * restores against (e.g. `/.synapse-conflicts/<hex>`).
 */
export function parseSidecarRoute(
  sidecar: string
): { subpath: string; leaf: string } | null {
  const m = SIDECAR_ROUTE_RE.exec(sidecar)
  if (!m) return null
  const [, subpath, leafName] = m
  if (!isSafeSegment(subpath) || !isSafeSegment(leafName)) return null
  return { subpath, leaf: `/${CONFLICTS_DIRNAME}/${leafName}` }
}

/**
 * Whether a sidecar ref is INTRINSICALLY unrecoverable from its own shape — i.e.
 * the durable record can never be rebuilt, regardless of mount state or transient
 * fs conditions. Mount-independent reasons:
 *   - a "file" sidecar with no contentSha (pre-round-11 / corrupt: the CAS
 *     pointer is gone),
 *   - a "symlink" sidecar with no target,
 *   - any OTHER kind (a corrupt record: only "file"/"symlink" are restorable;
 *     fs-helper's restore rejects an unknown kind with InvalidParams), or
 *   - a sidecar PATH that is not a well-formed
 *     `/<mount>/.synapse-conflicts/<flat-leaf>` (per `parseSidecarRoute`): it
 *     either can't route to a mount OR (the dangerous case, P1) points OUTSIDE
 *     the .synapse-conflicts scratch namespace at a real tree file, which restore
 *     must never touch — so it's permanently lost, never retried.
 * Such a ref is PERMANENT in BOTH the normal restore loop and the fail-closed
 * "unknown" partition path, so the agent is never told a corrupt copy "will be
 * retried". Shared by restorePendingSidecarsImpl and partitionSidecars so the two
 * never disagree.
 */
export function isSidecarPayloadIrrecoverable(
  ref: ConflictSidecarRef
): boolean {
  // Path must be a safe, in-namespace sidecar leaf — else permanently lost (and
  // never written to a real tree path).
  if (parseSidecarRoute(ref.sidecar) === null) return true
  if (ref.kind === "file") return !ref.contentSha
  if (ref.kind === "symlink") return ref.target === undefined
  // Unknown/corrupt kind — unrestorable by fs-helper, so permanently lost.
  return true
}

/** Per-subpath pending commit conflicts: the lost paths + their sidecars. */
export interface PendingCommitConflict {
  paths: string[]
  sidecars: ConflictSidecarRef[]
}

/**
 * Durable refresh-conflict state for at-least-once delivery (round-10 #1).
 * refreshSpaces head-wins-resolves conflicts (live path → head, agent's copy →
 * sidecar) and advances base at TURN START — but if the turn is interrupted
 * after that and before the actor consumes the notice, next turn head==base so
 * refresh won't re-report it, and the sidecar becomes an unknown recovery file.
 * So refresh conflicts are persisted on the session (like commit conflicts) and
 * cleared only after actorThink returns.
 */
export interface PendingRefreshConflicts {
  /** subpath → deferred conflict paths (head won the live path). */
  deferredConflictsBySubpath: Record<string, string[]>
  /** subpath → sidecars preserving the agent's pre-conflict copies. */
  sidecarsBySubpath: Record<string, ConflictSidecarRef[]>
  /** subpath → reason the refresh could not fully sync (stale/half-synced view). */
  syncFailuresBySubpath: Record<string, string>
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
    dbh: db,
    runInTx: (fn) => withDbTransaction(fn),
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
          dir: mount.materialized_dir!,
          baseManifestSha256: baseManifestSha ?? undefined,
          toManifestSha256: committedManifestSha,
          deferConflictApply: true,
        })
        const sidecars = res.conflict_sidecars.map((c) => ({
          original: `/${mount.mount_subpath}${c.original}`,
          sidecar: `/${mount.mount_subpath}${c.sidecar}`,
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
        dir: mount.materialized_dir!,
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
    if (!subpaths.includes(mount.mount_subpath)) continue
    if (!mount.materialized_dir) continue

    const result = await commitOneMount(ctx.workspaceId, sessionId, mount, deps)
    if (result.snapshotId) {
      out.snapshotIdBySubpath[mount.mount_subpath] = result.snapshotId
    }
    if (result.conflicts.length > 0) {
      out.conflictsBySubpath[mount.mount_subpath] = result.conflicts
    }
    if (result.sidecars.length > 0) {
      out.sidecarsBySubpath[mount.mount_subpath] = result.sidecars
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

const PENDING_CONFLICTS_KEY = "_sandboxPendingCommitConflicts"

/**
 * Pure union of an existing pending-conflict map with newly-recorded conflicts:
 * per subpath, dedup paths (Set) and dedup sidecars by SIDECAR path (not by
 * original): a second unconsumed conflict on the same original now lands on a
 * DISTINCT sidecar leaf (round-10 #2 content discriminator), and BOTH preserved
 * copies must persist until consumed — so we key on the unique sidecar path, not
 * the original (which would drop the earlier copy). Extracted for unit coverage;
 * the DB read + FOR UPDATE wrapper lives in recordPendingCommitConflicts.
 */
export function mergePendingConflicts(
  prev: Record<string, PendingCommitConflict>,
  incomingBySubpath: Record<string, PendingCommitConflict>
): Record<string, PendingCommitConflict> {
  const merged: Record<string, PendingCommitConflict> = { ...prev }
  for (const [sub, incoming] of Object.entries(incomingBySubpath)) {
    const existingEntry = merged[sub] ?? { paths: [], sidecars: [] }
    const paths = Array.from(
      new Set([...existingEntry.paths, ...incoming.paths])
    )
    const bySidecar = new Map<string, ConflictSidecarRef>()
    for (const s of [...existingEntry.sidecars, ...incoming.sidecars]) {
      bySidecar.set(s.sidecar, s)
    }
    merged[sub] = { paths, sidecars: Array.from(bySidecar.values()) }
  }
  return merged
}

/**
 * Stash turn-end commit conflicts on the session for the next turn to surface.
 * MERGES with any already-pending conflicts (union by subpath: deduped paths +
 * deduped sidecars) rather than replacing — otherwise a still-undelivered notice
 * from a turn whose actorThink threw (so it wasn't cleared) would be clobbered by
 * a new conflict. Each subpath carries both the lost paths and the sidecars where
 * the agent's pre-conflict copy was preserved (round-7 #C).
 */
async function recordPendingCommitConflicts(
  sessionId: string,
  conflictsBySubpath: Record<string, PendingCommitConflict>,
  runInTx: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T> = (fn) =>
    withDbTransaction(fn)
): Promise<void> {
  await runInTx(async (txq) => {
    const existing = await sql<{ collaboration_state: unknown }>`
      SELECT collaboration_state FROM sessions WHERE id = ${sessionId} FOR UPDATE`.execute(
      txq
    )
    const state = (existing.rows[0]?.collaboration_state ?? {}) as Record<
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
  })
}

/**
 * Coerce the stored pending-conflicts blob into the current shape. Tolerates the
 * pre-round-7 format (subpath → string[]) so a notice stashed by an older build
 * still surfaces after upgrade. Exported for unit coverage.
 */
export function normalizePendingConflicts(
  raw: unknown
): Record<string, PendingCommitConflict> {
  if (!raw || typeof raw !== "object") return {}
  const out: Record<string, PendingCommitConflict> = {}
  for (const [sub, val] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      // Legacy: a bare path array, no sidecar info.
      out[sub] = { paths: val as string[], sidecars: [] }
    } else if (val && typeof val === "object") {
      const v = val as { paths?: unknown; sidecars?: unknown }
      out[sub] = {
        paths: Array.isArray(v.paths) ? (v.paths as string[]) : [],
        sidecars: Array.isArray(v.sidecars)
          ? (v.sidecars as unknown[]).map(normalizeSidecarRef)
          : [],
      }
    }
  }
  return out
}

/** Coerce a stored sidecar ref, defaulting a missing `kind` to "file" (a
 * pre-round-10 sidecar was always a readable file). */
function normalizeSidecarRef(raw: unknown): ConflictSidecarRef {
  const v = (raw ?? {}) as {
    original?: unknown
    sidecar?: unknown
    kind?: unknown
    contentSha?: unknown
    target?: unknown
  }
  return {
    original: typeof v.original === "string" ? v.original : "",
    sidecar: typeof v.sidecar === "string" ? v.sidecar : "",
    kind: typeof v.kind === "string" ? v.kind : "file",
    ...(typeof v.contentSha === "string" ? { contentSha: v.contentSha } : {}),
    ...(typeof v.target === "string" ? { target: v.target } : {}),
  }
}

/**
 * Read (WITHOUT clearing) any commit conflicts stashed by a previous turn's
 * teardown/commit. At-least-once delivery: the caller surfaces these to the
 * agent, then calls clearPendingCommitConflicts ONLY after the model has
 * actually consumed them (post-actorThink), so a crash in between re-delivers
 * rather than drops the notice.
 */
export async function peekPendingCommitConflicts(
  sessionId: string
): Promise<Record<string, PendingCommitConflict>> {
  const row = await db
    .selectFrom("sessions")
    .select("collaboration_state")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  const state = (row?.collaboration_state ?? {}) as Record<string, unknown>
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
      collaboration_state: sql`COALESCE(collaboration_state, '{}'::jsonb) - ${PENDING_CONFLICTS_KEY}::text`,
    } as never)
    .where("id", "=", sessionId)
    .execute()
}

const PENDING_REFRESH_KEY = "_sandboxPendingRefreshConflicts"

/**
 * Pure union of an existing pending-refresh map with newly-recorded refresh
 * conflicts: per subpath, dedup deferred paths (Set) and dedup sidecars by
 * SIDECAR path (round-10 #2 — two unconsumed conflicts on the same original have
 * distinct leaves and both must persist). syncFailures are NOT carried in the
 * durable store (they self-heal next turn). Exported for unit coverage.
 */
export function mergePendingRefreshConflicts(
  prev: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
): Pick<
  PendingRefreshConflicts,
  "deferredConflictsBySubpath" | "sidecarsBySubpath"
> {
  const deferredConflictsBySubpath: Record<string, string[]> = {
    ...prev.deferredConflictsBySubpath,
  }
  for (const [sub, paths] of Object.entries(
    incoming.deferredConflictsBySubpath
  )) {
    deferredConflictsBySubpath[sub] = Array.from(
      new Set([...(deferredConflictsBySubpath[sub] ?? []), ...paths])
    )
  }
  const sidecarsBySubpath: Record<string, ConflictSidecarRef[]> = {
    ...prev.sidecarsBySubpath,
  }
  for (const [sub, refs] of Object.entries(incoming.sidecarsBySubpath)) {
    const bySidecar = new Map<string, ConflictSidecarRef>()
    for (const s of [...(sidecarsBySubpath[sub] ?? []), ...refs]) {
      bySidecar.set(s.sidecar, s)
    }
    sidecarsBySubpath[sub] = Array.from(bySidecar.values())
  }
  return { deferredConflictsBySubpath, sidecarsBySubpath }
}

/** Coerce the stored pending-refresh blob into the current shape. */
export function normalizePendingRefresh(
  raw: unknown
): Pick<
  PendingRefreshConflicts,
  "deferredConflictsBySubpath" | "sidecarsBySubpath"
> {
  const v = (raw ?? {}) as {
    deferredConflictsBySubpath?: unknown
    sidecarsBySubpath?: unknown
  }
  const deferredConflictsBySubpath: Record<string, string[]> = {}
  if (
    v.deferredConflictsBySubpath &&
    typeof v.deferredConflictsBySubpath === "object"
  ) {
    for (const [sub, paths] of Object.entries(
      v.deferredConflictsBySubpath as Record<string, unknown>
    )) {
      if (Array.isArray(paths))
        deferredConflictsBySubpath[sub] = paths as string[]
    }
  }
  const sidecarsBySubpath: Record<string, ConflictSidecarRef[]> = {}
  if (v.sidecarsBySubpath && typeof v.sidecarsBySubpath === "object") {
    for (const [sub, refs] of Object.entries(
      v.sidecarsBySubpath as Record<string, unknown>
    )) {
      if (Array.isArray(refs))
        sidecarsBySubpath[sub] = (refs as unknown[]).map(normalizeSidecarRef)
    }
  }
  return { deferredConflictsBySubpath, sidecarsBySubpath }
}

/**
 * Persist refresh conflicts (deferred paths + sidecars) for at-least-once
 * delivery (round-10 #1), MERGING with any still-undelivered ones. syncFailures
 * are deliberately excluded — they self-heal (next turn head!=base re-runs the
 * sync) so persisting them would re-warn forever.
 */
async function recordPendingRefreshConflicts(
  sessionId: string,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >,
  runInTx: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T> = (fn) =>
    withDbTransaction(fn)
): Promise<void> {
  await runInTx((txq) =>
    recordPendingRefreshConflictsOn(txq, sessionId, incoming)
  )
}

/**
 * Executor-bound core of recordPendingRefreshConflicts: read-merge-write the
 * pending refresh blob on the given (already-open) transaction. Used by
 * refreshSpaces to couple the persist with the per-mount base advance in ONE
 * transaction (round-11 #2: a persist failure must roll back the base advance,
 * so head!=base self-heals instead of silently degrading durability).
 */
async function recordPendingRefreshConflictsOn(
  txq: Executor,
  sessionId: string,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
): Promise<void> {
  const existing = await sql<{ collaboration_state: unknown }>`
    SELECT collaboration_state FROM sessions WHERE id = ${sessionId} FOR UPDATE`.execute(
    txq
  )
  const state = (existing.rows[0]?.collaboration_state ?? {}) as Record<
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
 * Read (WITHOUT clearing) refresh conflicts stashed by a previous turn whose
 * notice the actor may not have consumed (at-least-once delivery, round-10 #1).
 * Returns the persisted deferred paths + sidecars (NOT syncFailures — those are
 * recomputed fresh each turn). The caller clears only after actorThink returns.
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
    .select("collaboration_state")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  const state = (row?.collaboration_state ?? {}) as Record<string, unknown>
  return normalizePendingRefresh(state[PENDING_REFRESH_KEY])
}

/** Clear the stashed refresh conflicts (after the agent has consumed them). */
export async function clearPendingRefreshConflicts(
  sessionId: string
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      collaboration_state: sql`COALESCE(collaboration_state, '{}'::jsonb) - ${PENDING_REFRESH_KEY}::text`,
    } as never)
    .where("id", "=", sessionId)
    .execute()
}

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
  mounts: Pick<FileMountRow, "mount_subpath" | "materialized_dir">[],
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
    if (m.materialized_dir)
      dirBySubpath.set(m.mount_subpath, m.materialized_dir)
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
  const space = await getFileSpace(deps.dbh, mount.file_space_id)
  const latestSnapshotId = space?.current_snapshot_id ?? null
  const baseManifest = mount.base_snapshot_id
    ? await getSnapshotManifestSha(deps.dbh, mount.base_snapshot_id)
    : null
  const latestManifest = latestSnapshotId
    ? await getSnapshotManifestSha(deps.dbh, latestSnapshotId)
    : null

  // Scan + CAS-ingest the live dir (slow; no DB lock held).
  const scan = await scanCommitDir({
    dir: mount.materialized_dir!,
    baseManifestSha256: baseManifest ?? undefined,
    latestManifestSha256: latestManifest ?? undefined,
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
        { [mount.mount_subpath]: { paths: scan.conflict_paths, sidecars } },
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
    if (latestSnapshotId && mount.base_snapshot_id !== latestSnapshotId) {
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
      await ensureContentBlob(txq, {
        sha256: scan.manifest_sha256,
        sizeBytes: 0, // manifest size is not tracked; 0 is a valid placeholder
      })
      for (const blobSha of scan.new_blobs) {
        await ensureContentBlob(txq, { sha256: blobSha, sizeBytes: 0 })
      }
      return appendSnapshot(txq, {
        workspaceId,
        fileSpaceId: mount.file_space_id,
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
        { [mount.mount_subpath]: { paths: scan.conflict_paths, sidecars } },
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
  const mounts = await getActiveMountsForSession(db, sessionId)
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

  const deviceId = mounts.find((m) => m.device_id)?.device_id ?? null

  // ② stop the runtime the backend started. Prefer the in-process handle
  // (keyed by sessionId); else rebuild a SandboxRef from the persisted mount
  // columns and reconnect via the SAME backend that created it (recorded in
  // sandbox_backend), so a docker sandbox is `docker rm`'d and a local one is
  // SIGTERM'd — never guessed from the current env. Always — a failed commit
  // doesn't justify leaving the runtime alive.
  const liveHandle = liveSandboxHandles.get(sessionId)
  if (liveHandle) {
    await liveHandle.kill().catch(() => {})
    liveSandboxHandles.delete(sessionId)
  } else {
    const ref = buildSandboxRefFromMounts(sessionId, mounts)
    if (ref) {
      try {
        const backend = backendForKind(ref.backend)
        const handle = await backend.connect(ref)
        await handle.kill()
      } catch (err) {
        console.error(
          `[sandbox] teardown could not kill runtime for ${sessionId} via ${ref.backend} backend:`,
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
      await updateFileMount(db, mount.id, {
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
      await updateFileMount(db, mount.id, {
        status: "failed",
        errorMessage: `teardown commit failed (live dir preserved at ${mount.materialized_dir}): ${message}`,
      }).catch(() => {})
    }
    console.error(
      `[sandbox] teardown for ${sessionId}: commit failed — preserved live dirs under ${sandboxRootFor(sessionId)} for recovery`
    )
  }

  // ⑤ revoke grants + ⑥ delete device (cascades device_* children). The device
  // is paired per-session and can't be reused, so it's removed even on a failed
  // commit; the preserved live dirs do not depend on it.
  if (ctx && deviceId) {
    await revokeSandboxGrants({
      workspaceId: ctx.workspaceId,
      deviceId,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
    }).catch((err) =>
      console.error(`[sandbox] revoke grants failed for ${sessionId}:`, err)
    )
    await deleteDevice(ctx.workspaceId, deviceId).catch((err) =>
      console.error(`[sandbox] deleteDevice failed for ${sessionId}:`, err)
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
 * This is the code-level recovery entry for the "preserve on commit failure"
 * teardown path — without it a failed mount's data would only be recoverable by
 * hand. Best-effort and idempotent: safe to call on every API startup.
 */
export async function recoverFailedSandboxMounts(): Promise<RecoverFailedMountsResult> {
  const mounts = await getFailedRecoverableMounts(db)
  let recovered = 0
  let stillFailed = 0
  for (const mount of mounts) {
    if (!mount.materialized_dir) continue
    // The dir may have been cleaned already (e.g. by a later successful run);
    // skip if it's gone — there's nothing to recover.
    if (!existsSync(mount.materialized_dir)) {
      await updateFileMount(db, mount.id, {
        status: "closed",
        closedAt: true,
        errorMessage: "recovered: live dir already gone, nothing to commit",
      }).catch(() => {})
      continue
    }
    try {
      const result = await commitOneMount(
        mount.workspace_id,
        mount.session_id,
        mount,
        defaultCommitDeps()
      )
      // Commit succeeded (or there was nothing new) → close + remove the dir.
      await updateFileMount(db, mount.id, {
        status: "closed",
        closedAt: true,
        resultSnapshotId: result.snapshotId ?? mount.result_snapshot_id,
        errorMessage: result.conflicts.length
          ? `recovered with conflicts: ${result.conflicts.join(", ")}`
          : null,
      })
      await rm(mount.materialized_dir, { recursive: true, force: true }).catch(
        () => {}
      )
      recovered++
    } catch (err) {
      stillFailed++
      console.error(
        `[sandbox] recovery commit still failing for mount ${mount.id}:`,
        err
      )
    }
  }
  return { attempted: mounts.length, recovered, stillFailed }
}
