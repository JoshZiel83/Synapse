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
import { db } from "../../infrastructure/database/kysely.js"
import type { QueryExecutor } from "../../infrastructure/database/kysely.js"
import { transaction, pool } from "../../infrastructure/database/index.js"
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
  resolveFsHelperPath,
  cleanupDirs,
  restoreSidecar,
} from "./materialize.js"
import type { DirSyncResult } from "@synapse/device-runtime"
import {
  createLocalHostProvider,
  type HostProvider,
  type RunHandle,
} from "./host-provider.js"
import {
  resolveDeviceBuiltinIds,
  createSandboxGrants,
  revokeSandboxGrants,
} from "./grants.js"
import {
  isSandboxCommandlineAvailable,
  type SandboxProvisionResult,
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

// In-process registry of live run handles, keyed by deviceId, so teardown can
// SIGTERM the daemon it spawned. (host_pid is also persisted on file_mounts for
// cross-process / crash recovery.)
const liveRunHandles = new Map<string, RunHandle>()

interface SessionContext {
  workspaceId: string
  conversationId: string
  actorId: string
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
            await ensureFileSpace(pool, {
              workspaceId: ctx.workspaceId,
              owner: conversationRef(ctx.conversationId),
            })
          ).id,
      },
      {
        subpath: "actor",
        ensure: async () =>
          (
            await ensureFileSpace(pool, {
              workspaceId: ctx.workspaceId,
              owner: actorRef(ctx.actorId),
            })
          ).id,
      },
      {
        subpath: "actor-conversation",
        ensure: async () =>
          (
            await ensureFileSpace(pool, {
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
    const space = await getFileSpace(pool, spaceId)
    const baseSnapshotId = space?.current_snapshot_id ?? null
    const baseManifestSha = baseSnapshotId
      ? await getSnapshotManifestSha(pool, baseSnapshotId)
      : null
    out.push({ subpath: s.subpath, spaceId, baseSnapshotId, baseManifestSha })
  }
  return out
}

export interface ProvisionSandboxOptions {
  hostProvider?: HostProvider
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
  const existing = await getActiveMountsForSession(pool, sessionId)
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
    return {
      sessionId,
      sandboxRoot: sandboxRootFor(sessionId),
      deviceId,
      commandlineEnabled,
      mountIds: existing.map((m) => m.id),
    }
  }

  const ctx = await loadSessionContext(sessionId)
  if (!ctx) throw new SandboxServiceError(`session ${sessionId} not found`, 404)

  const hostProvider = options.hostProvider ?? createLocalHostProvider()
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
    const mount = await insertFileMount(pool, {
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
  await restorePendingSidecars(sessionId, mounts).catch((err) =>
    console.error(
      `[sandbox] failed to restore pending sidecars for ${sessionId}:`,
      err
    )
  )

  // Hoisted so the catch can tear down whatever was created.
  let pairedDeviceId: string | null = null
  let runHandle: RunHandle | null = null
  try {
    // ⑥ local pairing: startPairing(local_qr) → pair → run.
    const pairing = await startPairing({
      workspaceId: ctx.workspaceId,
      mode: "local_qr",
      serverBaseUrl: config.app.baseUrl,
      title: `Sandbox ${sessionId.slice(0, 8)}`,
    })
    if (!pairing.pairing_code) {
      throw new SandboxServiceError(
        "startPairing returned no pairing_code",
        500
      )
    }
    const spawnParams = {
      pairingCode: pairing.pairing_code,
      brokerDir: brokerDirFor(sessionId),
      fsRoot: sandboxRoot,
      fsHelperPath,
      serverOrigin: config.app.baseUrl,
      // ALWAYS run this per-session device in sandbox mode (--cmd-sandbox), even
      // when bwrap is unavailable. This is a sandbox device: it must never
      // expose an UNCONFINED commandline. The device-runtime's --cmd-sandbox
      // branch fail-closes — bwrap present → confined commandline; bwrap absent
      // → NO commandline tool at all (so nothing could later grant a host
      // shell). `commandlineEnabled` only decides whether WE pre-authorize the
      // commandline grant, not whether the device runs unconfined.
      confineCommands: true,
      title: `Sandbox ${sessionId.slice(0, 8)}`,
    }
    const paired = await hostProvider.pair(spawnParams)
    pairedDeviceId = paired.deviceId
    runHandle = await hostProvider.run(spawnParams)
    liveRunHandles.set(paired.deviceId, runHandle)

    // Record device + pid on all mounts immediately (teardown/recovery need it).
    for (const mount of mounts) {
      await updateFileMount(pool, mount.id, {
        deviceId: paired.deviceId,
        hostPid: runHandle.pid,
      })
    }

    // ⑦ wait for device.catalog.sync to land (filesystem exposure visible).
    await waitForCatalog(paired.deviceId, {
      timeoutMs: options.catalogTimeoutMs ?? 30_000,
    })

    // ⑧ build both authorization layers (once, full capability list).
    const builtins = await resolveDeviceBuiltinIds(paired.deviceId)
    await createSandboxGrants({
      workspaceId: ctx.workspaceId,
      deviceId: paired.deviceId,
      actorId: ctx.actorId,
      conversationId: ctx.conversationId,
      builtins,
      includeCommandline: commandlineEnabled,
      createdByWorkspaceMemberId: options.createdByWorkspaceMemberId ?? null,
    })

    // ⑨ mark mounts active + pin pairing session.
    for (const mount of mounts) {
      await updateFileMount(pool, mount.id, { status: "active" })
    }

    return {
      sessionId,
      sandboxRoot,
      deviceId: paired.deviceId,
      commandlineEnabled,
      mountIds: mounts.map((m) => m.id),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Best-effort cleanup of everything provisioned before the failure — the
    // mounts get marked 'failed' (so getActiveMountsForSession excludes them
    // and teardown can't recover), which means cleanup MUST happen here:
    //  - stop the spawned daemon + drop its in-process handle,
    //  - revoke any partial grants + delete the paired device (cascades),
    //  - remove the on-disk scratch dirs (CAS untouched).
    if (runHandle) {
      await runHandle.stop().catch(() => {})
    }
    if (pairedDeviceId) {
      liveRunHandles.delete(pairedDeviceId)
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
      await updateFileMount(pool, mount.id, {
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
  dbh: QueryExecutor
  runInTx: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>
  sync: (input: {
    dir: string
    baseManifestSha256?: string
    toManifestSha256: string
  }) => Promise<DirSyncResult>
}

function defaultRefreshDeps(): RefreshDeps {
  return {
    dbh: pool,
    runInTx: (fn) => transaction(fn as never) as never,
    sync: syncDir,
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

      const sync = await deps.sync({
        dir: mount.materialized_dir,
        baseManifestSha256: baseManifest ?? undefined,
        toManifestSha256: headManifest,
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
      // Advance base to the synced-in head ONLY after a successful sync.
      // dir_sync resolves conflicts HEAD-WINS in the live tree (head applied to
      // the live path; the agent's pre-conflict local copy preserved at the
      // conflict sidecar), so after sync working == head for every incoming
      // path. Advancing base to head therefore (a) lets the agent's reconciled
      // re-edit commit cleanly (no spurious re-conflict against the same head —
      // the round-4 dead-end), and (b) never silently overwrites the concurrent
      // change, because on conflict the live path already holds head, not the
      // agent's stale local copy.
      //
      // ATOMICITY (round-11 #2): if this mount produced a conflict/sidecar, the
      // base advance and the durable pending-conflict record MUST be one
      // indivisible transaction. Otherwise a persist failure after base already
      // advanced would mean head==base next turn (no re-report) while the
      // sidecar is orphaned — silently degrading the round-10 durable delivery.
      // Coupling them means a persist failure rolls back the base advance, so
      // head!=base and the next turn re-runs the sync + re-records.
      if (sync.deferred_conflicts.length > 0 || mountSidecars.length > 0) {
        await deps.runInTx(async (txq) => {
          await recordPendingRefreshConflictsOn(txq, sessionId, {
            deferredConflictsBySubpath:
              sync.deferred_conflicts.length > 0
                ? { [mount.mount_subpath]: sync.deferred_conflicts }
                : {},
            sidecarsBySubpath:
              mountSidecars.length > 0
                ? { [mount.mount_subpath]: mountSidecars }
                : {},
          })
          await updateFileMount(txq, mount.id, { baseSnapshotId: head })
        })
      } else {
        // No conflict on this mount → nothing to persist; just advance base.
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
  /** Executor for non-transactional reads/updates (default: global pool). */
  dbh: QueryExecutor
  /** Run `fn` in a DB transaction (default: the global `transaction` helper). */
  runInTx: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>
  /**
   * Resolve the session's workspace/conversation/actor (default: global kysely
   * db). Injected so a test on a single pinned/rolled-back connection can see
   * its own uncommitted session row.
   */
  loadCtx: (sessionId: string) => Promise<SessionContext | null>
  /**
   * Reconcile the live dir to a committed manifest (head-wins + sidecar losers).
   * Returns `{ ok, sidecars }`: `ok` = the live dir is fully == committed (safe
   * to advance base); `sidecars` = every preserved copy written, surfaced to the
   * agent EVEN WHEN ok=false (round-9 #2: a sidecar written before a mid-way
   * failure must not be orphaned). When ok=false the caller MUST NOT advance base
   * (round-7 #A self-heal). Default drives the real fs-helper via syncDir.
   */
  reconcile: (
    mount: FileMountRow,
    baseManifestSha: string | null,
    committedManifestSha: string,
    hadConflicts: boolean
  ) => Promise<{
    ok: boolean
    sidecars: ConflictSidecarRef[]
  }>
}

function defaultCommitDeps(): CommitDeps {
  return {
    dbh: pool,
    runInTx: (fn) => transaction(fn as never) as never,
    loadCtx: loadSessionContext,
    reconcile: async (
      mount,
      baseManifestSha,
      committedManifestSha,
      hadConflicts
    ) => {
      if (!hadConflicts) return { ok: true, sidecars: [] }
      try {
        const res = await syncDir({
          dir: mount.materialized_dir!,
          baseManifestSha256: baseManifestSha ?? undefined,
          toManifestSha256: committedManifestSha,
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
          // NOT-ok so the caller leaves base unadvanced (round-9 #2 + round-7 #A).
          console.error(
            `[sandbox] post-commit reconcile incomplete for mount ${mount.id}: ${res.incomplete}`
          )
          return { ok: false, sidecars }
        }
        return { ok: true, sidecars }
      } catch (err) {
        console.error(
          `[sandbox] post-commit reconcile failed for mount ${mount.id}:`,
          err
        )
        return { ok: false, sidecars: [] }
      }
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
  // Persist commit conflicts durably: turn-end commit runs AFTER the actor has
  // already replied, so the conflict can't be fixed this turn. Stash it on the
  // session so the NEXT turn surfaces it as a notice (the agent's local change
  // to those paths lost to the concurrent head — it must redo/reconcile, and its
  // pre-conflict copy is preserved at the recorded sidecar).
  if (Object.keys(out.conflictsBySubpath).length > 0) {
    const pending: Record<string, PendingCommitConflict> = {}
    for (const [sub, paths] of Object.entries(out.conflictsBySubpath)) {
      pending[sub] = { paths, sidecars: out.sidecarsBySubpath[sub] ?? [] }
    }
    await recordPendingCommitConflicts(sessionId, pending, deps.runInTx).catch(
      (err) =>
        console.error(
          `[sandbox] failed to persist commit conflicts for ${sessionId}:`,
          err
        )
    )
  }
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
  runInTx: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T> = (fn) =>
    transaction(fn as never) as never
): Promise<void> {
  await runInTx(async (txq) => {
    const existing = await txq.query(
      `SELECT collaboration_state FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    )
    const state = (existing.rows[0]?.collaboration_state ?? {}) as Record<
      string,
      unknown
    >
    const prev = normalizePendingConflicts(state[PENDING_CONFLICTS_KEY])
    const merged = mergePendingConflicts(prev, conflictsBySubpath)
    await txq.query(
      `UPDATE sessions
       SET collaboration_state =
         COALESCE(collaboration_state, '{}'::jsonb)
         || jsonb_build_object($2::text, $3::jsonb)
       WHERE id = $1`,
      [sessionId, PENDING_CONFLICTS_KEY, JSON.stringify(merged)]
    )
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
  runInTx: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T> = (fn) =>
    transaction(fn as never) as never
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
  txq: QueryExecutor,
  sessionId: string,
  incoming: Pick<
    PendingRefreshConflicts,
    "deferredConflictsBySubpath" | "sidecarsBySubpath"
  >
): Promise<void> {
  const existing = await txq.query(
    `SELECT collaboration_state FROM sessions WHERE id = $1 FOR UPDATE`,
    [sessionId]
  )
  const state = (existing.rows[0]?.collaboration_state ?? {}) as Record<
    string,
    unknown
  >
  const prev = normalizePendingRefresh(state[PENDING_REFRESH_KEY])
  const merged = mergePendingRefreshConflicts(prev, incoming)
  await txq.query(
    `UPDATE sessions
       SET collaboration_state =
         COALESCE(collaboration_state, '{}'::jsonb)
         || jsonb_build_object($2::text, $3::jsonb)
       WHERE id = $1`,
    [sessionId, PENDING_REFRESH_KEY, JSON.stringify(merged)]
  )
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
): Promise<void> {
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
): Promise<void> {
  const dirBySubpath = new Map<string, string>()
  for (const m of mounts) {
    if (m.materialized_dir)
      dirBySubpath.set(m.mount_subpath, m.materialized_dir)
  }
  if (dirBySubpath.size === 0) return

  const commit = await deps.peekCommit(sessionId)
  const refresh = await deps.peekRefresh(sessionId)
  const allRefs: ConflictSidecarRef[] = [
    ...Object.values(commit).flatMap((c) => c.sidecars),
    ...Object.values(refresh.sidecarsBySubpath).flat(),
  ]
  if (allRefs.length === 0) return

  // Dedup by sidecar leaf (the same preserved copy may appear in both stores or
  // multiple subpath entries); restore each once.
  const seen = new Set<string>()
  for (const ref of allRefs) {
    if (seen.has(ref.sidecar)) continue
    seen.add(ref.sidecar)
    // ref.sidecar = /<subpath>/.synapse-conflicts/<hash>; route to that mount
    // and strip the subpath to get the mount-relative leaf.
    const m = /^\/([^/]+)(\/.*)$/.exec(ref.sidecar)
    if (!m) continue
    const [, subpath, leaf] = m
    const dir = dirBySubpath.get(subpath)
    if (!dir) continue
    if (ref.kind === "file" && !ref.contentSha) {
      console.warn(
        `[sandbox] cannot restore file sidecar ${ref.sidecar} (no contentSha — pre-round-11 record); skipping`
      )
      continue
    }
    if (ref.kind === "symlink" && ref.target === undefined) {
      console.warn(
        `[sandbox] cannot restore symlink sidecar ${ref.sidecar} (no target); skipping`
      )
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
      console.error(`[sandbox] failed to restore sidecar ${ref.sidecar}:`, err)
    }
  }
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
  // deps.reconcile returns { ok, sidecars }: `sidecars` = every preserved copy
  // written (mount-subpath-prefixed, so the caller can tell the agent where its
  // pre-conflict copy is — round-7 #C + round-9 #2: surfaced EVEN when ok=false);
  // `ok=false` = the reconcile did not fully bring the live dir to committed, so
  // the caller MUST NOT advance base — leaving head!=base lets next turn's
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
    const { ok, sidecars } = await reconcileLiveDir(latestManifest)
    if (!ok) {
      // Reconcile not fully applied → do NOT advance base. Next turn's refresh
      // (head!=base) re-runs the reconcile and self-heals; advancing now would
      // let the stale local loser silently overwrite head on the following
      // commit (round-7 #A). Still return the partial sidecars so the agent is
      // told where its preserved copies are (round-9 #2).
      return { snapshotId: null, conflicts: scan.conflict_paths, sidecars }
    }
    if (latestSnapshotId && mount.base_snapshot_id !== latestSnapshotId) {
      await updateFileMount(deps.dbh, mount.id, {
        baseSnapshotId: latestSnapshotId,
      })
    }
    return { snapshotId: null, conflicts: scan.conflict_paths, sidecars }
  }

  // Short locked txn: re-check head, ingest blobs, append snapshot. Use the
  // pg-client transaction (a QueryExecutor) so space.ts helpers run on one
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
    // losers) BEFORE advancing base, so the next turn never overwrites head with
    // a stale local copy. (No-op → ok with [] when there were no conflicts.)
    const { ok, sidecars } = await reconcileLiveDir(scan.manifest_sha256)
    if (!ok) {
      // Reconcile not fully applied AFTER the snapshot committed (head advanced
      // to snapshot.id). Record the result snapshot for audit but do NOT advance
      // base — next turn's refresh (head=snapshot.id != base=old) re-runs the
      // reconcile and self-heals. Advancing base here would re-open round-6 #1
      // (the stale local loser would silently overwrite head) (round-7 #A). Still
      // return the partial sidecars so the agent learns where its copies are
      // (round-9 #2).
      await updateFileMount(deps.dbh, mount.id, {
        resultSnapshotId: snapshot.id,
      })
      return {
        snapshotId: snapshot.id,
        conflicts: scan.conflict_paths,
        sidecars,
      }
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
  const mounts = await getActiveMountsForSession(pool, sessionId)
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

  // ② stop the daemon (in-process handle if we have it, else SIGTERM the pid).
  // Always — a failed commit doesn't justify leaving the runtime process alive.
  if (deviceId) {
    const handle = liveRunHandles.get(deviceId)
    if (handle) {
      await handle.stop().catch(() => {})
      liveRunHandles.delete(deviceId)
    } else {
      const pid = mounts.find((m) => m.host_pid)?.host_pid
      if (pid) killPid(pid)
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
      await updateFileMount(pool, mount.id, {
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
      await updateFileMount(pool, mount.id, {
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
  const mounts = await getFailedRecoverableMounts(pool)
  let recovered = 0
  let stillFailed = 0
  for (const mount of mounts) {
    if (!mount.materialized_dir) continue
    // The dir may have been cleaned already (e.g. by a later successful run);
    // skip if it's gone — there's nothing to recover.
    if (!existsSync(mount.materialized_dir)) {
      await updateFileMount(pool, mount.id, {
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
      await updateFileMount(pool, mount.id, {
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
