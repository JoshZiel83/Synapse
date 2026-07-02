import { createRequire } from "node:module"
import type {
  FileContentKind,
  FileParseOutputView,
  FileParseRunView,
} from "@synapse/shared/types"
import { fileParsingQueue } from "../../workers/queues.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { recognizeOcr, resolveOcrProvider } from "../ocr/index.js"
import { getFileDetail, getFileRecord, readFileBufferById } from "./service.js"
import { normalizePdfParseMetadata } from "./parse-metadata.js"
import {
  completeParseRun,
  getLatestParseRun,
  getParseRunById,
  insertPendingParseRun,
  listParseOutputRowsForRuns,
  markParseRunFailed,
  markParseRunFileNotFound,
  markParseRunStrategy,
} from "./repo-parse.js"
import {
  presentFileParseOutput,
  presentFileParseRun,
  type FileParseRunRow as ParseRunRow,
} from "./presenter.js"

const localRequire = createRequire(import.meta.url)
const log = createLogger("file-parsing")

export const DEFAULT_FILE_PARSE_PIPELINE = "default_extract"
const UTF8_TEXT_PARSER_KEY = "utf8_text"
const UTF8_TEXT_PARSER_VERSION = "1"
const PDF_PARSE_PARSER_KEY = "pdf_parse"
const PDF_PARSE_PARSER_VERSION = "1"

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
      mode: "pdf"
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
  if (params.mimeType === "application/pdf") {
    return {
      parserKey: PDF_PARSE_PARSER_KEY,
      parserVersion: PDF_PARSE_PARSER_VERSION,
      mode: "pdf",
    }
  }
  if (isTextLikeMimeType(params.mimeType)) {
    return {
      parserKey: UTF8_TEXT_PARSER_KEY,
      parserVersion: UTF8_TEXT_PARSER_VERSION,
      mode: "text",
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

function loadPdfParse(): (buffer: Buffer) => Promise<Record<string, unknown>> {
  return localRequire("pdf-parse") as (
    buffer: Buffer
  ) => Promise<Record<string, unknown>>
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

  if (strategy.mode === "pdf") {
    const pdfParse = loadPdfParse()
    const parsed = await pdfParse(buffer)
    const text = normalizeExtractedText(String(parsed.text || ""))
    const metadata = normalizePdfParseMetadata(parsed)
    return {
      strategy,
      text,
      structuredJson: metadata,
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
