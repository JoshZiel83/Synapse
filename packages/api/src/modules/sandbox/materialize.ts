// Supervisor-side materialize / commit / refresh against the shared CAS.
//
// Bridges the file-space DB layer (space.ts) and the Rust fs-helper via the
// one-shot driver (@synapse/device-runtime). In topology A the API and the
// sandbox device-runtime share one CAS volume (CONTENT_STORE_DIR), so the
// supervisor can materialize a base snapshot into a plain directory, scan a
// live directory back into a new manifest+blobs, and 3-way merge incoming
// commits — all by spawning a short-lived helper pointed at that CAS dir.

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  withOneShotFsHelper,
  type ManifestScanCommitResult,
  type DirSyncResult,
} from "@synapse/device-runtime"
import { CONTENT_STORE_DIR } from "../../infrastructure/storage/index.js"

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
 */
export function resolveFsHelperPath(): string {
  const fromEnv = process.env.SYNAPSE_DEVICE_FS_HELPER_PATH?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const here = fileURLToPath(import.meta.url)
  // dist layout: packages/api/dist/modules/sandbox/materialize.js → up to repo.
  // src layout (tsx): packages/api/src/modules/sandbox/materialize.ts.
  const candidateRoots = [
    resolve(here, "..", "..", "..", "..", "..", "..", "sidecars", "fs-helper"),
    resolve(here, "..", "..", "..", "..", "..", "sidecars", "fs-helper"),
    resolve(here, "..", "..", "..", "..", "sidecars", "fs-helper"),
  ]
  const suffixes = [
    join("target", "release", "synapse-device-fs-helper"),
    join("target", "debug", "synapse-device-fs-helper"),
    "synapse-device-fs-helper",
  ]
  for (const root of candidateRoots) {
    for (const suffix of suffixes) {
      const candidate = join(root, suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new SandboxMaterializeError(
    "synapse-device-fs-helper binary not found (build:fs-helper or set SYNAPSE_DEVICE_FS_HELPER_PATH)"
  )
}

/** Shared CAS dir all helpers operate against (topology A). */
export function casDir(): string {
  return CONTENT_STORE_DIR
}

interface HelperContext {
  helperPath: string
  casDir: string
}

function helperContext(): HelperContext {
  return { helperPath: resolveFsHelperPath(), casDir: casDir() }
}

/**
 * Materialize a base snapshot's manifest into `targetDir` as a plain directory
 * (reflink same-fs / copy). Omitting manifestSha256 yields an empty tree.
 */
export async function materializeSnapshot(input: {
  manifestSha256?: string
  targetDir: string
}): Promise<void> {
  const ctx = helperContext()
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
}): Promise<ManifestScanCommitResult> {
  const ctx = helperContext()
  return withOneShotFsHelper(ctx, (helper) =>
    helper.manifestScanCommit({
      dir: input.dir,
      base_manifest_sha256: input.baseManifestSha256,
      latest_manifest_sha256: input.latestManifestSha256,
    })
  )
}

/**
 * 3-way merge an incoming head manifest into a live working directory without
 * unmounting: applies (incoming − base) for paths the agent hasn't locally
 * dirtied, defers same-path conflicts. Returns the applied/deferred paths and
 * the new base manifest sha the caller must advance file_mounts.base_snapshot_id
 * to (else the next commit treats just-synced incoming as local dirt).
 */
export async function syncDir(input: {
  dir: string
  baseManifestSha256?: string
  toManifestSha256: string
}): Promise<DirSyncResult> {
  const ctx = helperContext()
  return withOneShotFsHelper(ctx, (helper) =>
    helper.dirSync({
      dir: input.dir,
      base_manifest_sha256: input.baseManifestSha256,
      to_manifest_sha256: input.toManifestSha256,
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
