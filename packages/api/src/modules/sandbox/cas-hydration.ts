// Supervisor-side CAS cache hydration / write-back (plan §6.2/§9/§10).
//
// The model: the local `--cas-dir` (CONTENT_STORE_DIR) is a READ-THROUGH /
// WRITE-BACK CACHE; a blob's durable home is per-blob `content_blobs.backend`.
// The Rust fs-helper only ever touches the local cache and is UNCHANGED. This
// module is the TS supervisor's two seams around the helper:
//
//   ensureBlobsLocal(shas)        — BEFORE materialize: fill the local cache
//                                   from each blob's durable backend so the
//                                   helper can reflink (axis A, same-host).
//   pushNewBlobsToDurable(shas,…) — AFTER scan/commit: push each NEW local
//                                   blob to its routed durable backend and
//                                   record the content_blobs row.
//
// All byte IO funnels through the ContentStore registry (content-store.ts) —
// there is NO raw fs CAS access here (guard-content-store.mjs enforces it).
//
// DEFAULT (local-only) BEHAVIOR IS BYTE-IDENTICAL TO TODAY: when a blob is
// already in the local cache, ensureBlobsLocal is a no-op; and when the routed
// backend is `local_cas` (the default), pushNewBlobsToDurable just records the
// local_cas row exactly as the old inline commit path did.

import {
  resolveStore,
  selectWriteBackend,
  type BackendId,
  type WriteRoutingContext,
} from "../../infrastructure/storage/content-store.js"
import {
  getBlobBackend,
  ensureContentBlob,
} from "../../infrastructure/storage/repo.js"
import { mintGetUrls, mintPutUrls } from "./presign.js"
import { defaultDbh, type Executor } from "./repo.js"

/**
 * The slice of the device-runtime fs-helper (one-shot OR long-lived) that the
 * axis-B presigned transfer needs. Kept STRUCTURAL so this module does not pull
 * the concrete OneShotFsHelper/FsHelperClient type across the package boundary —
 * any object with these two methods (the supervisor's one-shot helper) works.
 * The helper holds NO credentials; it only fetches/sends the supervisor-minted
 * URL into/out of its local --cas-dir (plan §8.4, §9.3).
 */
export interface PresignedTransferHelper {
  casImportUrl(input: {
    sha256: string
    url: string
    expected_size?: number
  }): Promise<{ sha256: string; size: number; dedup: boolean }>
  casExportUrl(input: {
    sha256: string
    put_url: string
    headers?: [string, string][]
  }): Promise<{ size: number; etag?: string }>
}

/** Bounded-concurrency parallelism for hydrate/push fan-out (plan §13#6). */
const CONCURRENCY = 8

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
 * The single local CAS store (read/write the cache + read a blob's size). It is
 * just the registry's `local_cas` entry — NOT a second byte path.
 */
function localStore() {
  return resolveStore("local_cas")
}

/**
 * Fill the LOCAL cache with every blob in `shas` that is durably homed on a
 * remote backend, so the unchanged helper can reflink it into the live tree
 * (plan §9.2 materialize step). Per blob:
 *   - already in the local cache → skip (no-op; the byte-identical local path);
 *   - backend === 'local_cas' and NOT local → genuinely missing: do nothing and
 *     let `manifestMaterialize` fail exactly as it does today;
 *   - backend !== 'local_cas' → read the bytes from that backend and write them
 *     into the local cache (content-addressed; assert the sha round-trips).
 *
 * Bounded parallelism (plan §13#6). Idempotent.
 */
export async function ensureBlobsLocal(shas: string[]): Promise<void> {
  if (shas.length === 0) return
  const local = localStore()
  // De-dupe (a manifest may list the same blob under multiple paths).
  const unique = Array.from(new Set(shas))
  await mapLimit(unique, CONCURRENCY, async (sha) => {
    // Already cached locally → the helper can reflink it as-is. This is the
    // common case in a local-only deployment, so the whole pass is a no-op.
    if (await local.exists(sha)) return

    const backend = await getBlobBackend(sha)
    if (backend === "local_cas") {
      // Durable home is the local cache itself but the bytes are absent →
      // genuinely missing. Don't fabricate; let materialize fail as it does
      // today (its NotFound surfaces the same way).
      return
    }

    // Durable elsewhere → pull the bytes and write them into the local cache so
    // the helper reflinks from a real local file. putBuffer content-addresses,
    // so the returned sha MUST equal the one we read (else the remote bytes are
    // corrupt / mis-keyed and we must fail loudly, not silently cache wrong bytes).
    const bytes = await resolveStore(backend).readBuffer(sha)
    const { sha256: writtenSha } = await local.putBuffer(bytes)
    if (writtenSha !== sha) {
      throw new Error(
        `cas-hydration: hydrated blob sha mismatch (expected ${sha}, got ${writtenSha} from backend ${backend})`
      )
    }
  })
}

/**
 * Push each NEW local blob to its routed durable backend (plan §9.2 commit step).
 * MUST be called BEFORE the snapshot row is made durable (caller ordering) so a
 * referenced blob is never persisted before its bytes are durable.
 *
 * Per blob, `backend = selectWriteBackend(ctx)`:
 *   - backend === 'local_cas' (the default) → the bytes are ALREADY durable in
 *     the local cache and the CALLER records the content_blobs row inside its own
 *     commit transaction (today's exact path). The push is then a NO-OP — it does
 *     NOT touch the DB. This keeps the local-only default byte-identical to today
 *     and avoids a stray write outside the caller's transaction.
 *   - backend !== 'local_cas' → read the local bytes, PUT them to that backend,
 *     and only on a confirmed PUT record the row with `durableConfirmedAt = now`
 *     (the push OWNS durability confirmation for remote backends). Recorded on
 *     the caller's `dbh` so it joins the caller's connection/transaction; the
 *     remote row wins over the caller's local_cas `ON CONFLICT DO NOTHING`.
 *
 * Bounded parallelism (plan §13#6). A remote PUT failure throws → the row is NOT
 * written and the caller aborts the commit (the local blob is retained for a
 * later retry; plan §9.2/§13#4).
 */
export async function pushNewBlobsToDurable(
  shas: string[],
  ctx: WriteRoutingContext,
  dbh: Executor = defaultDbh()
): Promise<void> {
  if (shas.length === 0) return
  const backend = selectWriteBackend(ctx)
  // Default (local-only): nothing to push, nothing to record here — the caller's
  // in-txn ensureContentBlob is the recorder, exactly as today.
  if (backend === "local_cas") return

  const local = localStore()
  const unique = Array.from(new Set(shas))
  await mapLimit(unique, CONCURRENCY, async (sha) => {
    // Remote durable home: read the local bytes, PUT to the backend, then (only
    // on a confirmed PUT) record the row with durableConfirmedAt set.
    const bytes = await local.readBuffer(sha)
    const res = await resolveStore(backend).putBuffer(bytes)
    if (res.sha256 !== sha) {
      throw new Error(
        `cas-hydration: pushed blob sha mismatch (expected ${sha}, got ${res.sha256} for backend ${backend})`
      )
    }
    await ensureContentBlob(dbh, {
      sha256: sha,
      sizeBytes: res.sizeBytes,
      backend,
      durableConfirmedAt: new Date(),
    })
  })
}

// ─────────────────────────── axis B: presigned ──────────────────────────────
// Mirror of ensureBlobsLocal/pushNewBlobsToDurable for a REMOTE, untrusted host
// (plan §8.3 presigned). The supervisor mints short-lived, single-object URLs
// for ONLY the shas it computed (TOCTOU-free, plan §9.3) and the helper streams
// the bytes itself (it holds no credentials). These run instead of the axis-A
// supervisor copy when the host's BlobAccess is `presigned`.

/**
 * Axis-B hydrate: for each supervisor-supplied sha, mint a presigned GET against
 * `backend` and have the remote `helper` fetch it into its own --cas-dir (the
 * helper verifies the sha on write, plan §9.3②). The shas MUST be
 * supervisor-computed (manifest file shas) — mintGetUrls only mints for shas we
 * pass, never a host-supplied list (plan §9.3 TOCTOU-free).
 *
 * Bounded parallelism (plan §13#6). Idempotent (the helper dedups locally).
 */
export async function hydrateViaPresigned(
  shas: string[],
  backend: BackendId,
  helper: PresignedTransferHelper
): Promise<void> {
  if (shas.length === 0) return
  const store = resolveStore(backend)
  const urls = await mintGetUrls(store, Array.from(new Set(shas)))
  await mapLimit(Array.from(urls), CONCURRENCY, async ([sha, req]) => {
    await helper.casImportUrl({ sha256: sha, url: req.url })
  })
}

/**
 * Axis-B push: for each supervisor-supplied new-blob sha, mint a presigned PUT
 * against `backend` (S3 signs `x-amz-checksum-sha256` so a corrupt body is
 * rejected at upload, plan §9.3①) and have the remote `helper` send the bytes
 * from its --cas-dir. On a confirmed export, record the content_blobs row with
 * `durableConfirmedAt = now` (the push owns durability confirmation for remote
 * backends), using the size the helper reports from the export.
 *
 * MUST be called BEFORE the snapshot row is made durable (caller ordering) so a
 * referenced blob is never persisted before its bytes are durable. A failed
 * export throws → the row is NOT written and the caller aborts the commit (the
 * local blob is retained for a later retry; plan §9.2/§13#4).
 *
 * Bounded parallelism (plan §13#6).
 */
export async function pushViaPresigned(
  shas: string[],
  backend: BackendId,
  helper: PresignedTransferHelper,
  executor: Executor = defaultDbh()
): Promise<void> {
  if (shas.length === 0) return
  const store = resolveStore(backend)
  const urls = await mintPutUrls(store, Array.from(new Set(shas)))
  await mapLimit(Array.from(urls), CONCURRENCY, async ([sha, req]) => {
    const res = await helper.casExportUrl({
      sha256: sha,
      put_url: req.url,
      headers: Object.entries(req.headers),
    })
    // Size is authoritative from the export result (the helper read the local
    // blob); record the durable row only AFTER the PUT confirmed.
    await ensureContentBlob(executor, {
      sha256: sha,
      sizeBytes: res.size,
      backend,
      durableConfirmedAt: new Date(),
    })
  })
}
