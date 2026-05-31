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
 * Turn-start refresh: 3-way merge each multi-writer space's (/conversation,
 * /actor) new head into the live dir without unmounting, then advance the
 * mount's base_snapshot_id to the merged-in head. /actor-conversation is single
 * writer — not refreshed.
 *
 * Returns, per subpath: the deferred conflict paths (head won the live path;
 * the agent must reconcile) and the actual sidecar paths written (agent-visible
 * VFS paths where each conflicting file's pre-conflict local copy was preserved
 * — file conflicts only). The caller surfaces both to the agent.
 */
export async function refreshSpaces(sessionId: string): Promise<{
  deferredConflictsBySubpath: Record<string, string[]>
  sidecarsBySubpath: Record<string, { original: string; sidecar: string }[]>
}> {
  const mounts = await getActiveMountsForSession(pool, sessionId)
  const deferredConflictsBySubpath: Record<string, string[]> = {}
  const sidecarsBySubpath: Record<
    string,
    { original: string; sidecar: string }[]
  > = {}
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

    const sync = await syncDir({
      dir: mount.materialized_dir,
      baseManifestSha256: baseManifest ?? undefined,
      toManifestSha256: headManifest,
    })
    if (sync.deferred_conflicts.length > 0) {
      deferredConflictsBySubpath[mount.mount_subpath] = sync.deferred_conflicts
    }
    if (sync.conflict_sidecars.length > 0) {
      // Make the sidecar VFS paths agent-visible by prefixing the mount subpath
      // (the Rust paths are relative to the mount root, e.g.
      // /.synapse-conflicts/foo → /conversation/.synapse-conflicts/foo).
      sidecarsBySubpath[mount.mount_subpath] = sync.conflict_sidecars.map(
        (c) => ({
          original: `/${mount.mount_subpath}${c.original}`,
          sidecar: `/${mount.mount_subpath}${c.sidecar}`,
        })
      )
    }
    // ALWAYS advance base to the synced-in head. dir_sync resolves conflicts
    // HEAD-WINS in the live tree (head applied to the live path; the agent's
    // pre-conflict local copy preserved at the conflict sidecar), so after sync
    // working == head for every incoming path. Advancing base to head therefore
    // (a) lets the agent's reconciled re-edit commit cleanly (no spurious
    // re-conflict against the same head — the round-4 dead-end), and (b) never
    // silently overwrites the concurrent change, because on conflict the live
    // path already holds head, not the agent's stale local copy.
    await updateFileMount(pool, mount.id, { baseSnapshotId: head })
  }
  return { deferredConflictsBySubpath, sidecarsBySubpath }
}

export interface CommitResult {
  /** subpath → new snapshot id (only spaces that produced a new snapshot). */
  snapshotIdBySubpath: Record<string, string>
  /** subpath → conflict paths surfaced (per-file isolation). */
  conflictsBySubpath: Record<string, string[]>
  /**
   * subpath → sidecars the post-commit reconcile preserved (original VFS path →
   * sidecar path). The agent's pre-conflict copy of each lost file lives here,
   * so the next-turn notice can point at it instead of claiming the work was
   * simply lost (round-7 #C).
   */
  sidecarsBySubpath: Record<string, { original: string; sidecar: string }[]>
}

/** A conflicting file whose pre-conflict local copy was preserved at a sidecar. */
export interface ConflictSidecarRef {
  original: string
  sidecar: string
}

/** Per-subpath pending commit conflicts: the lost paths + their sidecars. */
export interface PendingCommitConflict {
  paths: string[]
  sidecars: ConflictSidecarRef[]
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
  const out: CommitResult = {
    snapshotIdBySubpath: {},
    conflictsBySubpath: {},
    sidecarsBySubpath: {},
  }

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
    await recordPendingCommitConflicts(sessionId, pending).catch((err) =>
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
 * Stash turn-end commit conflicts on the session for the next turn to surface.
 * MERGES with any already-pending conflicts (union by subpath: deduped paths +
 * deduped sidecars) rather than replacing — otherwise a still-undelivered notice
 * from a turn whose actorThink threw (so it wasn't cleared) would be clobbered by
 * a new conflict. Each subpath carries both the lost paths and the sidecars where
 * the agent's pre-conflict copy was preserved (round-7 #C).
 */
async function recordPendingCommitConflicts(
  sessionId: string,
  conflictsBySubpath: Record<string, PendingCommitConflict>
): Promise<void> {
  await transaction(async (txq) => {
    const existing = await txq.query(
      `SELECT collaboration_state FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    )
    const state = (existing.rows[0]?.collaboration_state ?? {}) as Record<
      string,
      unknown
    >
    const prev = normalizePendingConflicts(state[PENDING_CONFLICTS_KEY])
    const merged: Record<string, PendingCommitConflict> = { ...prev }
    for (const [sub, incoming] of Object.entries(conflictsBySubpath)) {
      const existingEntry = merged[sub] ?? { paths: [], sidecars: [] }
      const paths = Array.from(
        new Set([...existingEntry.paths, ...incoming.paths])
      )
      // Dedup sidecars by original path (a re-occurring conflict keeps the
      // latest sidecar location — they share the deterministic prefix anyway).
      const byOriginal = new Map<string, ConflictSidecarRef>()
      for (const s of [...existingEntry.sidecars, ...incoming.sidecars]) {
        byOriginal.set(s.original, s)
      }
      merged[sub] = { paths, sidecars: Array.from(byOriginal.values()) }
    }
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
          ? (v.sidecars as ConflictSidecarRef[])
          : [],
      }
    }
  }
  return out
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

async function commitOneMount(
  workspaceId: string,
  sessionId: string,
  mount: FileMountRow,
  attempt = 0
): Promise<{
  snapshotId: string | null
  conflicts: string[]
  sidecars: { original: string; sidecar: string }[]
}> {
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
  // Returns the sidecars written (mount-subpath-prefixed, so the caller can tell
  // the agent where its pre-conflict copy is — round-7 #C), or `null` if the
  // reconcile RPC FAILED. On failure the caller MUST NOT advance base: leaving
  // head!=base lets next turn's refresh re-run the reconcile and self-heal,
  // whereas advancing base now would re-open the round-6 #1 silent-overwrite bug
  // (round-7 #A — the reconcile is an out-of-process RPC that can throw).
  const reconcileLiveDir = async (
    committedManifestSha: string
  ): Promise<{ original: string; sidecar: string }[] | null> => {
    if (scan.conflict_paths.length === 0) return []
    try {
      const res = await syncDir({
        dir: mount.materialized_dir!,
        baseManifestSha256: baseManifest ?? undefined,
        toManifestSha256: committedManifestSha,
      })
      // Make the sidecar VFS paths agent-visible by prefixing the mount subpath
      // (the Rust paths are relative to the mount root).
      return res.conflict_sidecars.map((c) => ({
        original: `/${mount.mount_subpath}${c.original}`,
        sidecar: `/${mount.mount_subpath}${c.sidecar}`,
      }))
    } catch (err) {
      console.error(
        `[sandbox] post-commit reconcile failed for mount ${mount.id}:`,
        err
      )
      return null
    }
  }

  // Nothing to commit beyond the current head (no local changes, or all local
  // changes lost to head on conflict): the merged manifest equals latest. Don't
  // bump the version, BUT reconcile the live dir + advance the mount base to
  // latest so the next commit doesn't re-derive the same conflict (and doesn't
  // overwrite head with the stale local copy).
  if (latestManifest && scan.manifest_sha256 === latestManifest) {
    const sidecars = await reconcileLiveDir(latestManifest)
    if (sidecars === null) {
      // Reconcile failed → do NOT advance base. Next turn's refresh (head!=base)
      // re-runs the reconcile and self-heals; advancing now would let the stale
      // local loser silently overwrite head on the following commit (round-7 #A).
      return { snapshotId: null, conflicts: scan.conflict_paths, sidecars: [] }
    }
    if (latestSnapshotId && mount.base_snapshot_id !== latestSnapshotId) {
      await updateFileMount(pool, mount.id, {
        baseSnapshotId: latestSnapshotId,
      })
    }
    return { snapshotId: null, conflicts: scan.conflict_paths, sidecars }
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
    // Reconcile the live dir to the committed manifest (head-wins + sidecar the
    // losers) BEFORE advancing base, so the next turn never overwrites head with
    // a stale local copy. (No-op → [] when there were no conflicts.)
    const sidecars = await reconcileLiveDir(scan.manifest_sha256)
    if (sidecars === null) {
      // Reconcile failed AFTER the snapshot committed (head advanced to
      // snapshot.id). Record the result snapshot for audit but do NOT advance
      // base — next turn's refresh (head=snapshot.id != base=old) re-runs the
      // reconcile and self-heals. Advancing base here would re-open round-6 #1
      // (the stale local loser would silently overwrite head) (round-7 #A).
      await updateFileMount(pool, mount.id, { resultSnapshotId: snapshot.id })
      return {
        snapshotId: snapshot.id,
        conflicts: scan.conflict_paths,
        sidecars: [],
      }
    }
    // Advance the mount base to the snapshot we just produced.
    await updateFileMount(pool, mount.id, {
      baseSnapshotId: snapshot.id,
      resultSnapshotId: snapshot.id,
    })
    return { snapshotId: snapshot.id, conflicts: scan.conflict_paths, sidecars }
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
        mount
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
