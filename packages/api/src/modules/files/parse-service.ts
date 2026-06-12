import { createRequire } from "node:module"
import type {
  FileContentKind,
  FileParseOutputView,
  FileParseRunView,
} from "@synapse/shared/types"
import { parseJsonObjectOrUndefined as parseJsonObject } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { fileParsingQueue } from "../../workers/queues.js"
import { extractImageOcrText } from "../ai/image-fallback.js"
import { getFileDetail, getFileRecord, readFileBufferById } from "./service.js"
import {
  presentFileParseOutput,
  presentFileParseRun,
  type FileParseRunRow as ParseRunRow,
  type FileParseOutputRow as ParseOutputRow,
} from "./presenter.js"

const localRequire = createRequire(import.meta.url)

export const DEFAULT_FILE_PARSE_PIPELINE = "default_extract"
const PENDING_PARSER_KEY = "pending_dispatch"
const UTF8_TEXT_PARSER_KEY = "utf8_text"
const UTF8_TEXT_PARSER_VERSION = "1"
const PDF_PARSE_PARSER_KEY = "pdf_parse"
const PDF_PARSE_PARSER_VERSION = "1"
const TESSERACT_OCR_PARSER_KEY = "tesseract_ocr"
const TESSERACT_OCR_PARSER_VERSION = "7"

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

// ParseRunRow / ParseOutputRow types + their row→View presenters live in
// ./presenter.ts (round-6 P1-7) and are imported above as aliases.

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
    return {
      parserKey: TESSERACT_OCR_PARSER_KEY,
      parserVersion: TESSERACT_OCR_PARSER_VERSION,
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
    const metadata = parseJsonObject({
      info: parseJsonObject(parsed.info),
      metadata: parseJsonObject(parsed.metadata),
      numPages:
        typeof parsed.numpages === "number" ? parsed.numpages : undefined,
    })
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
  const ocr = await extractImageOcrText(ocrRecord.sha256)
  if (!ocr.ok || !ocr.text) {
    throw new Error(ocr.error || "Image OCR did not return text")
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

  const rows = (await db
    .selectFrom("fileParseOutputs")
    .selectAll()
    .where("runId", "in", runIds)
    .orderBy("createdAt", "asc")
    .execute()) as ParseOutputRow[]

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

  const run = await db
    .insertInto("fileParseRuns")
    .values({
      assetId: params.fileId,
      pipeline: params.pipeline || DEFAULT_FILE_PARSE_PIPELINE,
      parserKey: PENDING_PARSER_KEY,
      parserVersion: null,
      trigger: params.trigger,
      status: "pending",
    })
    .returning("id")
    .executeTakeFirstOrThrow()

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
  const run = (await db
    .selectFrom("fileParseRuns")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst()) as ParseRunRow | undefined
  if (!run) {
    return
  }

  const record = await getFileRecord(run.assetId)
  if (!record) {
    await db
      .updateTable("fileParseRuns")
      .set({
        status: "failed",
        errorCode: "FILE_NOT_FOUND",
        errorMessage: "Referenced file was not found.",
        finishedAt: new Date(),
      })
      .where("id", "=", runId)
      .execute()
    return
  }

  const strategy = resolveParseStrategy({
    mimeType: record.mimeType,
    contentKind: record.contentKind,
  })

  await db
    .updateTable("fileParseRuns")
    .set({
      parserKey: strategy.parserKey,
      parserVersion: strategy.parserVersion,
      status: strategy.mode === "skip" ? "skipped" : "running",
      startedAt: strategy.mode === "skip" ? null : new Date(),
      finishedAt: strategy.mode === "skip" ? new Date() : null,
      errorCode: strategy.mode === "skip" ? strategy.errorCode : null,
      errorMessage: strategy.mode === "skip" ? strategy.errorMessage : null,
    })
    .where("id", "=", runId)
    .execute()

  if (strategy.mode === "skip") {
    return
  }

  try {
    const parsed = await extractParsedText({
      fileId: record.id,
      mimeType: record.mimeType,
      contentKind: record.contentKind,
    })

    await db.transaction().execute(async (trx) => {
      if (parsed.text) {
        await trx
          .insertInto("fileParseOutputs")
          .values({
            runId: runId,
            outputKind: "text",
            role: "primary_text",
            isPrimary: true,
            textContent: parsed.text,
          })
          .execute()
      }

      if (parsed.structuredJson) {
        await trx
          .insertInto("fileParseOutputs")
          .values({
            runId: runId,
            outputKind: "structured_json",
            role: "parser_metadata",
            isPrimary: false,
            structuredJson: parsed.structuredJson as any,
          })
          .execute()
      }

      await trx
        .updateTable("fileParseRuns")
        .set({
          parserKey: parsed.strategy.parserKey,
          parserVersion: parsed.strategy.parserVersion,
          status: "succeeded",
          errorCode: null,
          errorMessage: null,
          finishedAt: new Date(),
        })
        .where("id", "=", runId)
        .execute()
    })
  } catch (error: any) {
    await db
      .updateTable("fileParseRuns")
      .set({
        status: "failed",
        errorCode: "PARSE_FAILED",
        errorMessage: error?.message || "Failed to parse file",
        finishedAt: new Date(),
      })
      .where("id", "=", runId)
      .execute()
    throw error
  }
}

export async function getLatestSuccessfulFileParse(
  fileId: string,
  pipeline = DEFAULT_FILE_PARSE_PIPELINE
): Promise<FileParseRunView | null> {
  const row = (await db
    .selectFrom("fileParseRuns")
    .selectAll()
    .where("assetId", "=", fileId)
    .where("pipeline", "=", pipeline)
    .where("status", "=", "succeeded")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()) as ParseRunRow | undefined

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

  const row = (await db
    .selectFrom("fileParseRuns")
    .selectAll()
    .where("assetId", "=", fileId)
    .where("pipeline", "=", pipeline)
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()) as ParseRunRow | undefined

  return row ? presentParseRun(row) : null
}
