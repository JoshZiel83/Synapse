import type {
  FileContentKind,
  FileParseOutputView,
  FileParseRunView,
} from "@synapse/shared/types"
import { fileParsingQueue } from "../../workers/queues.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { recognizeOcr, resolveOcrProvider } from "../ocr/index.js"
import {
  extractDocument,
  isDocumentMimeType,
  pollDocument,
  resolveDocumentExtractionProvider,
  submitDocument,
} from "../document-extraction/index.js"
import { config } from "../../config/index.js"
import { getFileDetail, getFileRecord, readFileBufferById } from "./service.js"
import {
  completeParseRun,
  findStrandedAsyncRunIds,
  getLatestParseRun,
  getParseRunById,
  getParseRunMetadata,
  insertPendingParseRun,
  listParseOutputRowsForRuns,
  markParseRunFailed,
  markParseRunFileNotFound,
  markParseRunStrategy,
  setParseRunMetadata,
} from "./repo-parse.js"
import {
  presentFileParseOutput,
  presentFileParseRun,
  type FileParseRunRow as ParseRunRow,
} from "./presenter.js"

const log = createLogger("file-parsing")

export const DEFAULT_FILE_PARSE_PIPELINE = "default_extract"
const UTF8_TEXT_PARSER_KEY = "utf8_text"
const UTF8_TEXT_PARSER_VERSION = "1"

/**
 * A parse failure that carries a transient/terminal classification. Only
 * transient failures (e.g. an OCR sidecar that is down/timed-out) are rethrown
 * so BullMQ retries; terminal failures (no text found, corrupt input) are
 * recorded and swallowed to avoid a pointless retry storm.
 */
class ParseError extends Error {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = "ParseError"
    this.retryable = retryable
  }
}

type FileParseJobData = {
  runId: string
  // "parse" (default) runs extraction; "poll" advances a submitted async job.
  kind?: "parse" | "poll"
}

type ParseStrategy =
  | {
      parserKey: string
      parserVersion: string
      mode: "text"
    }
  | {
      parserKey: string
      parserVersion: string
      mode: "document"
    }
  | {
      parserKey: string
      parserVersion: string
      mode: "image_ocr"
    }
  | {
      parserKey: string
      parserVersion: string | null
      mode: "skip"
      errorCode: string
      errorMessage: string
    }

// The ParseRunRow type + the row→View presenters live in ./presenter.ts
// (round-6 P1-7); the DB reads/writes now live in ./repo-parse.ts (round-6
// P1-6 guard r8). This file owns only the orchestration + pure glue.

function isTextLikeMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/typescript",
      "application/x-typescript",
      "application/xhtml+xml",
      "image/svg+xml",
    ].includes(mimeType)
  )
}

function resolveParseStrategy(params: {
  mimeType: string
  contentKind: FileContentKind
}): ParseStrategy {
  if (params.contentKind === "image") {
    // The api bundles no OCR engine; the active provider is selected by env.
    // When none is configured, image text extraction is a SKIP (like an
    // unsupported mime), not a failure — so a deployment without an OCR sidecar
    // doesn't turn every image upload into a permanent parse failure.
    const provider = resolveOcrProvider()
    if (!provider.isConfigured()) {
      return {
        parserKey: "ocr_skipped",
        parserVersion: null,
        mode: "skip",
        errorCode: "OCR_NOT_CONFIGURED",
        errorMessage:
          "No OCR provider is configured; image text extraction is skipped.",
      }
    }
    return {
      parserKey: provider.parserKey,
      parserVersion: provider.engineVersion,
      mode: "image_ocr",
    }
  }
  if (isTextLikeMimeType(params.mimeType)) {
    // Text-like MIME types (text/*, json, xml, svg, xhtml — includes text/html)
    // stay a raw utf8 read, decided BEFORE the document layer so HTML isn't routed
    // to a document engine. No document MIME type is text-like, so order is safe.
    return {
      parserKey: UTF8_TEXT_PARSER_KEY,
      parserVersion: UTF8_TEXT_PARSER_VERSION,
      mode: "text",
    }
  }
  if (isDocumentMimeType(params.mimeType)) {
    // The api bundles no document engine; the active provider is env-selected
    // (Apache Tika sidecar | TextIn cloud | none). When none is configured,
    // document extraction is a SKIP (like OCR), not a failure — a deploy without a
    // docextract provider doesn't turn every PDF/office upload into a permanent
    // parse failure. (A LOUD boot warning already fired — config Guardrail 1.)
    const provider = resolveDocumentExtractionProvider()
    if (!provider.isConfigured()) {
      return {
        parserKey: "doc_extraction_skipped",
        parserVersion: null,
        mode: "skip",
        errorCode: "DOC_EXTRACTION_NOT_CONFIGURED",
        errorMessage:
          "No document-extraction provider is configured; document text extraction is skipped.",
      }
    }
    if (!provider.supports(params.mimeType)) {
      return {
        parserKey: "unsupported_mime",
        parserVersion: null,
        mode: "skip",
        errorCode: "UNSUPPORTED_MIME",
        errorMessage: `The active document-extraction provider does not support MIME type ${params.mimeType}.`,
      }
    }
    return {
      parserKey: provider.parserKey,
      parserVersion: provider.engineVersion,
      mode: "document",
    }
  }
  return {
    parserKey: "unsupported_mime",
    parserVersion: null,
    mode: "skip",
    errorCode: "UNSUPPORTED_MIME",
    errorMessage: `No default parser is configured for MIME type ${params.mimeType}.`,
  }
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\u0000/g, "").trim()
}

function shouldAutoParseFile(params: {
  mimeType: string
  contentKind: FileContentKind
}): boolean {
  return resolveParseStrategy(params).mode !== "skip"
}

async function extractParsedText(params: {
  fileId: string
  mimeType: string
  contentKind: FileContentKind
}): Promise<{
  strategy: ParseStrategy
  text?: string
  structuredJson?: Record<string, unknown>
}> {
  const strategy = resolveParseStrategy(params)
  if (strategy.mode === "skip") {
    return { strategy }
  }

  const buffer = await readFileBufferById(params.fileId)
  if (!buffer) {
    throw new Error("File not found")
  }

  if (strategy.mode === "text") {
    return {
      strategy,
      text: normalizeExtractedText(buffer.toString("utf8")),
    }
  }

  if (strategy.mode === "document") {
    const record = await getFileRecord(params.fileId)
    if (!record) {
      throw new Error("Document asset not found for extraction")
    }
    const result = await extractDocument({
      sha256: record.sha256,
      mimeType: params.mimeType,
      bytes: buffer,
      filename: record.originalName,
      // Lets the facade size-gate fail an over-limit file before base64 + HTTP.
      sizeBytes: buffer.length,
    })
    if (!result.ok) {
      // ok:false is a genuine fault. retryable=true (sidecar down / 5xx / timeout)
      // → rethrow so BullMQ retries; retryable=false (encrypted / corrupt / 4xx)
      // → terminal, swallowed (no retry storm). An empty extraction is NOT a
      // fault — the provider returns ok:true with text:"" for a scanned/text-
      // layerless doc, which flows through the success path below and completes as
      // a succeeded run carrying its page metadata (parity with the old pdf path).
      throw new ParseError(
        result.error || "document extraction failed",
        result.retryable === true
      )
    }
    return {
      strategy,
      text: normalizeExtractedText(result.text),
      structuredJson: result.structuredJson,
    }
  }

  const ocrRecord = await getFileRecord(params.fileId)
  if (!ocrRecord) {
    throw new Error("Image asset not found for OCR")
  }
  const ocr = await recognizeOcr({
    sha256: ocrRecord.sha256,
    mimeType: params.mimeType,
    bytes: buffer,
  })
  if (!ocr.ok || !ocr.text) {
    throw new ParseError(
      ocr.error || "Image OCR did not return text",
      ocr.retryable === true
    )
  }
  return {
    strategy,
    text: normalizeExtractedText(ocr.text),
  }
}

async function listParseOutputsForRuns(
  runIds: string[]
): Promise<Map<string, FileParseOutputView[]>> {
  if (runIds.length === 0) {
    return new Map()
  }

  const rows = await listParseOutputRowsForRuns(runIds)

  const derivedFileIds = Array.from(
    new Set(
      rows
        .map((row) => row.derivedAssetId)
        .filter((value): value is string => typeof value === "string")
    )
  )
  const derivedFiles = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getFileDetail>>>
  >()
  await Promise.all(
    derivedFileIds.map(async (fileId) => {
      const detail = await getFileDetail(fileId)
      if (detail) {
        derivedFiles.set(fileId, detail)
      }
    })
  )

  const grouped = new Map<string, FileParseOutputView[]>()
  for (const row of rows) {
    if (!grouped.has(row.runId)) {
      grouped.set(row.runId, [])
    }
    grouped
      .get(row.runId)!
      .push(
        presentFileParseOutput(
          row,
          row.derivedAssetId ? derivedFiles.get(row.derivedAssetId) : undefined
        )
      )
  }

  return grouped
}

async function presentParseRun(row: ParseRunRow): Promise<FileParseRunView> {
  const outputsByRunId = await listParseOutputsForRuns([row.id])
  return presentFileParseRun(row, outputsByRunId.get(row.id) || [])
}

export async function enqueueFileParse(params: {
  fileId: string
  pipeline?: string
  trigger: string
}): Promise<string | null> {
  const record = await getFileRecord(params.fileId)
  if (!record) {
    return null
  }

  if (
    !shouldAutoParseFile({
      mimeType: record.mimeType,
      contentKind: record.contentKind,
    })
  ) {
    return null
  }

  const run = await insertPendingParseRun({
    assetId: params.fileId,
    pipeline: params.pipeline || DEFAULT_FILE_PARSE_PIPELINE,
    trigger: params.trigger,
  })

  await fileParsingQueue.add(
    "parse",
    { runId: run.id } satisfies FileParseJobData,
    {
      jobId: `file-parse-${run.id}`,
    }
  )

  return run.id
}

export async function enqueueDefaultFileParse(params: {
  fileId: string
  mimeType: string
  contentKind: FileContentKind
}): Promise<string | null> {
  if (!shouldAutoParseFile(params)) {
    return null
  }
  return enqueueFileParse({
    fileId: params.fileId,
    trigger: "file_created",
  })
}

export async function processFileParseRun(runId: string): Promise<void> {
  const run = await getParseRunById(runId)
  if (!run) {
    return
  }

  const record = await getFileRecord(run.assetId)
  if (!record) {
    await markParseRunFileNotFound(runId)
    return
  }

  const strategy = resolveParseStrategy({
    mimeType: record.mimeType,
    contentKind: record.contentKind,
  })

  await markParseRunStrategy(runId, {
    parserKey: strategy.parserKey,
    parserVersion: strategy.parserVersion,
    status: strategy.mode === "skip" ? "skipped" : "running",
    startedAt: strategy.mode === "skip" ? null : new Date(),
    finishedAt: strategy.mode === "skip" ? new Date() : null,
    errorCode: strategy.mode === "skip" ? strategy.errorCode : null,
    errorMessage: strategy.mode === "skip" ? strategy.errorMessage : null,
  })

  if (strategy.mode === "skip") {
    return
  }

  // Async cloud providers (submit-and-release): submit the job, persist the vendor
  // token to metadata, and schedule a poll — the run stays "running" and is
  // completed later by the poll job. The worker slot is NOT held during the wait,
  // a re-run polls the same job (no double-submit), and an api restart resumes from
  // the persisted token. Sync providers fall through to the in-handler path below.
  if (strategy.mode === "document") {
    const provider = resolveDocumentExtractionProvider()
    if (provider.isAsync) {
      await submitAndSchedulePoll(runId, record)
      return
    }
  }

  try {
    const parsed = await extractParsedText({
      fileId: record.id,
      mimeType: record.mimeType,
      contentKind: record.contentKind,
    })

    await completeParseRun({
      runId,
      text: parsed.text,
      structuredJson: parsed.structuredJson,
      parserKey: parsed.strategy.parserKey,
      parserVersion: parsed.strategy.parserVersion,
    })
  } catch (error: any) {
    await markParseRunFailed(runId, error?.message || "Failed to parse file")
    // Swallow (no BullMQ retry) ONLY a classified-terminal failure: a
    // deterministic parse outcome where retrying cannot help (OCR found no text,
    // corrupt input). Everything else is rethrown so BullMQ retries — that
    // covers transient OCR failures AND unclassified infra errors (a storage
    // blip in readFileBufferById, or a DB blip in completeParseRun AFTER OCR
    // already succeeded), which must not be silently dropped as terminal.
    if (error instanceof ParseError && !error.retryable) {
      log.warn({ runId, err: error }, "file parse failed (terminal, no retry)")
      return
    }
    throw error
  }
}

type FileRecord = NonNullable<Awaited<ReturnType<typeof getFileRecord>>>

/** Enqueue a delayed poll tick for a submitted async run (auto job id — each tick
 *  is a fresh delayed job). */
async function enqueuePoll(runId: string, delayMs: number): Promise<void> {
  await fileParsingQueue.add(
    "poll",
    { runId, kind: "poll" } satisfies FileParseJobData,
    { delay: delayMs }
  )
}

/** Submit an async (submit-and-release) document job, persist its vendor token, and
 *  schedule the first poll. Idempotency holds ONCE the token is persisted: a re-run
 *  that finds a token re-schedules a poll instead of re-submitting. The submit→
 *  persist window is narrowed by a persist-retry, but a crash INSIDE it can still
 *  re-submit (LlamaParse has no idempotency key to fully close it); the reconciler
 *  + the run's deadline bound the blast radius. */
async function submitAndSchedulePoll(
  runId: string,
  record: FileRecord
): Promise<void> {
  const { pollIntervalMs } = config.documentExtraction.async

  const existing = await getParseRunMetadata(runId)
  if (typeof existing.jobToken === "string" && existing.jobToken) {
    await enqueuePoll(runId, pollIntervalMs)
    return
  }

  const provider = resolveDocumentExtractionProvider()
  const size = Number(record.sizeBytes)
  const result = await submitDocument({
    sha256: record.sha256,
    mimeType: record.mimeType,
    filename: record.originalName,
    sizeBytes: Number.isFinite(size) ? size : undefined,
  })
  if (!result.ok || !result.jobToken) {
    // Retryable (network / 5xx) → throw so BullMQ retries the submit (still no
    // token persisted, so the retry re-submits cleanly). Terminal → record + swallow.
    if (result.retryable) {
      throw new ParseError(result.error || "document submit failed", true)
    }
    await markParseRunFailed(runId, result.error || "document submit failed")
    log.warn({ runId }, "async document submit failed (terminal, no retry)")
    return
  }

  // Persist the token (retry a transient DB blip a few times — losing it here
  // would cause a re-submit / double-bill on the next parse-job retry).
  let persistErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await setParseRunMetadata(runId, {
        provider: provider.key,
        jobToken: result.jobToken,
        engineVersion: result.engineVersion,
        submittedAt: Date.now(),
      })
      persistErr = null
      break
    } catch (err) {
      persistErr = err
    }
  }
  if (persistErr) throw persistErr
  await enqueuePoll(runId, pollIntervalMs)
}

/** Advance a submitted async run: poll the vendor job by its persisted token and
 *  either re-schedule (pending, until the deadline), fail (terminal error/timeout),
 *  or complete (done). The worker slot is never held during the vendor's work. */
export async function processFileParsePoll(runId: string): Promise<void> {
  const run = await getParseRunById(runId)
  if (!run || run.status !== "running") {
    // Already completed/failed (or gone) — nothing to advance.
    return
  }
  const { pollIntervalMs, deadlineMs } = config.documentExtraction.async

  const meta = await getParseRunMetadata(runId)
  const jobToken = typeof meta.jobToken === "string" ? meta.jobToken : ""
  if (!jobToken) {
    await markParseRunFailed(runId, "async poll: missing job token")
    return
  }

  const provider = resolveDocumentExtractionProvider()
  if (!provider.isAsync || provider.key !== meta.provider) {
    // The configured provider changed since submit; the old job token is unpollable.
    await markParseRunFailed(runId, "async poll: provider changed since submit")
    return
  }

  const submittedAt =
    typeof meta.submittedAt === "number" ? meta.submittedAt : Date.now()
  const result = await pollDocument(provider, jobToken)

  if (result.status === "pending") {
    if (Date.now() - submittedAt > deadlineMs) {
      await markParseRunFailed(runId, "async document extraction timed out")
      return
    }
    // Stamp lastPolledAt (merge — keep jobToken/provider/submittedAt) so the
    // reconciler can distinguish a live poll chain from a stranded one.
    await setParseRunMetadata(runId, { ...meta, lastPolledAt: Date.now() })
    await enqueuePoll(runId, pollIntervalMs)
    return
  }

  if (!result.ok) {
    await markParseRunFailed(
      runId,
      result.error || "async document extraction failed"
    )
    return
  }

  // Success (incl. empty text → succeeded + metadata, same as the sync path).
  await completeParseRun({
    runId,
    text: normalizeExtractedText(result.text),
    structuredJson: result.structuredJson,
    parserKey: run.parserKey,
    parserVersion: run.parserVersion,
  })
}

/**
 * Reconciliation sweep for async (submit-and-release) runs — the durable-token
 * recovery anchor. A poll chain can die (a poll tick's DB write exhausts its BullMQ
 * attempts; the delayed poll job is lost across a restart / redis flush; a crash
 * before the first enqueuePoll), leaving a run pinned at 'running' forever. This
 * finds runs still 'running' with a persisted jobToken and either re-drives an
 * OVERDUE chain (no poll for a few intervals) or fails one past its deadline. It is
 * idempotent: processFileParsePoll guards on status + re-reads the token, and the
 * terminal writes are status-conditional, so re-driving a live chain is harmless.
 * Returns the number of runs acted on.
 */
export async function reconcileStrandedAsyncParses(): Promise<number> {
  const { pollIntervalMs, deadlineMs } = config.documentExtraction.async
  const staleMs = Math.max(pollIntervalMs * 3, 30_000)
  const runIds = await findStrandedAsyncRunIds(200)
  const now = Date.now()
  let acted = 0
  for (const runId of runIds) {
    const meta = await getParseRunMetadata(runId)
    if (typeof meta.jobToken !== "string" || !meta.jobToken) {
      continue
    }
    const submittedAt =
      typeof meta.submittedAt === "number" ? meta.submittedAt : now
    const lastActivity =
      typeof meta.lastPolledAt === "number" ? meta.lastPolledAt : submittedAt
    if (now - submittedAt > deadlineMs) {
      await markParseRunFailed(
        runId,
        "async document extraction timed out (reconciled)"
      )
      acted++
    } else if (now - lastActivity > staleMs) {
      // The chain is overdue → re-drive it immediately (idempotent).
      await enqueuePoll(runId, 0)
      acted++
    }
  }
  return acted
}

export async function getLatestSuccessfulFileParse(
  fileId: string,
  pipeline = DEFAULT_FILE_PARSE_PIPELINE
): Promise<FileParseRunView | null> {
  const row = await getLatestParseRun(fileId, pipeline, { status: "succeeded" })

  return row ? presentParseRun(row) : null
}

export async function getLatestAvailableFileParse(
  fileId: string,
  pipeline = DEFAULT_FILE_PARSE_PIPELINE
): Promise<FileParseRunView | null> {
  const latestSuccessful = await getLatestSuccessfulFileParse(fileId, pipeline)
  if (latestSuccessful) {
    return latestSuccessful
  }

  const row = await getLatestParseRun(fileId, pipeline)

  return row ? presentParseRun(row) : null
}
