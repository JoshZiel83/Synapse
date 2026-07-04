// Document-extraction facade — the functions the api core calls to extract text
// from a document (PDF + office + epub).
//
// Owns: the transport decision + size-gate, loading bytes from the
// content-addressed store, an LRU single-flight cache (SYNC path only), and the
// never-reject guarantee. Mirrors modules/ocr/index.ts, plus the async
// submit-and-release entry points for cloud vendors that are submit+poll.
//
// Cache policy (sync `extractDocument`): cache successes AND deterministic
// (non-retryable) failures for 1h; NEVER persist a transient (retryable) failure.
// The LRU is a per-process, 500-entry, 1h-TTL, restart-wiped request COALESCER —
// NOT cross-retry idempotency, NOT cross-instance dedup. The ASYNC path does not
// use it: its idempotency is durable (a vendor job token persisted to
// file_parse_runs.metadata, re-polled instead of re-submitted).

import { LRUCache } from "lru-cache"
import { createLogger } from "../../infrastructure/logger/index.js"
import { readContentBufferBySha } from "../files/service.js"
import { resolveDocumentExtractionProvider } from "./registry.js"
import type {
  DocumentExtractionProvider,
  DocumentExtractionResult,
  DocumentPollResult,
  DocumentProviderRequest,
  DocumentSubmitResult,
  ExtractDocumentInput,
} from "./types.js"

const log = createLogger("documents.facade")

const cache = new LRUCache<string, Promise<DocumentExtractionResult>>({
  max: 500,
  ttl: 60 * 60 * 1000, // 1h
})

type PreparedRequest =
  | { readonly req: DocumentProviderRequest }
  | { readonly error: string; readonly retryable: boolean }

/**
 * Resolve the transport for a request: the size-gate first (refuse an over-limit
 * inline blob BEFORE materializing it — the heap-blowup guard), then load bytes.
 * Only the `bytes` transport is produced today; a URL/object-ref transport would
 * be selected here for a presign-capable backend + a URL-accepting provider.
 */
async function prepareRequest(
  provider: DocumentExtractionProvider,
  input: ExtractDocumentInput
): Promise<PreparedRequest> {
  if (
    typeof input.sizeBytes === "number" &&
    input.sizeBytes > provider.capabilities.maxInlineBytes &&
    !provider.capabilities.acceptsUrl
  ) {
    // Deterministic: this blob is too big for this provider's inline transport and
    // no URL path is available → terminal (retrying won't shrink the file).
    return {
      error: `document is ${input.sizeBytes} bytes, over the ${provider.capabilities.maxInlineBytes}-byte inline limit for provider "${provider.key}"`,
      retryable: false,
    }
  }

  let bytes = input.bytes
  if (!bytes) {
    const buffer = await readContentBufferBySha(input.sha256)
    if (!buffer) {
      // Null = missing blob OR a transient backend error, indistinguishable →
      // retryable so it is never cached.
      return { error: "document content not found", retryable: true }
    }
    bytes = buffer
  }

  return {
    req: {
      sha256: input.sha256,
      mimeType: input.mimeType,
      filename: input.filename,
      transport: { mode: "bytes", bytes },
    },
  }
}

function failResult(
  provider: DocumentExtractionProvider,
  error: string,
  retryable: boolean
): DocumentExtractionResult {
  return {
    ok: false,
    text: "",
    textFormat: "plaintext",
    provider: provider.key,
    engineVersion: provider.engineVersion,
    error,
    retryable,
  }
}

async function runExtract(
  provider: DocumentExtractionProvider,
  input: ExtractDocumentInput
): Promise<DocumentExtractionResult> {
  const prepared = await prepareRequest(provider, input)
  if ("error" in prepared) {
    return failResult(provider, prepared.error, prepared.retryable)
  }
  try {
    return await provider.extract(prepared.req)
  } catch (err) {
    // Adapters must never reject; enforce it at the facade boundary too.
    log.error(
      { err, provider: provider.key },
      "document extraction provider threw (contract violation)"
    )
    return failResult(
      provider,
      err instanceof Error ? err.message : "document provider threw",
      true
    )
  }
}

/** Extract text from a document SYNCHRONOUSLY. Always resolves (never rejects). */
export async function extractDocument(
  input: ExtractDocumentInput
): Promise<DocumentExtractionResult> {
  const provider = resolveDocumentExtractionProvider()
  const cacheKey = `${provider.key}:${provider.engineVersion}:${input.sha256}`

  const cached = cache.get(cacheKey)
  if (cached) return cached

  const pending = runExtract(provider, input)
  cache.set(cacheKey, pending)

  const result = await pending
  // Evict transient failures so the next caller retries. Compare-and-delete: only
  // evict OUR entry, never a concurrent caller's freshly repopulated one.
  if (!result.ok && result.retryable && cache.get(cacheKey) === pending) {
    cache.delete(cacheKey)
  }
  return result
}

/**
 * Submit an ASYNC document job (submit-and-release). Always resolves. The caller
 * persists the returned `jobToken` to file_parse_runs.metadata and schedules a
 * poll job; a re-run polls the existing job instead of re-submitting.
 */
export async function submitDocument(
  input: ExtractDocumentInput
): Promise<DocumentSubmitResult> {
  const provider = resolveDocumentExtractionProvider()
  const base = (
    partial: Partial<DocumentSubmitResult>
  ): DocumentSubmitResult => ({
    ok: false,
    provider: provider.key,
    engineVersion: provider.engineVersion,
    ...partial,
  })
  if (!provider.isAsync || !provider.submit) {
    return base({
      error: `provider "${provider.key}" is not an async provider`,
      retryable: false,
    })
  }
  const prepared = await prepareRequest(provider, input)
  if ("error" in prepared) {
    return base({ error: prepared.error, retryable: prepared.retryable })
  }
  try {
    return await provider.submit(prepared.req)
  } catch (err) {
    log.error(
      { err, provider: provider.key },
      "document submit threw (contract violation)"
    )
    return base({
      error: err instanceof Error ? err.message : "document submit threw",
      retryable: true,
    })
  }
}

/** Poll a submitted async job by its token. Always resolves. Returns `pending`
 *  (re-poll) or a terminal `done` result. */
export async function pollDocument(
  provider: DocumentExtractionProvider,
  jobToken: string
): Promise<DocumentPollResult> {
  if (!provider.isAsync || !provider.poll) {
    return {
      status: "done",
      ...failResult(provider, `provider "${provider.key}" cannot poll`, false),
    }
  }
  try {
    return await provider.poll(jobToken)
  } catch (err) {
    // A thrown poll → treat as transient (re-poll); the scheduler's deadline bounds it.
    log.warn(
      { err, provider: provider.key },
      "document poll threw (treating as pending)"
    )
    return { status: "pending" }
  }
}

export { resolveDocumentExtractionProvider } from "./registry.js"
export { isDocumentMimeType, DOCUMENT_MIME_TYPES } from "./mime.js"
export type {
  DocumentExtractionProvider,
  DocumentExtractionResult,
  DocumentProviderRequest,
  DocumentPollResult,
  DocumentSubmitResult,
  ExtractDocumentInput,
} from "./types.js"
