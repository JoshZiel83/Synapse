// files/repo-parse.ts — DB-touching reads/writes for the file-parse pipeline.
//
// The only parse-service-side file permitted to import the db client (guard r8).
// Owns the file_parse_runs / file_parse_outputs queries, including the atomic
// completion transaction (kept entirely inside the repo so no trx leaks to the
// service). Returns camelCase domain rows with Date objects KEPT (Date→ISO
// serialization stays in presenter.ts per r3). round-6 P1-6.

import { parseJsonObjectOrUndefined } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import type { FileParseRunRow, FileParseOutputRow } from "./presenter.js"

const PENDING_PARSER_KEY = "pending_dispatch"

export type FileParseOutputDbRow = Omit<
  FileParseOutputRow,
  "structuredJson"
> & {
  structuredJson: unknown
}

export function normalizeFileParseOutputRow(
  row: FileParseOutputDbRow
): FileParseOutputRow {
  const { structuredJson, ...rest } = row
  return {
    ...rest,
    structuredJson: parseJsonObjectOrUndefined(structuredJson),
  }
}

export async function insertPendingParseRun(params: {
  assetId: string
  pipeline: string
  trigger: string
}): Promise<{ id: string }> {
  return db
    .insertInto("fileParseRuns")
    .values({
      assetId: params.assetId,
      pipeline: params.pipeline,
      parserKey: PENDING_PARSER_KEY,
      parserVersion: null,
      trigger: params.trigger,
      status: "pending",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
}

export async function getParseRunById(
  runId: string
): Promise<FileParseRunRow | undefined> {
  return (await db
    .selectFrom("fileParseRuns")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst()) as FileParseRunRow | undefined
}

export async function markParseRunFileNotFound(runId: string): Promise<void> {
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
}

export async function markParseRunStrategy(
  runId: string,
  fields: {
    parserKey: string
    parserVersion: string | null
    status: "skipped" | "running"
    startedAt: Date | null
    finishedAt: Date | null
    errorCode: string | null
    errorMessage: string | null
  }
): Promise<void> {
  await db
    .updateTable("fileParseRuns")
    .set({
      parserKey: fields.parserKey,
      parserVersion: fields.parserVersion,
      status: fields.status,
      startedAt: fields.startedAt,
      finishedAt: fields.finishedAt,
      errorCode: fields.errorCode,
      errorMessage: fields.errorMessage,
    })
    .where("id", "=", runId)
    .execute()
}

/**
 * Atomic completion: conditionally inserts the text output + structured-json
 * output, then flips the run to succeeded. The whole thing runs in one
 * transaction so partial writes can't escape (kept inside the repo so no trx
 * leaks to the service).
 */
export async function completeParseRun(params: {
  runId: string
  text?: string
  structuredJson?: Record<string, unknown>
  parserKey: string
  parserVersion: string | null
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    if (params.text) {
      await trx
        .insertInto("fileParseOutputs")
        .values({
          runId: params.runId,
          outputKind: "text",
          role: "primary_text",
          isPrimary: true,
          textContent: params.text,
        })
        .execute()
    }

    if (params.structuredJson) {
      await trx
        .insertInto("fileParseOutputs")
        .values({
          runId: params.runId,
          outputKind: "structured_json",
          role: "parser_metadata",
          isPrimary: false,
          structuredJson: params.structuredJson as any,
        })
        .execute()
    }

    await trx
      .updateTable("fileParseRuns")
      .set({
        parserKey: params.parserKey,
        parserVersion: params.parserVersion,
        status: "succeeded",
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
      })
      .where("id", "=", params.runId)
      .execute()
  })
}

export async function markParseRunFailed(
  runId: string,
  errorMessage: string
): Promise<void> {
  await db
    .updateTable("fileParseRuns")
    .set({
      status: "failed",
      errorCode: "PARSE_FAILED",
      errorMessage,
      finishedAt: new Date(),
    })
    .where("id", "=", runId)
    .execute()
}

export async function listParseOutputRowsForRuns(
  runIds: string[]
): Promise<FileParseOutputRow[]> {
  const rows = (await db
    .selectFrom("fileParseOutputs")
    .selectAll()
    .where("runId", "in", runIds)
    .orderBy("createdAt", "asc")
    .execute()) as FileParseOutputDbRow[]
  return rows.map(normalizeFileParseOutputRow)
}

export async function getLatestParseRun(
  assetId: string,
  pipeline: string,
  opts?: { status?: "succeeded" }
): Promise<FileParseRunRow | undefined> {
  let query = db
    .selectFrom("fileParseRuns")
    .selectAll()
    .where("assetId", "=", assetId)
    .where("pipeline", "=", pipeline)

  if (opts?.status) {
    query = query.where("status", "=", opts.status)
  }

  return (await query
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()) as FileParseRunRow | undefined
}
