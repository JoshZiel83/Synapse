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
import { join } from "node:path"
import { actorRef, conversationRef } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { transaction, pool } from "../../infrastructure/database/index.js"
import { STORAGE_DIR } from "../../infrastructure/storage/index.js"
import { config } from "../../config/index.js"
import { startPairing, deleteDevice } from "../devices/service.js"
import {
  ensureFileSpace,
  insertFileMount,
  updateFileMount,
  getActiveMountsForSession,
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
} from "./materialize.js"
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
    // Already provisioned this session.
    const deviceId = existing.find((m) => m.device_id)?.device_id ?? ""
    return {
      sessionId,
      sandboxRoot: sandboxRootFor(sessionId),
      deviceId,
      commandlineEnabled: false,
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
      confineCommands: commandlineEnabled,
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
 * Turn-start refresh: 3-way merge each multi-writer space's (/conversation,
 * /actor) new head into the live dir without unmounting, then advance the
 * mount's base_snapshot_id to the merged-in head. /actor-conversation is single
 * writer — not refreshed.
 */
export async function refreshSpaces(sessionId: string): Promise<void> {
  const mounts = await getActiveMountsForSession(pool, sessionId)
  for (const mount of mounts) {
    if (mount.mount_subpath === "actor-conversation") continue
    if (!mount.materialized_dir) continue

    const space = await getFileSpace(pool, mount.file_space_id)
    const head = space?.current_snapshot_id ?? null
    if (!head || head === mount.base_snapshot_id) continue // nothing new

    const headManifest = await getSnapshotManifestSha(pool, head)
    if (!headManifest) continue
    const baseManifest = mount.base_snapshot_id
      ? await getSnapshotManifestSha(pool, mount.base_snapshot_id)
      : null

    await syncDir({
      dir: mount.materialized_dir,
      baseManifestSha256: baseManifest ?? undefined,
      toManifestSha256: headManifest,
    })
    // Advance base to the synced-in head so the next commit doesn't treat the
    // just-merged incoming as local dirt and self-conflict.
    await updateFileMount(pool, mount.id, { baseSnapshotId: head })
  }
}

export interface CommitResult {
  /** subpath → new snapshot id (only spaces that produced a new snapshot). */
  snapshotIdBySubpath: Record<string, string>
  /** subpath → conflict paths surfaced (per-file isolation). */
  conflictsBySubpath: Record<string, string[]>
}

/**
 * Commit dirty spaces. `which` selects subpaths (default: the multi-writer
 * spaces /conversation + /actor; teardown also commits /actor-conversation).
 * scan+ingest runs OUTSIDE the DB row lock (slow); the short locked txn just
 * re-checks head + appends the snapshot, re-scanning if head moved.
 */
export async function commitSpaces(
  sessionId: string,
  which?: MountSubpath[]
): Promise<CommitResult> {
  const ctx = await loadSessionContext(sessionId)
  if (!ctx) throw new SandboxServiceError(`session ${sessionId} not found`, 404)
  const mounts = await getActiveMountsForSession(pool, sessionId)
  const subpaths = which ?? ["conversation", "actor"]
  const out: CommitResult = { snapshotIdBySubpath: {}, conflictsBySubpath: {} }

  for (const mount of mounts) {
    if (!subpaths.includes(mount.mount_subpath)) continue
    if (!mount.materialized_dir) continue

    const result = await commitOneMount(ctx.workspaceId, sessionId, mount)
    if (result.snapshotId) {
      out.snapshotIdBySubpath[mount.mount_subpath] = result.snapshotId
    }
    if (result.conflicts.length > 0) {
      out.conflictsBySubpath[mount.mount_subpath] = result.conflicts
    }
  }
  return out
}

async function commitOneMount(
  workspaceId: string,
  sessionId: string,
  mount: FileMountRow,
  attempt = 0
): Promise<{ snapshotId: string | null; conflicts: string[] }> {
  if (attempt > 3) {
    throw new SandboxServiceError(
      `commit for mount ${mount.id} kept losing the head race`,
      409
    )
  }
  // Read current head OUTSIDE the lock as `latest`.
  const space = await getFileSpace(pool, mount.file_space_id)
  const latestSnapshotId = space?.current_snapshot_id ?? null
  const baseManifest = mount.base_snapshot_id
    ? await getSnapshotManifestSha(pool, mount.base_snapshot_id)
    : null
  const latestManifest = latestSnapshotId
    ? await getSnapshotManifestSha(pool, latestSnapshotId)
    : null

  // Scan + CAS-ingest the live dir (slow; no DB lock held).
  const scan = await scanCommitDir({
    dir: mount.materialized_dir!,
    baseManifestSha256: baseManifest ?? undefined,
    latestManifestSha256: latestManifest ?? undefined,
  })

  // Nothing changed vs latest → no new snapshot (avoid empty version bumps).
  if (latestManifest && scan.manifest_sha256 === latestManifest) {
    return { snapshotId: null, conflicts: scan.conflict_paths }
  }

  // Short locked txn: re-check head, ingest blobs, append snapshot. Use the
  // pg-client transaction (a QueryExecutor) so space.ts helpers run on one
  // connection inside BEGIN/COMMIT.
  try {
    const snapshot = await transaction(async (txq) => {
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
    // Advance the mount base to the snapshot we just produced.
    await updateFileMount(pool, mount.id, {
      baseSnapshotId: snapshot.id,
      resultSnapshotId: snapshot.id,
    })
    return { snapshotId: snapshot.id, conflicts: scan.conflict_paths }
  } catch (err) {
    // Head moved during scan → re-scan against the new head (cheap: blobs are
    // already in CAS). Never merge the already-merged manifest again.
    if (err instanceof Error && /head moved/.test(err.message)) {
      return commitOneMount(workspaceId, sessionId, mount, attempt + 1)
    }
    throw err
  }
}

export interface TeardownSandboxOptions {
  hostProvider?: HostProvider
}

/**
 * Teardown: commit all dirty spaces, stop the daemon, delete the live dirs
 * (CAS untouched), close the mounts, revoke grants, delete the device.
 */
export async function teardownSandbox(
  sessionId: string,
  _options: TeardownSandboxOptions = {}
): Promise<void> {
  const ctx = await loadSessionContext(sessionId)
  const mounts = await getActiveMountsForSession(pool, sessionId)
  if (mounts.length === 0) return

  // ① commit ALL dirty spaces (incl /actor-conversation, and any /conversation
  // ·/actor that an exception skipped at turn-end).
  try {
    await commitSpaces(sessionId, [
      "conversation",
      "actor",
      "actor-conversation",
    ])
  } catch (err) {
    console.error(`[sandbox] teardown commit failed for ${sessionId}:`, err)
  }

  const deviceId = mounts.find((m) => m.device_id)?.device_id ?? null

  // ② stop the daemon (in-process handle if we have it, else SIGTERM the pid).
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

  // ③ delete the live dirs (CAS is the source of truth; dirs are scratch).
  await rm(sandboxRootFor(sessionId), { recursive: true, force: true }).catch(
    () => {}
  )
  await cleanupDirs([sandboxRootFor(sessionId)]).catch(() => {})

  // ④ close mounts.
  for (const mount of mounts) {
    await updateFileMount(pool, mount.id, {
      status: "closed",
      closedAt: true,
    }).catch(() => {})
  }

  // ⑤ revoke grants + ⑥ delete device (cascades device_* children).
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
