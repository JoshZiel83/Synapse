// Supervisor-side presigned-URL minting (plan §9.3 / §8.3, axis B).
//
// TOCTOU-free property (plan §9.3): a URL is ONLY minted for a sha the
// SUPERVISOR itself passed in — i.e. a sha it computed from a manifest it read
// or from a scan's new_blobs. The host NEVER supplies the sha list; if it could,
// it could mint a capability for any object in the bucket. Callers MUST pass the
// supervisor-computed shas (cas-hydration's hydrate/push drive these).
//
// Minting is a no-op for the local-only default: a local_cas store has no
// presignGet/presignPut, so `mintGetUrls`/`mintPutUrls` are never reached on
// that path (the presigned branch only runs for a remote host, plan §8.3).

import type {
  ContentStore,
  PresignedReq,
} from "../../infrastructure/storage/content-store.js"

/** Bounded-concurrency parallelism for presign fan-out (plan §13#6). */
const CONCURRENCY = 16

/** Default presigned-URL TTL: short-lived, single-object (plan §9.3). */
const DEFAULT_TTL_SEC = 900

/** Run `fn` over `items` with at most `limit` concurrent in flight. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i])
      }
    }
  )
  await Promise.all(workers)
}

/**
 * Mint a presigned GET for EACH supervisor-supplied sha (plan §9.3 read side).
 * The shas MUST be supervisor-computed (manifest file shas / scan new_blobs) —
 * this is the TOCTOU-free property: only shas the supervisor itself derived get
 * a capability. Throws if the store cannot presign (a remote host can only
 * stream via presign, so an un-presignable backend is a misconfiguration, not a
 * silent skip). De-dupes the input.
 */
export async function mintGetUrls(
  store: ContentStore,
  shas: string[],
  ttlSec: number = DEFAULT_TTL_SEC
): Promise<Map<string, PresignedReq>> {
  const out = new Map<string, PresignedReq>()
  if (shas.length === 0) return out
  if (!store.presignGet) {
    throw new Error(
      `presign: backend "${store.backend}" cannot presign GET (no presignGet)`
    )
  }
  const presignGet = store.presignGet.bind(store)
  const unique = Array.from(new Set(shas))
  await mapLimit(unique, CONCURRENCY, async (sha) => {
    out.set(sha, await presignGet(sha, ttlSec))
  })
  return out
}

/**
 * Mint a presigned PUT for EACH supervisor-supplied sha (plan §9.3 write side).
 * Same TOCTOU-free contract as `mintGetUrls`: only supervisor-computed shas get
 * a capability. The S3 presignPut signs `x-amz-checksum-sha256` so the object
 * store rejects a corrupt body at upload time (plan §9.3①). Throws if the store
 * cannot presign PUT. De-dupes the input.
 */
export async function mintPutUrls(
  store: ContentStore,
  shas: string[],
  ttlSec: number = DEFAULT_TTL_SEC
): Promise<Map<string, PresignedReq>> {
  const out = new Map<string, PresignedReq>()
  if (shas.length === 0) return out
  if (!store.presignPut) {
    throw new Error(
      `presign: backend "${store.backend}" cannot presign PUT (no presignPut)`
    )
  }
  const presignPut = store.presignPut.bind(store)
  const unique = Array.from(new Set(shas))
  await mapLimit(unique, CONCURRENCY, async (sha) => {
    out.set(sha, await presignPut(sha, ttlSec))
  })
  return out
}
