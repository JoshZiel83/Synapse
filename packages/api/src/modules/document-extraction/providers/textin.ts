// TextIn / 合合信息 (Intsig) xParse document-extraction provider — a cloud/API
// adapter (NOT a sidecar). The first cloud vendor proving the layer's cloud seam:
// it forces DUAL static-header auth (x-ti-app-id + x-ti-secret-code), synchronous
// submit, and MARKDOWN output — the three things a single-Bearer vendor would let
// us fake.
//
//   POST https://api.textin.com/ai/service/v1/pdf_to_markdown
//   headers: x-ti-app-id, x-ti-secret-code, Content-Type: application/octet-stream
//   body:    raw document bytes
//   ->       { "code": 200, "message": "success",
//              "result": { "markdown": "...", "total_page_number": N, ... } }
//
// This is a self-contained adapter (~1 vendor). When a 2nd/3rd cloud vendor lands,
// factor the shared never-reject + status classification into a rest factory then
// — not speculatively now (the DocumentExtractionProvider interface + registry ARE
// the extension seam; a new vendor is a new file + a registry case + config).
//
// Selecting textin sends document bytes OFF-BOX (egress) — the boot gate
// (config.superRefine) requires both credentials before this provider can be
// selected, so it never runs "configured" but keyless.

import { parseJsonObject } from "@synapse/shared"
import { config } from "../../../config/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import { isDocumentMimeType } from "../mime.js"
import { normalizeDocumentText } from "../normalize.js"
import { requireBytes } from "../types.js"
import type {
  DocumentExtractionProvider,
  DocumentProviderRequest,
  DocumentExtractionResult,
} from "../types.js"

const KEY = "textin"
const PARSER_KEY = "textin_xparse"
// Provenance/cache-key label. TextIn is a hosted service (no baked engine to
// lockstep with); bump this if a request-shape/version change alters output.
const ENGINE_VERSION = "textin-xparse-v1"

// TextIn app-envelope codes: 200 = success. These are the DOCUMENTED transient /
// retry-later codes — 30203 ("base service fault, retry later") + 500 ("server
// internal error"). Everything else non-200 (40xxx file/auth/param, the
// deterministic 50207 "partial page parse failure", unknown codes) is TERMINAL.
// The naive ">=50000" digit heuristic was WRONG: 30203 and 500 are transient yet
// < 50000, so a transient blip would have been cached as a permanent failure.
// Extend this set as TextIn documents more transient/rate-limit codes.
const TEXTIN_RETRYABLE_CODES: ReadonlySet<number> = new Set([30203, 500])

const log = createLogger("documents.textin")

function fail(
  partial: Partial<DocumentExtractionResult>
): DocumentExtractionResult {
  return {
    ok: false,
    text: "",
    textFormat: "markdown",
    provider: KEY,
    engineVersion: ENGINE_VERSION,
    ...partial,
  }
}

/** Pull the markdown text out of TextIn's `result` object, defensively. */
function selectMarkdown(result: Record<string, unknown>): string {
  const md = result.markdown ?? result.md
  return typeof md === "string" ? md : ""
}

function selectPageCount(result: Record<string, unknown>): number | undefined {
  const raw = result.total_page_number ?? result.page_count ?? result.total_page
  const n = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

async function extract(
  req: DocumentProviderRequest
): Promise<DocumentExtractionResult> {
  const bytes = requireBytes(req)
  if (!bytes) {
    return fail({
      error: "TextIn requires inline bytes transport",
      retryable: false,
    })
  }
  const { appId, secretCode, baseUrl, timeoutMs } =
    config.documentExtraction.textin
  if (!appId || !secretCode) {
    return fail({
      error: "TextIn credentials are not configured",
      retryable: false,
    })
  }

  let endpoint: string
  try {
    endpoint = new URL(
      "ai/service/v1/pdf_to_markdown",
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
    ).toString()
  } catch {
    return fail({
      error: `invalid TextIn base URL: ${baseUrl}`,
      retryable: false,
    })
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-ti-app-id": appId,
        "x-ti-secret-code": secretCode,
        "content-type": "application/octet-stream",
      },
      // Copy into a standalone ArrayBuffer so a pooled/oversized backing buffer
      // isn't sent whole.
      body: bytes.slice(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "TextIn request failed")
    return fail({ error: `TextIn request failed: ${message}`, retryable: true })
  }

  // HTTP-transport-level failures: 429 + 5xx transient; other 4xx terminal.
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500
    return fail({
      error: `TextIn returned HTTP ${response.status}`,
      retryable,
    })
  }

  // Read the body inside a guard so a mid-stream body-read error (truncated /
  // aborted 200) is coerced to a retryable failure HERE — honouring the
  // never-reject contract in the adapter itself (like sidecar.ts), not just via the
  // facade backstop that would log a scary "provider threw (contract violation)".
  let bodyText: string
  try {
    bodyText = await response.text()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err }, "TextIn response body read failed")
    return fail({
      error: `TextIn response read failed: ${message}`,
      retryable: true,
    })
  }

  const data = parseJsonObject(bodyText)
  const appCode = typeof data.code === "number" ? data.code : undefined
  // TextIn's application envelope: code 200 = success. Classify non-200 by the
  // DOCUMENTED transient-code set (30203 / 500); everything else (file/auth/param
  // 40xxx, deterministic partial-parse 50207, unknown) is terminal — a malformed
  // or deterministic outcome is not something a retry fixes.
  if (appCode !== 200) {
    const retryable =
      typeof appCode === "number" && TEXTIN_RETRYABLE_CODES.has(appCode)
    return fail({
      error: `TextIn error code ${appCode ?? "unknown"}: ${
        typeof data.message === "string" ? data.message : "no message"
      }`,
      retryable,
    })
  }

  const result =
    data.result && typeof data.result === "object"
      ? (data.result as Record<string, unknown>)
      : {}
  const text = normalizeDocumentText(selectMarkdown(result))
  const pageCount = selectPageCount(result)
  const structuredJson: Record<string, unknown> = { schemaVersion: 1 }
  if (pageCount !== undefined) structuredJson.pageCount = pageCount

  // SUCCESS — including empty markdown (ok:true), consistent with the layer's
  // empty-extract-is-success rule.
  return {
    ok: true,
    text,
    textFormat: "markdown",
    structuredJson,
    provider: KEY,
    engineVersion: ENGINE_VERSION,
    model: "xparse",
  }
}

export const textinDocumentProvider: DocumentExtractionProvider = {
  key: KEY,
  parserKey: PARSER_KEY,
  engineVersion: ENGINE_VERSION,
  // TextIn documents a 500 MB limit; the layer's real cap is the 25 MB upload.
  capabilities: { acceptsUrl: false, maxInlineBytes: 500 * 1024 * 1024 },
  // TextIn handles the widest format list; in THIS architecture images route to
  // modules/ocr, so it claims exactly the document set the layer owns.
  supports: (mimeType) => isDocumentMimeType(mimeType),
  isConfigured: () =>
    Boolean(
      config.documentExtraction.textin.appId &&
      config.documentExtraction.textin.secretCode
    ),
  extract,
}
