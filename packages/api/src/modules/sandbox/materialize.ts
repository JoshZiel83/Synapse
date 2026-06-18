// Supervisor-side materialize / commit / refresh against the shared CAS.
//
// Bridges the file-space DB layer (space.ts) and the Rust fs-helper via the
// one-shot driver (@synapse/device-runtime). In topology A the API and the
// sandbox device-runtime share one CAS volume (CONTENT_STORE_DIR), so the
// supervisor can materialize a base snapshot into a plain directory, scan a
// live directory back into a new manifest+blobs, and 3-way merge incoming
// commits — all by spawning a short-lived helper pointed at that CAS dir.

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  withOneShotFsHelper,
  resolveSidecarPathOrThrow,
  FS_HELPER_PROFILES,
  FS_HELPER_ENV_VAR,
  type ManifestScanCommitResult,
  type DirSyncResult,
} from "@synapse/device-runtime"
import { CONTENT_STORE_DIR } from "../../infrastructure/storage/index.js"
import {
  readContentBuffer,
  listBackends,
} from "../../infrastructure/storage/content-store.js"
import type { WriteRoutingContext } from "../../infrastructure/storage/content-store.js"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"
import { parseManifestShas } from "../files/manifest-parse.js"
import {
  ensureBlobsLocal,
  pushNewBlobsToDurable,
  hydrateViaPresigned,
  pushViaPresigned,
} from "./cas-hydration.js"
import { selectWriteBackend } from "../../infrastructure/storage/content-store.js"
import type { BlobAccess } from "./host-provider.js"
import type { Executor } from "./repo.js"

export class SandboxMaterializeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxMaterializeError"
  }
}

/**
 * Resolve the synapse-device-fs-helper binary. Honors
 * SYNAPSE_DEVICE_FS_HELPER_PATH, then probes the sidecar build outputs
 * (release preferred, then debug) relative to the repo root. Throws if none
 * found (fail-loud — a sandbox cannot materialize without the helper).
 *
 * Suffix order + selection mode come from the shared FS_HELPER_PROFILES.release
 * spec (single source of truth); only the candidate ROOTS are api-specific
 * (anchored on this file via import.meta.url to handle the dist-vs-src layout).
 * Release-first is deliberate: a stray newer debug build must not shadow the
 * deployed release.
 */
export function resolveFsHelperPath(): string {
  const here = fileURLToPath(import.meta.url)
  // dist layout: packages/api/dist/modules/sandbox/materialize.js → up to repo.
  // src layout (tsx): packages/api/src/modules/sandbox/materialize.ts.
  const roots = [
    resolve(here, "..", "..", "..", "..", "..", "..", "sidecars", "fs-helper"),
    resolve(here, "..", "..", "..", "..", "..", "sidecars", "fs-helper"),
    resolve(here, "..", "..", "..", "..", "sidecars", "fs-helper"),
  ]
  return resolveSidecarPathOrThrow(
    {
      roots,
      suffixes: FS_HELPER_PROFILES.release.suffixes,
      mode: FS_HELPER_PROFILES.release.mode,
      envVar: FS_HELPER_ENV_VAR,
    },
    () =>
      new SandboxMaterializeError(
        "synapse-device-fs-helper binary not found (build:fs-helper or set SYNAPSE_DEVICE_FS_HELPER_PATH)"
      )
  )
}

/** Shared CAS dir all helpers operate against (topology A). */
export function casDir(): string {
  return CONTENT_STORE_DIR
}

interface HelperContext {
  helperPath: string
  casDir: string
  /** Active trace context (P7) — the spawned helper's spans parent under it. */
  traceparent?: string
}

function helperContext(): HelperContext {
  // Captured here so it reflects the api span active at the call site (these
  // run inside the request/worker span); undefined when OTEL is off → the
  // helper starts root spans.
  return {
    helperPath: resolveFsHelperPath(),
    casDir: casDir(),
    traceparent: activeTraceparent(),
  }
}

/**
 * Materialize a base snapshot's manifest into `targetDir` as a plain directory
 * (reflink same-fs / copy). Omitting manifestSha256 yields an empty tree.
 */
export async function materializeSnapshot(input: {
  manifestSha256?: string
  targetDir: string
  /**
   * How the host reaches blob bytes (plan §8.3). Omitted/`local_cas` (the
   * default) → axis A: the supervisor fills the SHARED cache directly and the
   * helper reflinks (byte-identical to today). `presigned` → axis B: the REMOTE
   * helper streams each supervisor-minted presigned GET into its own --cas-dir.
   */
  blobAccess?: BlobAccess
}): Promise<void> {
  const ctx = helperContext()
  const access = input.blobAccess
  const presigned = access?.kind === "presigned" ? access : undefined
  // Local-only fast path (plan §8.3 axis A default): with NO remote backend
  // wired AND the host not on the presigned axis, every blob is already in the
  // shared CAS the helper reflinks from, so the entire hydrate step
  // (ensureBlobsLocal + manifest read + parseManifestShas + per-sha fs.access)
  // is a pure no-op. Skip it so a local-only provision does exactly what it did
  // before the cutover. When a remote backend IS configured (axis A push/pull or
  // axis B presigned) the full hydrate below runs unchanged.
  const skipHydrate = listBackends().length === 0 && !presigned
  // Compute the supervisor-side sha set to hydrate (manifest + its file blobs).
  // This list is ALWAYS supervisor-derived — never host-supplied — which is the
  // TOCTOU-free property the presigned minting relies on (plan §9.3).
  let manifestSha: string | undefined
  let fileShas: string[] = []
  if (input.manifestSha256 && !skipHydrate) {
    manifestSha = input.manifestSha256
    // Axis A: pull into the shared local cache so the (unchanged) helper can
    // reflink. For local-only this is a no-op (already cached) → byte-identical.
    // Axis B: still hydrate the manifest into the SUPERVISOR's cache so we can
    // read+expand it to enumerate the file shas to mint for the remote host.
    await ensureBlobsLocal([manifestSha])
    try {
      const bytes = await readContentBuffer(manifestSha)
      fileShas = Array.from(parseManifestShas(bytes))
    } catch {
      // Unreadable/missing manifest: skip file-blob hydration; the helper's
      // manifestMaterialize will surface the same NotFound it does today.
      fileShas = []
    }
    if (fileShas.length > 0 && !presigned) await ensureBlobsLocal(fileShas)
  }
  if (presigned) {
    // Axis B (plan §8.3/§9.2): the remote host has NO shared cache. Drive the
    // one-shot helper (pinned to --presign-allow-host) to fetch each
    // supervisor-minted presigned GET into its own --cas-dir before materialize.
    // TODO(plan §9.3): thread --presign-allow-host through withOneShotFsHelper —
    // the one-shot driver now accepts presignAllowHost, wired below.
    const toFetch = [...(manifestSha ? [manifestSha] : []), ...fileShas]
    await withOneShotFsHelper(
      { ...ctx, presignAllowHost: [presigned.allowHost] },
      (helper) => hydrateViaPresigned(toFetch, presigned.backend, helper)
    )
  }
  await withOneShotFsHelper(ctx, (helper) =>
    helper.manifestMaterialize({
      manifest_sha256: input.manifestSha256,
      target_dir: input.targetDir,
    })
  )
}

/**
 * Scan a live working directory back into a manifest + CAS blobs, 3-way merging
 * against `latestManifestSha256` (the current space head) when it differs from
 * `baseManifestSha256` (what the dir was materialized from). Returns the merged
 * manifest sha, the set of new blobs ingested, and any per-file conflict paths.
 * The caller persists content_blobs + a file_snapshot from this result.
 */
export async function scanCommitDir(input: {
  dir: string
  baseManifestSha256?: string
  latestManifestSha256?: string
  /**
   * Write-routing context for the durable push (plan §9.2). The scanned new
   * blobs are pushed to their routed durable backend BEFORE this returns — i.e.
   * before the caller makes the snapshot row durable. Omitted/empty → routes to
   * local_cas (the byte-identical default: bytes already durable in the cache).
   */
  routing?: WriteRoutingContext
  /**
   * Executor the durable push records content_blobs rows on. Threads the
   * caller's connection/transaction (and a test's injected executor) so the row
   * write is NOT issued against the global db singleton — preserving today's
   * transaction + test-isolation semantics. Defaults to the top-level db.
   */
  executor?: Executor
  /**
   * How the host reaches blob bytes (plan §8.3). Omitted/`local_cas` (the
   * default) → axis A: the supervisor reads the SHARED cache and PUTs to the
   * routed backend (byte-identical to today; local_cas = no-op). `presigned` →
   * axis B: the REMOTE helper streams each new blob to a supervisor-minted
   * presigned PUT and the supervisor records the row after a confirmed export.
   */
  blobAccess?: BlobAccess
}): Promise<ManifestScanCommitResult> {
  const ctx = helperContext()
  const access = input.blobAccess
  const presigned = access?.kind === "presigned" ? access : undefined
  if (presigned) {
    // Axis B (plan §8.3/§9.2): one one-shot helper (pinned to its allow-host)
    // scans the live dir into ITS --cas-dir, then exports each new blob via a
    // supervisor-minted presigned PUT. The push must precede the caller's
    // snapshot row (caller ordering). The supervisor mints PUT urls for ONLY the
    // shas the scan returned — never a host-supplied list (plan §9.3 TOCTOU-free).
    // TODO(plan §9.3): thread --presign-allow-host through withOneShotFsHelper —
    // the one-shot driver now accepts presignAllowHost, wired below.
    const pushBackend = selectWriteBackend(input.routing ?? {})
    return withOneShotFsHelper(
      { ...ctx, presignAllowHost: [presigned.allowHost] },
      async (helper) => {
        const result = await helper.manifestScanCommit({
          dir: input.dir,
          base_manifest_sha256: input.baseManifestSha256,
          latest_manifest_sha256: input.latestManifestSha256,
        })
        await pushViaPresigned(
          result.new_blobs,
          pushBackend,
          helper,
          input.executor
        )
        return result
      }
    )
  }
  const result = await withOneShotFsHelper(ctx, (helper) =>
    helper.manifestScanCommit({
      dir: input.dir,
      base_manifest_sha256: input.baseManifestSha256,
      latest_manifest_sha256: input.latestManifestSha256,
    })
  )
  // Push-after (plan §9.2): the new blobs were just ingested into the LOCAL
  // cache; push them to their routed durable backend BEFORE the caller commits
  // the snapshot row. For a local-only deployment the routed backend is
  // local_cas → the bytes are already durable and this records local_cas rows on
  // the caller's executor (byte-identical to today; idempotent with the caller's
  // own in-txn ensureContentBlob via ON CONFLICT DO NOTHING).
  await pushNewBlobsToDurable(
    result.new_blobs,
    input.routing ?? {},
    input.executor
  )
  return result
}

/**
 * 3-way merge an incoming head manifest into a live working directory without
 * unmounting: applies (incoming − base) for paths the agent hasn't locally
 * dirtied, defers same-path conflicts (head-wins + sidecar the loser). On a
 * fully-applied sync, returns the new base manifest sha the caller advances
 * file_mounts.base_snapshot_id to (else the next commit treats just-synced
 * incoming as local dirt). If the helper STOPPED EARLY on a per-path failure it
 * returns `incomplete` set (with `new_base_manifest_sha256` empty) plus the
 * partial `conflict_sidecars` already written — the caller must NOT advance base
 * but MUST still surface those sidecars (round-9 #2).
 */
export async function syncDir(input: {
  dir: string
  baseManifestSha256?: string
  toManifestSha256: string
  /** R12-1: defer the head-overwrite of conflict paths to applyHeadForConflicts
   * so the caller can durably persist the pending record first. */
  deferConflictApply?: boolean
}): Promise<DirSyncResult> {
  const ctx = helperContext()
  return withOneShotFsHelper(ctx, (helper) =>
    helper.dirSync({
      dir: input.dir,
      base_manifest_sha256: input.baseManifestSha256,
      to_manifest_sha256: input.toManifestSha256,
      defer_conflict_apply: input.deferConflictApply,
    })
  )
}

/**
 * Phase 2 of a deferred refresh (R12-1): overwrite the live conflict `paths`
 * with head AFTER the pending record is durably persisted. Until this runs the
 * conflict paths hold the agent's copy, so a persist failure self-heals.
 */
export async function applyHeadForConflicts(input: {
  dir: string
  toManifestSha256: string
  paths: string[]
}): Promise<void> {
  if (input.paths.length === 0) return
  const ctx = helperContext()
  await withOneShotFsHelper(ctx, (helper) =>
    helper.dirApplyHead({
      dir: input.dir,
      to_manifest_sha256: input.toManifestSha256,
      paths: input.paths,
    })
  )
}

/**
 * Garbage-collect CAS blobs not in the reachable set. `graceSecs` protects
 * blobs younger than the window from deletion (default 1h in the helper) so an
 * in-flight commit — which writes blobs before its snapshot row commits — can't
 * be raced into corruption.
 */
export async function gcCas(
  reachableSha256: string[],
  graceSecs?: number
): Promise<number> {
  const ctx = helperContext()
  const result = await withOneShotFsHelper(ctx, (helper) =>
    helper.casGc({
      reachable_sha256: reachableSha256,
      ...(graceSecs !== undefined ? { grace_secs: graceSecs } : {}),
    })
  )
  return result.deleted_count
}

/** Remove scratch directories (e.g. torn-down sandbox live dirs). */
export async function cleanupDirs(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const ctx = helperContext()
  await withOneShotFsHelper(ctx, (helper) => helper.manifestCleanup({ paths }))
}

/**
 * Re-materialize a conflict sidecar from its durable recovery payload (round-11
 * #1) into the live mount dir, after a teardown deleted the prior live dir.
 * `sidecarVfs` is the mount-relative leaf (e.g. /.synapse-conflicts/<hash>); the
 * file bytes come from CAS via `contentSha`, or a symlink's `target` is rewrapped
 * as JSON. Idempotent (overwrites its own leaf).
 */
export async function restoreSidecar(input: {
  dir: string
  sidecarVfs: string
  kind: string
  contentSha?: string
  target?: string
}): Promise<void> {
  const ctx = helperContext()
  await withOneShotFsHelper(ctx, (helper) =>
    helper.sidecarRestore({
      dir: input.dir,
      sidecar_vfs: input.sidecarVfs,
      kind: input.kind,
      content_sha: input.contentSha,
      target: input.target,
    })
  )
}
