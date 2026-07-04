// LlamaParse (LlamaCloud) document-extraction provider — the ASYNC reference
// vendor. It exercises the submit-and-release machinery (submit → poll → result)
// and single-Bearer auth, complementing TextIn's synchronous dual-header path.
//
//   submit: POST {base}/api/v1/parsing/upload  (multipart "file", Bearer)  -> { id, status }
//   poll:   GET  {base}/api/v1/parsing/job/{id}                            -> { status }
//   result: GET  {base}/api/v1/parsing/job/{id}/result/markdown           -> { markdown }
//
// Async flow (parse-service): submit() persists `id` to file_parse_runs.metadata and
// returns immediately; a separate poll job calls poll(id) on an interval and only
// completes the run on a terminal status — the worker slot is never held, re-runs
// poll the SAME job (no double-submit / double-bill), and an api restart resumes
// from the persisted token. Selecting llamaparse sends document bytes off-box; the
// boot gate requires the API key.

import { parseJsonObject } from "@synapse/shared"
import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { isDocumentMimeType } from "../mime.js"
import { normalizeDocumentText } from "../normalize.js"
import { requireBytes } from "../types.js"
import type {
  DocumentExtractionProvider,
  DocumentExtractionResult,
  DocumentPollResult,
  DocumentProviderRequest,
  DocumentSubmitResult,
} from "../types.js"

const KEY = "llamaparse"
const PARSER_KEY = "llamaparse"
const ENGINE_VERSION = "llamaparse-v1"

const log = createLogger("documents.llamaparse")

function cfg() {
  return config.documentExtraction.llamaparse
}

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${cfg().apiKey}` }
}

function apiUrl(path: string): string {
  const base = cfg().baseUrl
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString()
}

/** 429 + 5xx = transient; other non-2xx = terminal. */
function httpRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

async function submit(
  req: DocumentProviderRequest
): Promise<DocumentSubmitResult> {
  const base = (
    partial: Partial<DocumentSubmitResult>
  ): DocumentSubmitResult => ({
    ok: false,
    provider: KEY,
    engineVersion: ENGINE_VERSION,
    ...partial,
  })

  const bytes = requireBytes(req)
  if (!bytes) {
    return base({
      error: "LlamaParse requires inline bytes transport",
      retryable: false,
    })
  }
  if (!cfg().apiKey) {
    return base({
      error: "LlamaParse API key is not configured",
      retryable: false,
    })
  }

  try {
    const form = new FormData()
    form.append(
      "file",
      new Blob([bytes.slice()], { type: req.mimeType }),
      req.filename || "document"
    )
    const response = await fetch(apiUrl("api/v1/parsing/upload"), {
      method: "POST",
      // No explicit content-type: FormData sets the multipart boundary itself.
      headers: authHeader(),
      body: form,
      signal: AbortSignal.timeout(cfg().timeoutMs),
    })
    if (!response.ok) {
      return base({
        error: `LlamaParse upload returned HTTP ${response.status}`,
        retryable: httpRetryable(response.status),
      })
    }
    const data = parseJsonObject(await response.text())
    const jobToken = typeof data.id === "string" ? data.id : ""
    if (!jobToken) {
      return base({
        error: "LlamaParse upload returned no job id",
        retryable: false,
      })
    }
    return { ok: true, jobToken, provider: KEY, engineVersion: ENGINE_VERSION }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "LlamaParse submit failed")
    return base({
      error: `LlamaParse submit failed: ${message}`,
      retryable: true,
    })
  }
}

async function poll(jobToken: string): Promise<DocumentPollResult> {
  // A poll is a quick status/result GET — cap it well under the (upload) timeout so
  // a slow/hung poll can't hold a shared file-parse worker slot; a timeout just
  // re-polls on the next tick.
  const pollTimeoutMs = Math.min(cfg().timeoutMs, 15000)
  const done = (
    partial: Partial<DocumentExtractionResult>
  ): DocumentPollResult => ({
    status: "done",
    ok: false,
    text: "",
    textFormat: "markdown",
    provider: KEY,
    engineVersion: ENGINE_VERSION,
    ...partial,
  })

  let status: string
  try {
    const response = await fetch(apiUrl(`api/v1/parsing/job/${jobToken}`), {
      headers: authHeader(),
      signal: AbortSignal.timeout(pollTimeoutMs),
    })
    if (!response.ok) {
      // A transient status-check failure → keep polling (the scheduler's deadline
      // bounds it); a 4xx (e.g. job not found) → terminal.
      if (httpRetryable(response.status)) return { status: "pending" }
      return done({
        error: `LlamaParse job status HTTP ${response.status}`,
        retryable: false,
      })
    }
    const data = parseJsonObject(await response.text())
    status = typeof data.status === "string" ? data.status.toUpperCase() : ""
  } catch (err) {
    log.warn({ err }, "LlamaParse poll failed (transient, will re-poll)")
    return { status: "pending" }
  }

  if (status === "PENDING" || status === "PROCESSING") {
    return { status: "pending" }
  }
  if (status === "ERROR" || status === "CANCELLED") {
    return done({
      error: `LlamaParse job ${status.toLowerCase()}`,
      retryable: false,
    })
  }
  if (status !== "SUCCESS" && status !== "PARTIAL_SUCCESS") {
    // Unknown terminal-ish state — don't spin forever.
    return done({
      error: `LlamaParse job unexpected status "${status}"`,
      retryable: false,
    })
  }

  // Terminal success — fetch the markdown result.
  try {
    const response = await fetch(
      apiUrl(`api/v1/parsing/job/${jobToken}/result/markdown`),
      { headers: authHeader(), signal: AbortSignal.timeout(pollTimeoutMs) }
    )
    if (!response.ok) {
      if (httpRetryable(response.status)) return { status: "pending" }
      return done({
        error: `LlamaParse result HTTP ${response.status}`,
        retryable: false,
      })
    }
    const data = parseJsonObject(await response.text())
    const md = typeof data.markdown === "string" ? data.markdown : ""
    return {
      status: "done",
      ok: true,
      text: normalizeDocumentText(md),
      textFormat: "markdown",
      structuredJson: { schemaVersion: 1 },
      provider: KEY,
      engineVersion: ENGINE_VERSION,
      model: "llamaparse",
    }
  } catch (err) {
    log.warn(
      { err },
      "LlamaParse result fetch failed (transient, will re-poll)"
    )
    return { status: "pending" }
  }
}

async function extractNotSupported(): Promise<DocumentExtractionResult> {
  // llamaparse is async — the facade routes it through submit()/poll(), never
  // extract(). Present a never-reject stub so the interface stays uniform.
  return {
    ok: false,
    text: "",
    textFormat: "markdown",
    provider: KEY,
    engineVersion: ENGINE_VERSION,
    error: "llamaparse is an async provider; use submit()/poll()",
    retryable: false,
  }
}

export const llamaparseDocumentProvider: DocumentExtractionProvider = {
  key: KEY,
  parserKey: PARSER_KEY,
  engineVersion: ENGINE_VERSION,
  isAsync: true,
  // Uploads bytes via multipart (LlamaParse ~300 MB limit); no URL input here.
  capabilities: { acceptsUrl: false, maxInlineBytes: 300 * 1024 * 1024 },
  supports: (mimeType) => isDocumentMimeType(mimeType),
  isConfigured: () => Boolean(cfg().apiKey),
  extract: extractNotSupported,
  submit,
  poll,
}
