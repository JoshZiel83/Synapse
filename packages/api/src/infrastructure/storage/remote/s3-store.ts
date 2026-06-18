// Remote S3-compatible ContentStore (plan §6/§8.1/§9.3).
//
// One implementation for the whole S3-compatible family: AWS S3, Cloudflare R2
// and MinIO (point `endpoint`/`forcePathStyle` at the target). It plugs into the
// same `STORES` registry as `local_cas` — there is NO parallel byte path; the
// read/write surface is uniformly `ContentStore`.
//
// Library note (plan §4.3): backed entirely by `@aws-sdk/client-s3`. The
// security-critical axis-B write PUT mint MUST use `@aws-sdk/s3-request-presigner`
// regardless — OpenDAL's presign cannot sign `x-amz-checksum-sha256` (plan §4.2#5,
// §9.3①) — so the AWS SDK is already a hard dependency, and backing get/put/list/
// delete/head with it too keeps one client. A future non-S3 family (GCS/Azure
// native) can add an OpenDAL-backed sibling store behind this same interface.
//
// key = `blobs/<aa>/<sha>` — bit-compatible with the Rust fs-helper / local CAS
// on-disk layout (plan §6.2); do NOT invent a different prefix.

import crypto from "node:crypto"
import { Readable } from "node:stream"
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import type { BackendId, ContentStore, PresignedReq } from "../content-store.js"

/** Construction options for an S3-compatible backend (from the config registry). */
export interface S3ContentStoreOptions {
  backend: BackendId
  bucket: string
  region: string
  /** Custom endpoint for R2 / MinIO / non-AWS S3. Omit for AWS S3. */
  endpoint?: string
  /** Path-style addressing (required by MinIO and some R2 setups). */
  forcePathStyle?: boolean
  /** Explicit credentials. Omit to use the default AWS provider chain (env/role). */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}

/** 64-char lowercase hex sha256 → base64 of the raw 32-byte digest (S3 wants the raw digest). */
function hexShaToBase64(sha256: string): string {
  return Buffer.from(sha256, "hex").toString("base64")
}

/** key = blobs/<aa>/<sha> — same layout as the Rust helper / local CAS (plan §6.2). */
function blobKey(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256}`
}

/** Bounded-concurrency map (no external dep). */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    }
  )
  await Promise.all(workers)
  return results
}

/** A 404/NotFound from S3 (HeadObject/GetObject on an absent key). */
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  )
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  // The AWS SDK Node body is a Readable; guard for the web-stream/blob shapes too.
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      )
    }
    return Buffer.concat(chunks)
  }
  const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> }
  if (typeof maybe?.transformToByteArray === "function") {
    return Buffer.from(await maybe.transformToByteArray())
  }
  throw new Error("s3-store: unexpected GetObject body type")
}

export class S3ContentStore implements ContentStore {
  readonly backend: BackendId
  readonly canPresign = true
  private readonly client: S3Client
  private readonly bucket: string

  constructor(opts: S3ContentStoreOptions) {
    this.backend = opts.backend
    this.bucket = opts.bucket
    const config: S3ClientConfig = {
      region: opts.region,
      // Non-AWS S3 (R2/MinIO) does not implement GetObject RESPONSE checksums; the
      // SDK default (responseChecksumValidation:"WHEN_SUPPORTED") forces
      // ChecksumMode=ENABLED on every GET and breaks R2/MinIO reads. WHEN_REQUIRED
      // validates only when we explicitly ask (we never do on reads). PUT INTEGRITY
      // is unaffected — putBuffer/presignPut always pass an explicit ChecksumSHA256,
      // which the SDK signs/verifies regardless (AWS data-integrity ref).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    }
    this.client = new S3Client(config)
  }

  async putBuffer(
    buffer: Buffer
  ): Promise<{ sha256: string; sizeBytes: number; dedup: boolean }> {
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex")
    const sizeBytes = buffer.length
    // HEAD-then-PUT dedup: content-addressed, so an existing key is identical bytes.
    if (await this.exists(sha256)) {
      return { sha256, sizeBytes, dedup: true }
    }
    // ChecksumSHA256 = base64(raw digest); S3 verifies the body server-side and
    // rejects a corrupt upload (plan §9.3). NOT the hex CAS key.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: blobKey(sha256),
        Body: buffer,
        ChecksumSHA256: hexShaToBase64(sha256),
      })
    )
    return { sha256, sizeBytes, dedup: false }
  }

  async readBuffer(sha256: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(sha256) })
    )
    return streamToBuffer(res.Body)
  }

  async getStream(sha256: string): Promise<NodeJS.ReadableStream> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(sha256) })
    )
    const body = res.Body
    if (body instanceof Readable) return body
    throw new Error(
      "s3-store: GetObject body is not a Node stream in this runtime"
    )
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: blobKey(sha256) })
      )
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async head(shas: string[]): Promise<Set<string>> {
    const present = new Set<string>()
    await mapLimit(shas, 16, async (sha) => {
      if (await this.exists(sha)) present.add(sha)
    })
    return present
  }

  async list(prefix: string): Promise<string[]> {
    // `prefix` is relative to the blob namespace (e.g. "" for all, "aa" for one
    // shard). The on-disk/key layout is blobs/<aa>/<sha>; the durable GC sweep
    // wants bare shas, so strip the blobs/<aa>/ key prefix.
    const keyPrefix = prefix ? `blobs/${prefix}` : "blobs/"
    const shas: string[] = []
    let continuationToken: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: keyPrefix,
          ContinuationToken: continuationToken,
        })
      )
      for (const obj of res.Contents ?? []) {
        const key = obj.Key
        if (!key) continue
        // blobs/aa/<sha> → <sha>
        const sha = key.slice(key.lastIndexOf("/") + 1)
        if (sha) shas.push(sha)
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined
    } while (continuationToken)
    return shas
  }

  async listWithMeta(
    prefix: string
  ): Promise<{ sha: string; lastModified?: Date }[]> {
    // Same enumeration as `list`, but carrying each object's S3 LastModified so
    // the durable sweep can apply the orphan-race grace to no-row objects.
    const keyPrefix = prefix ? `blobs/${prefix}` : "blobs/"
    const out: { sha: string; lastModified?: Date }[] = []
    let continuationToken: string | undefined
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: keyPrefix,
          ContinuationToken: continuationToken,
        })
      )
      for (const obj of res.Contents ?? []) {
        const key = obj.Key
        if (!key) continue
        const sha = key.slice(key.lastIndexOf("/") + 1)
        if (sha) out.push({ sha, lastModified: obj.LastModified })
      }
      continuationToken = res.IsTruncated
        ? res.NextContinuationToken
        : undefined
    } while (continuationToken)
    return out
  }

  async delete(sha256: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey(sha256) })
    )
  }

  async presignGet(sha256: string, ttlSec: number): Promise<PresignedReq> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: blobKey(sha256) }),
      { expiresIn: ttlSec }
    )
    return { method: "GET", url, headers: {} }
  }

  async presignPut(sha256: string, ttlSec: number): Promise<PresignedReq> {
    const checksum = hexShaToBase64(sha256)
    // CRITICAL (plan §9.3①, §13#3): the checksum header MUST be signed, not
    // hoisted into the query string. getSignedUrl hoists x-amz-* into the query
    // by default → S3 then rejects the PUT with "headers present in the request
    // which were not signed". `unhoistableHeaders` keeps it a signed header so
    // S3 verifies the body's sha256 at upload time and rejects a corrupt body.
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: blobKey(sha256),
        ChecksumSHA256: checksum,
      }),
      {
        expiresIn: ttlSec,
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      }
    )
    return {
      method: "PUT",
      url,
      headers: { "x-amz-checksum-sha256": checksum },
    }
  }
}
