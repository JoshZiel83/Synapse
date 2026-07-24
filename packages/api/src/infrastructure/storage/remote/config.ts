// Backend config registry (plan §6.2/§7#4): a deployment-config map
// `BackendId → ContentStore`, loaded from a JSON file (CONTENT_STORAGE_BACKENDS_FILE)
// or the inline env string (CONTENT_STORAGE_BACKENDS). NOT in the DB, NOT per-blob
// JSONB — bucket/region/endpoint/credentials live here; per blob the only
// stored fact is `content_blobs.backend` (the BackendId) + key = f(sha).
//
// Fail-closed: a malformed registry (or both sources set) throws on load (the
// write boundary in content-store.ts already rejects unknown BackendIds).

import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import { z } from "zod"
import type { BackendId, ContentStore } from "../content-store.js"
import { S3ContentStore } from "./s3-store.js"

// The `.describe()` text on each field flows into the generated JSON Schema
// (schemas/content-storage-backends.schema.json) and surfaces as editor hover
// docs. Keep it operator-facing and English.
//
// strictObject (not object) so a misspelled key like `forcePathSytle` fails
// loudly at load AND makes z.toJSONSchema emit `additionalProperties:false`, so
// the editor flags the typo instead of silently dropping it (a mistyped
// forcePathStyle would otherwise break MinIO addressing at request time).
const s3BackendDefSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .describe(
      "Stable backend id referenced by content_blobs.backend and CONTENT_STORAGE_WRITE_DEFAULT. Cannot be 'local_cas' (reserved)."
    ),
  kind: z
    .literal("s3")
    .describe(
      "Backend family. 's3' covers the S3-compatible family: AWS S3, Cloudflare R2, MinIO."
    ),
  bucket: z.string().min(1).describe("Bucket name."),
  region: z
    .string()
    .min(1)
    .describe("Region (e.g. 'us-east-1'; use 'auto' for Cloudflare R2)."),
  endpoint: z
    .string()
    .url()
    .optional()
    .describe(
      "Custom S3 endpoint URL for non-AWS providers (R2, MinIO). Omit for AWS S3."
    ),
  forcePathStyle: z
    .boolean()
    .optional()
    .describe(
      "Use path-style addressing (bucket in the URL path) instead of virtual-hosted style. Required by MinIO and some self-hosted gateways."
    ),
  accessKeyId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Inline access key. PREFER leaving credentials out of this file and supplying them via the per-backend env override CONTENT_STORAGE_CREDS_<ID> or the AWS provider chain. Do not commit production secrets."
    ),
  secretAccessKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Inline secret key. See accessKeyId — prefer CONTENT_STORAGE_CREDS_<ID> and never commit production secrets."
    ),
  sessionToken: z
    .string()
    .min(1)
    .optional()
    .describe("Optional inline STS session token, paired with inline creds."),
})

const backendDefSchema = z.discriminatedUnion("kind", [s3BackendDefSchema])

/**
 * The content-storage backend registry: an ordered list of remote backend
 * definitions. Today only the S3-compatible family (`kind:"s3"`) is
 * implemented; the discriminated union leaves room to add `kind:"gcs"` /
 * `"azblob"` later behind the same ContentStore interface (plan §4.3).
 *
 * Exported so scripts/gen-config-schemas.mts can generate the JSON Schema and
 * validate the committed example against this same source of truth.
 */
export const backendsSchema = z.array(backendDefSchema)

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
 * Read the raw backend-registry document from its configured source, or
 * `undefined` when unconfigured (the default local-only deployment).
 *
 * Two mutually-exclusive sources, so operators can pick file-based config
 * (editor autocomplete + validation via schemas/content-storage-backends.schema.json)
 * or the legacy inline env string, but never silently blend the two:
 *   - `CONTENT_STORAGE_BACKENDS_FILE` — path to a JSON file (absolute, or
 *     resolved against process.cwd()). The recommended source.
 *   - `CONTENT_STORAGE_BACKENDS` — the JSON document inline as an env string
 *     (12-factor / container friendly; unchanged legacy behavior).
 * Setting both is a fail-closed error rather than an ambiguous precedence.
 */
function readBackendsDocument(): unknown | undefined {
  const filePath = process.env.CONTENT_STORAGE_BACKENDS_FILE?.trim()
  const inline = process.env.CONTENT_STORAGE_BACKENDS
  const hasInline = !!inline && inline.trim() !== ""

  if (filePath && hasInline) {
    throw new Error(
      "content-storage: set only ONE of CONTENT_STORAGE_BACKENDS_FILE or CONTENT_STORAGE_BACKENDS, not both"
    )
  }

  if (filePath) {
    const abs = isAbsolute(filePath)
      ? filePath
      : resolve(process.cwd(), filePath)
    let text: string
    try {
      text = readFileSync(abs, "utf8")
    } catch (err) {
      throw new Error(
        `content-storage: cannot read CONTENT_STORAGE_BACKENDS_FILE at ${abs}: ${(err as Error).message}`
      )
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(
        `content-storage: ${abs} is not valid JSON: ${(err as Error).message}`
      )
    }
  }

  if (hasInline) {
    try {
      return JSON.parse(inline as string)
    } catch (err) {
      throw new Error(
        `content-storage: CONTENT_STORAGE_BACKENDS is not valid JSON: ${(err as Error).message}`
      )
    }
  }

  return undefined
}

/**
 * Build the registry of CONFIGURED REMOTE backends. Does NOT include local_cas
 * (content-store.ts always registers that). Returns an empty map when neither
 * source is set — the default single-implementation (local-only) deployment.
 * Throws (fail-closed) on malformed config. Sources: see readBackendsDocument.
 */
export function loadBackendRegistry(): Map<BackendId, ContentStore> {
  const stores = new Map<BackendId, ContentStore>()
  const json = readBackendsDocument()
  if (json === undefined) return stores

  const parsed = backendsSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(
      `content-storage: malformed backend registry (CONTENT_STORAGE_BACKENDS[_FILE]): ${parsed.error.message}`
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
