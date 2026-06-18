// Backend config registry (plan §6.2/§7#4): a deployment-config map
// `BackendId → ContentStore`, loaded from env. NOT in the DB, NOT per-blob
// JSONB — bucket/region/endpoint/credentials live here; per blob the only
// stored fact is `content_blobs.backend` (the BackendId) + key = f(sha).
//
// Fail-closed: malformed `CONTENT_STORAGE_BACKENDS` throws on load (the write
// boundary in content-store.ts already rejects unknown BackendIds).

import { z } from "zod"
import type { BackendId, ContentStore } from "../content-store.js"
import { S3ContentStore } from "./s3-store.js"

/**
 * One backend definition. Today only the S3-compatible family (`kind:"s3"`,
 * covering AWS S3 / Cloudflare R2 / MinIO) is implemented; the discriminated
 * union leaves room to add `kind:"gcs"`/`"azblob"` later behind the same
 * ContentStore interface (plan §4.3).
 */
const s3BackendDefSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("s3"),
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().url().optional(),
  forcePathStyle: z.boolean().optional(),
  /**
   * Optional inline credentials. PREFER leaving these unset and supplying
   * credentials via the standard AWS provider chain (env / instance role) or
   * the per-backend env override below; inline secrets in CONTENT_STORAGE_BACKENDS
   * are accepted for self-hosted/test setups but should not carry prod secrets.
   */
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  sessionToken: z.string().min(1).optional(),
})

const backendDefSchema = z.discriminatedUnion("kind", [s3BackendDefSchema])

const backendsSchema = z.array(backendDefSchema)

export type BackendDef = z.infer<typeof backendDefSchema>

/** local_cas is implicit (always present); reject it as a remote def to avoid shadowing. */
const RESERVED_LOCAL_ID = "local_cas"

/**
 * Per-backend credential env override: `CONTENT_STORAGE_CREDS_<ID>` (uppercased,
 * non-alphanumerics → `_`) = JSON `{accessKeyId,secretAccessKey,sessionToken?}`.
 * Lets credentials stay out of CONTENT_STORAGE_BACKENDS / secret-manager driven.
 */
function envCredsFor(
  id: string
):
  | { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | undefined {
  const key = `CONTENT_STORAGE_CREDS_${id.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`
  const raw = process.env[key]
  if (!raw) return undefined
  const parsed = z
    .object({
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
    })
    .safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(
      `content-storage: malformed ${key} (expected JSON {accessKeyId,secretAccessKey,sessionToken?}): ${parsed.error.message}`
    )
  }
  return parsed.data
}

function buildStore(def: BackendDef): ContentStore {
  switch (def.kind) {
    case "s3": {
      const inlineCreds =
        def.accessKeyId && def.secretAccessKey
          ? {
              accessKeyId: def.accessKeyId,
              secretAccessKey: def.secretAccessKey,
              sessionToken: def.sessionToken,
            }
          : undefined
      return new S3ContentStore({
        backend: def.id as BackendId,
        bucket: def.bucket,
        region: def.region,
        endpoint: def.endpoint,
        forcePathStyle: def.forcePathStyle,
        // Per-backend env creds win over inline; otherwise the SDK default chain.
        credentials: envCredsFor(def.id) ?? inlineCreds,
      })
    }
    default: {
      // Exhaustive: adding a new `kind` to the union forces a case here.
      const _exhaustive: never = def.kind
      throw new Error(
        `content-storage: unsupported backend kind ${String(_exhaustive)}`
      )
    }
  }
}

/**
 * Build the registry of CONFIGURED REMOTE backends from env. Does NOT include
 * local_cas (content-store.ts always registers that). Returns an empty map when
 * `CONTENT_STORAGE_BACKENDS` is unset — the default single-implementation
 * (local-only) deployment. Throws (fail-closed) on malformed config.
 */
export function loadBackendRegistry(): Map<BackendId, ContentStore> {
  const raw = process.env.CONTENT_STORAGE_BACKENDS
  const stores = new Map<BackendId, ContentStore>()
  if (!raw || raw.trim() === "") return stores

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `content-storage: CONTENT_STORAGE_BACKENDS is not valid JSON: ${(err as Error).message}`
    )
  }
  const parsed = backendsSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `content-storage: malformed CONTENT_STORAGE_BACKENDS: ${parsed.error.message}`
    )
  }

  for (const def of parsed.data) {
    if (def.id === RESERVED_LOCAL_ID) {
      throw new Error(
        `content-storage: backend id "${RESERVED_LOCAL_ID}" is reserved for the local store`
      )
    }
    if (stores.has(def.id as BackendId)) {
      throw new Error(`content-storage: duplicate backend id "${def.id}"`)
    }
    stores.set(def.id as BackendId, buildStore(def))
  }
  return stores
}

/**
 * The default write backend (plan §6.1). `CONTENT_STORAGE_WRITE_DEFAULT` selects
 * which configured backend new blobs route to; defaults to local_cas. The
 * content-store registry validates that this id is actually wired (fail-closed)
 * before any write uses it.
 */
export function loadWriteDefault(): BackendId {
  const raw = process.env.CONTENT_STORAGE_WRITE_DEFAULT?.trim()
  return (raw && raw.length > 0 ? raw : RESERVED_LOCAL_ID) as BackendId
}
