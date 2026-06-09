import { createRequire } from "node:module"
import type {
  FileContentKind,
  FileParseOutputView,
  FileParseRunView,
} from "@synapse/shared/types"
import { parseJsonObjectOrUndefined as parseJsonObject } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { fileParsingQueue } from "../../workers/queues.js"
import { extractImageOcrText } from "../ai/image-fallback.js"
import { getFileDetail, getFileRecord, readFileBufferById } from "./service.js"

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

type ParseRunRow = {
  id: string
  asset_id: string
  pipeline: string
  parser_key: string
  parser_version: string | null
  trigger: string
  status: FileParseRunView["status"]
  error_code: string | null
  error_message: string | null
  created_at: Date | null
  started_at: Date | null
  finished_at: Date | null
}

type ParseOutputRow = {
  id: string
  run_id: string
  output_kind: FileParseOutputView["outputKind"]
  role: string
  is_primary: boolean
  text_content: string | null
  structured_json: unknown
  derived_asset_id: string | null
  created_at: Date | null
}

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
    .selectFrom("file_parse_outputs")
    .selectAll()
    .where("run_id", "in", runIds)
    .orderBy("created_at", "asc")
    .execute()) as ParseOutputRow[]

  const derivedFileIds = Array.from(
    new Set(
      rows
        .map((row) => row.derived_asset_id)
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
    if (!grouped.has(row.run_id)) {
      grouped.set(row.run_id, [])
    }
    grouped.get(row.run_id)!.push({
      id: row.id,
      outputKind: row.output_kind,
      role: row.role,
      isPrimary: row.is_primary,
      textContent: row.text_content ?? undefined,
      structuredJson: parseJsonObject(row.structured_json),
      derivedFileId: row.derived_asset_id,
      derivedFile: row.derived_asset_id
        ? derivedFiles.get(row.derived_asset_id)
        : undefined,
      createdAt: serializeInstant(
        requireInstantDate(
          row.created_at,
          `file_parse_outputs.${row.id}.created_at`
        )
      ),
    })
  }

  return grouped
}

async function mapRunRow(row: ParseRunRow): Promise<FileParseRunView> {
  const outputsByRunId = await listParseOutputsForRuns([row.id])
  return {
    id: row.id,
    fileId: row.asset_id,
    pipeline: row.pipeline,
    parserKey: row.parser_key,
    parserVersion: row.parser_version,
    trigger: row.trigger,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: serializeInstant(
      requireInstantDate(row.created_at, `file_parse_runs.${row.id}.created_at`)
    ),
    startedAt: serializeOptionalInstant(row.started_at) ?? null,
    finishedAt: serializeOptionalInstant(row.finished_at) ?? null,
    outputs: outputsByRunId.get(row.id) || [],
  }
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
    .insertInto("file_parse_runs")
    .values({
      asset_id: params.fileId,
      pipeline: params.pipeline || DEFAULT_FILE_PARSE_PIPELINE,
      parser_key: PENDING_PARSER_KEY,
      parser_version: null,
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
    .selectFrom("file_parse_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst()) as ParseRunRow | undefined
  if (!run) {
    return
  }

  const record = await getFileRecord(run.asset_id)
  if (!record) {
    await db
      .updateTable("file_parse_runs")
      .set({
        status: "failed",
        error_code: "FILE_NOT_FOUND",
        error_message: "Referenced file was not found.",
        finished_at: new Date(),
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
    .updateTable("file_parse_runs")
    .set({
      parser_key: strategy.parserKey,
      parser_version: strategy.parserVersion,
      status: strategy.mode === "skip" ? "skipped" : "running",
      started_at: strategy.mode === "skip" ? null : new Date(),
      finished_at: strategy.mode === "skip" ? new Date() : null,
      error_code: strategy.mode === "skip" ? strategy.errorCode : null,
      error_message: strategy.mode === "skip" ? strategy.errorMessage : null,
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
          .insertInto("file_parse_outputs")
          .values({
            run_id: runId,
            output_kind: "text",
            role: "primary_text",
            is_primary: true,
            text_content: parsed.text,
          })
          .execute()
      }

      if (parsed.structuredJson) {
        await trx
          .insertInto("file_parse_outputs")
          .values({
            run_id: runId,
            output_kind: "structured_json",
            role: "parser_metadata",
            is_primary: false,
            structured_json: parsed.structuredJson as any,
          })
          .execute()
      }

      await trx
        .updateTable("file_parse_runs")
        .set({
          parser_key: parsed.strategy.parserKey,
          parser_version: parsed.strategy.parserVersion,
          status: "succeeded",
          error_code: null,
          error_message: null,
          finished_at: new Date(),
        })
        .where("id", "=", runId)
        .execute()
    })
  } catch (error: any) {
    await db
      .updateTable("file_parse_runs")
      .set({
        status: "failed",
        error_code: "PARSE_FAILED",
        error_message: error?.message || "Failed to parse file",
        finished_at: new Date(),
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
    .selectFrom("file_parse_runs")
    .selectAll()
    .where("asset_id", "=", fileId)
    .where("pipeline", "=", pipeline)
    .where("status", "=", "succeeded")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()) as ParseRunRow | undefined

  return row ? mapRunRow(row) : null
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
    .selectFrom("file_parse_runs")
    .selectAll()
    .where("asset_id", "=", fileId)
    .where("pipeline", "=", pipeline)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()) as ParseRunRow | undefined

  return row ? mapRunRow(row) : null
}
