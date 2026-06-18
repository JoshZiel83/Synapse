// The single content-byte implementation (plan §6.5#1, §8.1).
//
// All blob byte IO funnels through ONE place: a `ContentStore` per backend +
// a registry keyed by `content_blobs.backend`. There is exactly one local
// implementation (`LocalCasStore`, the moved-here body of the old
// putBufferCas/readCasBlob free functions) and a seam for OpenDAL-backed
// remote stores. NO other module may read/write the CAS directly — the old
// `storage/index.ts` byte free-functions were deleted (no shims), and a guard
// (plan §6.5#5) keeps it that way.
//
// `local_cas` is just one registry entry; there is NO `if (local) {direct fs}`
// branch anywhere — the read/write path is uniformly
// `resolveStore(getBlobBackend(sha))` / `writeStore(ctx)`.

import path from "node:path"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import type { FileStorageBackend } from "@synapse/shared/types"
import { CONTENT_STORE_DIR } from "./index.js"
import { getBlobBackend } from "./repo.js"
import { loadBackendRegistry, loadWriteDefault } from "./remote/config.js"

/** A backend id (validated at the app write boundary against the configured registry). */
export type BackendId = FileStorageBackend

/** Inputs to the write-routing decision (plan §6.1 selectWriteBackend). */
export interface WriteRoutingContext {
  workspaceId?: string | null
  originFamily?: string
  originSystem?: string
  contentKind?: string
  sizeBytes?: number
  fileSpaceId?: string | null
}

export interface PresignedReq {
  method: string
  url: string
  headers: Record<string, string>
}

/**
 * One logical backend's byte surface. key = f(sha) (`blobs/<aa>/<sha>`), so
 * there is NO per-blob locator parameter (plan §6.2). Remote backends add
 * list/delete/head/presign; local_cas does not presign (canPresign=false).
 *
 * The remote methods are OPTIONAL: `LocalCasStore` omits them (they are
 * `undefined`) and is gated by `canPresign=false`; callers that need them
 * (GC durable sweep §10, axis-B host direct transfer §9) feature-detect via
 * `canPresign` or an explicit `if (store.head)` guard. Remote backends
 * (`S3ContentStore`) implement all of them (plan §8.1).
 */
export interface ContentStore {
  /** Store bytes; sha is computed by the store. Returns dedup=true if already present. */
  putBuffer(
    buffer: Buffer
  ): Promise<{ sha256: string; sizeBytes: number; dedup: boolean }>
  /** Read bytes by sha. Throws (ENOENT-like) if absent. */
  readBuffer(sha256: string): Promise<Buffer>
  /** True if present in THIS backend. */
  exists(sha256: string): Promise<boolean>
  readonly backend: BackendId
  readonly canPresign: boolean

  // ── optional remote surface (plan §8.1) — undefined on local_cas ──────────
  /** Read bytes by sha as a Node readable stream (large-object friendly). */
  getStream?(sha256: string): Promise<NodeJS.ReadableStream>
  /** Of the given shas, which are durably present in THIS backend (batched). */
  head?(shas: string[]): Promise<Set<string>>
  /** Enumerate shas under a key prefix for durable GC sweep (plan §10). */
  list?(prefix: string): Promise<string[]>
  /**
   * Like `list`, but also returns each object's last-modified time when the
   * backend exposes it (plan §10#1 orphan-race grace). The durable sweep prefers
   * this over `list` so it can skip deleting a no-content_blobs-row object whose
   * bytes were PUT within the grace window (a concurrent commit PUTs bytes BEFORE
   * writing the row). `lastModified` is OPTIONAL per object (absent → treated as
   * old, i.e. eligible, same as `list`).
   */
  listWithMeta?(prefix: string): Promise<{ sha: string; lastModified?: Date }[]>
  /** Remove a blob's bytes from THIS backend (durable GC). */
  delete?(sha256: string): Promise<void>
  /** Mint a presigned GET (host direct download, plan §9). */
  presignGet?(sha256: string, ttlSec: number): Promise<PresignedReq>
  /** Mint a presigned PUT (host direct upload, plan §9.3 — sha-checked). */
  presignPut?(sha256: string, ttlSec: number): Promise<PresignedReq>
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

// ─────────────────────────── local_cas store ────────────────────────────────
// Moved verbatim from the deleted storage/index.ts putBufferCas/readCasBlob/
// casBlobPath/casBlobExists. Atomic tmp+rename + 0o600 are PRESERVED because the
// on-disk layout is a bit-compatible contract shared with the Rust fs-helper
// (sidecars/fs-helper/src/blobs.rs); that is why local is NOT a plain OpenDAL
// `fs` Operator (OpenDAL fs has no file-mode API — plan §6.5#1).
class LocalCasStore implements ContentStore {
  readonly backend: BackendId = "local_cas"
  readonly canPresign = false

  private blobPath(sha256: string): string {
    return path.join(CONTENT_STORE_DIR, "blobs", sha256.slice(0, 2), sha256)
  }

  async putBuffer(
    buffer: Buffer
  ): Promise<{ sha256: string; sizeBytes: number; dedup: boolean }> {
    const sha256 = sha256Hex(buffer)
    const finalPath = this.blobPath(sha256)
    try {
      const stat = await fs.stat(finalPath)
      return { sha256, sizeBytes: stat.size, dedup: true }
    } catch {
      /* not present — write it */
    }
    await fs.mkdir(path.dirname(finalPath), { recursive: true })
    const tmpPath = `${finalPath}.incoming.${crypto.randomUUID()}`
    await fs.writeFile(tmpPath, buffer, { mode: 0o600 })
    try {
      await fs.rename(tmpPath, finalPath)
    } catch (err) {
      // Lost a race with a concurrent writer of the same sha — content is
      // identical. Clean up our tmp and treat as dedup.
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      try {
        const stat = await fs.stat(finalPath)
        return { sha256, sizeBytes: stat.size, dedup: true }
      } catch {
        throw err
      }
    }
    return { sha256, sizeBytes: buffer.length, dedup: false }
  }

  async readBuffer(sha256: string): Promise<Buffer> {
    return fs.readFile(this.blobPath(sha256))
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      await fs.access(this.blobPath(sha256))
      return true
    } catch {
      return false
    }
  }
}

// ─────────────────────────────── registry ───────────────────────────────────
// «A vs B» is two registry entries. local_cas is always wired; configured
// remote (S3-compatible) stores merge in from the deployment config registry
// (plan §6.1, §8.1, §7#4). Adding one is a registry entry + a ContentStore
// impl, NOT a new dispatch branch.
const LOCAL_CAS = new LocalCasStore()
const STORES = new Map<BackendId, ContentStore>([["local_cas", LOCAL_CAS]])
// Merge configured remote backends (empty in a local-only deployment). Throws
// fail-closed on malformed CONTENT_STORAGE_BACKENDS — a bad storage config must
// surface at boot, not corrupt byte routing later. local_cas wins on collision
// (it is reserved; the loader already rejects a remote def using its id).
for (const [id, store] of loadBackendRegistry()) {
  if (!STORES.has(id)) STORES.set(id, store)
}
// The configured default write backend (plan §6.1).
const WRITE_DEFAULT: BackendId = loadWriteDefault()
// Fail-closed AT BOOT: a mis-set CONTENT_STORAGE_WRITE_DEFAULT (typo / unwired id)
// must surface now, not silently at the first write. Mirrors the registry's
// "a bad storage config surfaces at boot" intent above.
if (!STORES.has(WRITE_DEFAULT)) {
  throw new Error(
    `content-store: CONTENT_STORAGE_WRITE_DEFAULT "${WRITE_DEFAULT}" is not a wired backend`
  )
}

/**
 * The registered REMOTE backends (the registry MINUS local_cas). Empty in a
 * local-only deployment. The durable GC sweep (plan §10) iterates these to
 * enumerate + reap unreachable objects per backend; nothing else should need it.
 */
export function listBackends(): [BackendId, ContentStore][] {
  return Array.from(STORES.entries()).filter(([id]) => id !== "local_cas")
}

/**
 * True iff at least one REMOTE backend is wired (registry size > 1; local_cas is
 * always present). Computed ONCE after the registry is built so the default
 * local-only hot read path can skip the per-read getBlobBackend SELECT entirely
 * (restores the pre-cutover zero-DB read). A deployment with a remote backend
 * keeps the full dispatch-on-recorded-backend path.
 */
const HAS_REMOTE = STORES.size > 1

/** Resolve the store for a blob's recorded backend (read path). */
export function resolveStore(backend: BackendId): ContentStore {
  const store = STORES.get(backend)
  if (!store) {
    // Fail-closed: an unknown/not-yet-wired backend must not silently fall back
    // to local (that would mis-locate bytes). Remote stores register above.
    throw new Error(`content-store: backend "${backend}" is not wired`)
  }
  return store
}

/**
 * Pick the backend for a NEW blob (write path, plan §6.1). Pluggable policy;
 * defaults to local_cas. A real deployment overrides this from the config
 * registry (by workspace / origin / content-kind / size). Validated here is the
 * sole fail-closed write boundary now that the DB per-backend CHECK is gone.
 */
export function selectWriteBackend(_ctx: WriteRoutingContext): BackendId {
  // Simple default-for-now (plan §6.1): route every new blob to the configured
  // write-default (`CONTENT_STORAGE_WRITE_DEFAULT`, else local_cas). `_ctx` is
  // the routing hook for future per-workspace/origin/kind/size policy. NOTE: a
  // manifest sha must still pin to local_cas per plan §5/§9.2 — that pinning is
  // enforced at the manifest write call site (this default does not relax it).
  return WRITE_DEFAULT
}

/** The store a NEW blob is written to (write path). */
export function writeStore(ctx: WriteRoutingContext): ContentStore {
  return resolveStore(selectWriteBackend(ctx))
}

// ─────────────────────── module-level caller surface ────────────────────────
// What the rest of the app uses — never a raw store/fs. One read path, one
// write path.

/** Store bytes via the routed backend; returns sha + the chosen backend. */
export async function writeContentBlob(
  buffer: Buffer,
  ctx: WriteRoutingContext = {}
): Promise<{
  sha256: string
  sizeBytes: number
  dedup: boolean
  backend: BackendId
}> {
  const store = writeStore(ctx)
  const res = await store.putBuffer(buffer)
  return { ...res, backend: store.backend }
}

/**
 * Read a blob's bytes by sha, dispatching on its recorded backend. Throws if the
 * blob is missing OR the backend errors. Callers that must distinguish those use
 * a try/catch (e.g. GC manifest expansion, content-access auth).
 */
export async function readContentBuffer(sha256: string): Promise<Buffer> {
  // Local-only fast path: with no remote backend wired, every blob is in
  // local_cas, so skip the getBlobBackend SELECT and read directly (restores the
  // pre-cutover zero-DB hot read). Byte-identical to the dispatched path below
  // because resolveStore("local_cas") IS LOCAL_CAS.
  if (!HAS_REMOTE) return LOCAL_CAS.readBuffer(sha256)
  const backend = await getBlobBackend(sha256)
  return resolveStore(backend).readBuffer(sha256)
}

/** Read a blob as base64 (dispatched). Throws on missing/backend error. */
export async function readContentBase64(sha256: string): Promise<string> {
  return (await readContentBuffer(sha256)).toString("base64")
}

/**
 * Soft read: returns null instead of throwing (preserves the old
 * readContentBufferBySha semantics used by the /content route).
 */
export async function readContentBufferBySha(
  sha256: string
): Promise<Buffer | null> {
  try {
    return await readContentBuffer(sha256)
  } catch {
    // Missing blob OR backend error → null (preserves the old /content soft-read).
    return null
  }
}

/** True if the blob's bytes are present in its recorded backend. */
export async function contentBlobExists(sha256: string): Promise<boolean> {
  const backend = await getBlobBackend(sha256)
  return resolveStore(backend).exists(sha256)
}
