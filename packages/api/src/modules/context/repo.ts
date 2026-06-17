// context/repo.ts — DB-touching helpers for the context (compaction) module.
//
// The only context file permitted to import the db client + withDbTransaction
// (guard r8). Owns the context_archive_* / context_compaction_* persistence:
// the archive-point/frame reads, the context-state ensure upserts, and the
// whole lossless-archive compaction TRANSACTION (FOR UPDATE state lock + the
// dependent archive-point/frame/run inserts + state pointer update).
//
// TRANSACTION ATOMICITY: maybeCompactChain opens ONE withDbTransaction and runs
// the FOR UPDATE lock plus all dependent writes inside it; the pure compaction
// planner (buildArchiveFrames) is injected by the service so the strategy logic
// stays out of the DB layer while the entire sequence remains atomic.
//
// Records keep Date columns (createdAt) — the presenter (presentArchivePoint)
// serializes for the wire. DB JSON columns are decoded by repo readers before
// presenter shaping. round-6 P1-6.

import { sql } from "kysely"
import type {
  CanonicalArchiveFrame,
  CanonicalArchiveFrameRole,
  CanonicalArchiveChainScope,
  CanonicalArchivePoint,
  CanonicalContentBlock,
  CanonicalContextItem,
} from "@synapse/shared"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { itemPartsToCanonicalBlocks } from "../ai/context-builder.js"
import { presentArchivePoint, type ArchivePointRecord } from "./presenter.js"

const MIN_COMPACTION_ITEMS = 12
const SHARED_ARCHIVE_TAIL_TARGET = 24
const PRIVATE_ARCHIVE_TAIL_TARGET = 32

// Raw archive reads below use `sql`...`.execute()`, whose results pass through
// CamelCasePlugin's (unconditional) transformResult — so `SELECT *` columns and
// double-quoted camelCase aliases (AS "partId") arrive camelCase. The row types
// and mappers therefore read camelCase directly. JSONB / Date values are never
// recursed into, so their values pass through untouched.
export type ArchivePointRow = {
  id: string
  chainScope: CanonicalArchiveChainScope
  conversationId: string
  sessionId: string | null
  parentArchivePointId: string | null
  coversUntilSequence: number | string | null
  metadata: unknown
  createdAt: Date
}

export function normalizeArchivePointRow(
  row: ArchivePointRow
): ArchivePointRecord {
  return {
    id: row.id,
    chainScope: row.chainScope,
    conversationId: row.conversationId,
    sessionId: row.sessionId,
    parentArchivePointId: row.parentArchivePointId,
    coversUntilSequence: row.coversUntilSequence,
    metadata: parseArchiveMetadata(
      row.metadata,
      "context archive point metadata"
    ),
    createdAt: row.createdAt,
  }
}

type ArchiveFrameQueryRow = {
  id: string
  role: CanonicalArchiveFrameRole
  frameType: string
  toolCalls: unknown
  toolResults: unknown
  sourceItemIds: unknown
  metadata: unknown
  partId: string | null
  partOrdinal: number | null
  partType: string | null
  textValue: string | null
  refPath: string | null
  refSha256: string | null
  jsonValue: unknown
  mimeType: string | null
  name: string | null
  partMetadata: unknown
}

export function parseArchiveFrameJsonArray<T>(
  value: unknown,
  label = "archive frame JSON array"
): T[] | undefined {
  if (value === null || value === undefined) return undefined

  let candidate: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} must be a valid JSON array`)
    }
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${label} must be a valid JSON array`)
    }
  }

  if (!Array.isArray(candidate)) {
    throw new Error(`${label} must be a JSON array`)
  }

  return candidate as T[]
}

export async function ensureConversationContextState(conversationId: string) {
  await db
    .insertInto("conversationContextStates")
    .values({
      conversationId: conversationId,
    })
    .onConflict((oc) => oc.columns(["conversationId"]).doNothing())
    .execute()
}

export async function ensureSessionContextState(sessionId: string) {
  await db
    .insertInto("sessionContextStates")
    .values({
      sessionId: sessionId,
    })
    .onConflict((oc) => oc.columns(["sessionId"]).doNothing())
    .execute()
}

export async function loadArchivePoint(
  archivePointId: string,
  executor: Executor = db
): Promise<CanonicalArchivePoint | null> {
  const pointResult = await sql<ArchivePointRow>`
    SELECT *
    FROM context_archive_points
    WHERE id = ${archivePointId}
    LIMIT 1`.execute(executor)

  const point = pointResult.rows[0]
  if (!point) return null

  const framesResult = await sql<ArchiveFrameQueryRow>`
    SELECT caf.*,
           cap.id AS "partId",
           cap.ordinal AS "partOrdinal",
           cap.part_type AS "partType",
           cap.text_value AS "textValue",
           cap.ref_path AS "refPath",
           cap.ref_sha256 AS "refSha256",
           cap.json_value AS "jsonValue",
           cap.mime_type AS "mimeType",
           cap.name,
           cap.metadata AS "partMetadata"
    FROM context_archive_frames caf
    LEFT JOIN context_archive_frame_parts cap ON cap.archive_frame_id = caf.id
    WHERE caf.archive_point_id = ${archivePointId}
    ORDER BY caf.ordinal ASC, cap.ordinal ASC`.execute(executor)

  const frameMap = new Map<
    string,
    {
      row: ArchiveFrameQueryRow
      parts: Array<{
        part_type: string | null
        text_value: string | null
        ref_path: string | null
        ref_sha256: string | null
        json_value: unknown
        mime_type: string | null
        name: string | null
        metadata: unknown
      }>
    }
  >()
  for (const row of framesResult.rows) {
    if (!frameMap.has(row.id)) {
      frameMap.set(row.id, { row, parts: [] })
    }
    if (row.partId) {
      frameMap.get(row.id)!.parts.push({
        part_type: row.partType,
        text_value: row.textValue,
        ref_path: row.refPath,
        ref_sha256: row.refSha256,
        json_value: row.jsonValue,
        mime_type: row.mimeType,
        name: row.name,
        metadata: row.partMetadata,
      })
    }
  }

  const frames: CanonicalArchiveFrame[] = Array.from(frameMap.values()).map(
    ({ row, parts }) => ({
      frameId: row.id,
      role: row.role,
      frameType: row.frameType,
      parts: parts.length > 0 ? itemPartsToCanonicalBlocks(parts) : undefined,
      toolCalls: parseArchiveFrameJsonArray(
        row.toolCalls,
        `Context archive frame ${row.id} tool_calls`
      ),
      toolResults: parseArchiveFrameJsonArray(
        row.toolResults,
        `Context archive frame ${row.id} tool_results`
      ),
      sourceItemIds: Array.isArray(row.sourceItemIds)
        ? row.sourceItemIds
        : undefined,
      metadata: parseArchiveMetadata(
        row.metadata,
        `context archive frame ${row.id} metadata`
      ),
    })
  )

  return presentArchivePoint(normalizeArchivePointRow(point), frames)
}

function parseArchiveMetadata(
  value: unknown,
  label: string
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined

  let candidate: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} must be a valid JSON object`)
    }
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${label} must be a valid JSON object`)
    }
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new Error(`${label} must be a JSON object`)
  }

  return candidate as Record<string, unknown>
}

function blockToArchivePart(block: CanonicalContentBlock) {
  if (block.type === "text") {
    return {
      partType: "text",
      textValue: block.text,
      refPath: null as string | null,
      refSha256: null as string | null,
      jsonValue: null,
      mimeType: null,
      name: null,
      metadata: {},
    }
  }

  if (block.type === "mention") {
    return {
      partType: "json",
      textValue: null,
      refPath: null as string | null,
      refSha256: null as string | null,
      jsonValue: {
        id: block.id,
        type: "mention",
        mention: block.mention,
      },
      mimeType: "application/vnd.synapse.mention+json",
      name: "mention",
      metadata: {},
    }
  }

  return {
    partType: "file_ref",
    textValue: null,
    refPath: block.path ?? null,
    refSha256: block.sha256,
    jsonValue: null,
    mimeType: block.mimeType,
    name: block.name,
    metadata: {
      sha256: block.sha256,
      path: block.path,
      sizeBytes: block.sizeBytes,
      category: block.category,
    },
  }
}

async function insertArchiveFrames(
  executor: Executor,
  archivePointId: string,
  frames: CanonicalArchiveFrame[]
) {
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]
    const frameResult = await sql<{ id: string }>`
      INSERT INTO context_archive_frames
        (archive_point_id, ordinal, role, frame_type, tool_calls, tool_results, source_item_ids, metadata)
      VALUES (
        ${archivePointId},
        ${frameIndex},
        ${frame.role},
        ${frame.frameType},
        ${frame.toolCalls ? JSON.stringify(frame.toolCalls) : null},
        ${frame.toolResults ? JSON.stringify(frame.toolResults) : null},
        ${
          frame.sourceItemIds && frame.sourceItemIds.length > 0
            ? frame.sourceItemIds
            : []
        },
        ${JSON.stringify(frame.metadata || {})}
      )
      RETURNING id`.execute(executor)

    const frameId = frameResult.rows[0]?.id
    if (!frameId || !frame.parts || frame.parts.length === 0) continue

    for (let partIndex = 0; partIndex < frame.parts.length; partIndex += 1) {
      const part = blockToArchivePart(frame.parts[partIndex]!)
      await sql`
        INSERT INTO context_archive_frame_parts
          (archive_frame_id, ordinal, part_type, text_value, ref_path, ref_sha256, json_value, mime_type, name, metadata)
        VALUES (
          ${frameId},
          ${partIndex},
          ${part.partType},
          ${part.textValue},
          ${part.refPath},
          ${part.refSha256},
          ${part.jsonValue},
          ${part.mimeType},
          ${part.name},
          ${JSON.stringify(part.metadata || {})}
        )`.execute(executor)
    }
  }
}

/**
 * Owns the whole lossless-archive compaction transaction for one chain scope.
 *
 * The pure compaction planner (`buildArchiveFrames`, which compiles the
 * to-archive items into frames) is injected so the strategy logic stays out of
 * the DB layer; everything from the FOR UPDATE state lock through the state
 * pointer UPDATE runs inside ONE withDbTransaction so compaction cannot race or
 * double-archive.
 */
export async function maybeCompactChain(params: {
  conversationId: string
  sessionId?: string
  chainScope: "shared" | "private"
  items: CanonicalContextItem[]
  buildArchiveFrames: (
    items: CanonicalContextItem[]
  ) => Promise<CanonicalArchiveFrame[]>
}) {
  if (params.chainScope === "private" && !params.sessionId) return

  if (params.chainScope === "shared") {
    await ensureConversationContextState(params.conversationId)
  } else {
    await ensureSessionContextState(params.sessionId!)
  }

  const tailTarget =
    params.chainScope === "shared"
      ? SHARED_ARCHIVE_TAIL_TARGET
      : PRIVATE_ARCHIVE_TAIL_TARGET
  const stateTable =
    params.chainScope === "shared"
      ? "conversation_context_states"
      : "session_context_states"
  const stateIdColumn =
    params.chainScope === "shared" ? "conversation_id" : "session_id"
  const archiveIdColumn =
    params.chainScope === "shared"
      ? "active_shared_archive_point_id"
      : "active_private_archive_point_id"
  const stateIdValue =
    params.chainScope === "shared" ? params.conversationId : params.sessionId!
  const scopedItems = params.items
    .filter(
      (item) =>
        item.scope === params.chainScope && typeof item.sequence === "number"
    )
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0))

  if (scopedItems.length <= tailTarget + MIN_COMPACTION_ITEMS) {
    return
  }

  await withDbTransaction(async (trx) => {
    const stateResult = await sql<{ archivePointId: string | null }>`
      SELECT ${sql.ref(archiveIdColumn)} AS "archivePointId"
      FROM ${sql.table(stateTable)}
      WHERE ${sql.ref(stateIdColumn)} = ${stateIdValue}
      FOR UPDATE`.execute(trx)

    const activeArchivePointId = stateResult.rows[0]?.archivePointId || null
    const activeArchivePoint = activeArchivePointId
      ? await loadArchivePoint(activeArchivePointId, trx)
      : null
    const activeCoverage = activeArchivePoint?.coversUntilSequence ?? 0
    const uncoveredItems = scopedItems.filter(
      (item) => (item.sequence || 0) > activeCoverage
    )

    if (uncoveredItems.length <= tailTarget + MIN_COMPACTION_ITEMS) {
      return
    }

    const targetIndex = uncoveredItems.length - tailTarget - 1
    const targetCoverage =
      uncoveredItems[targetIndex]?.sequence ?? activeCoverage
    if (targetCoverage <= activeCoverage) {
      return
    }

    const itemsToArchive = uncoveredItems.filter(
      (item) => (item.sequence || 0) <= targetCoverage
    )
    if (itemsToArchive.length < MIN_COMPACTION_ITEMS) {
      return
    }

    const deltaFrames = await params.buildArchiveFrames(itemsToArchive)
    const frames = [...(activeArchivePoint?.frames || []), ...deltaFrames]
    if (frames.length === 0) {
      return
    }

    const archivePointResult = await sql<{ id: string }>`
      INSERT INTO context_archive_points
        (conversation_id, session_id, chain_scope, parent_archive_point_id, covers_until_sequence, metadata)
      VALUES (
        ${params.conversationId},
        ${params.chainScope === "private" ? params.sessionId || null : null},
        ${params.chainScope},
        ${activeArchivePointId},
        ${targetCoverage},
        ${JSON.stringify({
          strategyKey: "lossless_archive_v1",
          appendedItemCount: itemsToArchive.length,
          totalFrameCount: frames.length,
        })}
      )
      RETURNING id`.execute(trx)

    const archivePointId = archivePointResult.rows[0]?.id
    if (!archivePointId) {
      return
    }

    await insertArchiveFrames(trx, archivePointId, frames)

    const compactionRunResult = await sql<{ id: string }>`
      INSERT INTO context_compaction_runs
        (conversation_id, session_id, chain_scope, strategy_key, base_archive_point_id, output_archive_point_id, status, metadata)
      VALUES (
        ${params.conversationId},
        ${params.chainScope === "private" ? params.sessionId || null : null},
        ${params.chainScope},
        ${"lossless_archive_v1"},
        ${activeArchivePointId},
        ${archivePointId},
        'completed',
        ${JSON.stringify({
          appendedItemCount: itemsToArchive.length,
          targetCoverage,
        })}
      )
      RETURNING id`.execute(trx)

    const compactionRunId = compactionRunResult.rows[0]?.id
    if (compactionRunId) {
      if (activeArchivePointId) {
        await sql`
          INSERT INTO context_compaction_run_inputs
            (run_id, input_kind, archive_point_id, metadata)
          VALUES (${compactionRunId}, 'archive_point', ${activeArchivePointId}, ${JSON.stringify(
            { role: "base" }
          )})`.execute(trx)
      }

      await sql`
        INSERT INTO context_compaction_run_inputs
          (run_id, input_kind, from_sequence, to_sequence, metadata)
        VALUES (
          ${compactionRunId},
          'sequence_range',
          ${activeCoverage + 1},
          ${targetCoverage},
          ${JSON.stringify({ appendedItemCount: itemsToArchive.length })}
        )`.execute(trx)
    }

    await sql`
      UPDATE ${sql.table(stateTable)}
      SET ${sql.ref(archiveIdColumn)} = ${archivePointId}
      WHERE ${sql.ref(stateIdColumn)} = ${stateIdValue}`.execute(trx)
  })
}

export async function loadActiveSharedArchivePoint(
  conversationId: string
): Promise<CanonicalArchivePoint | null> {
  await ensureConversationContextState(conversationId)
  const row = await db
    .selectFrom("conversationContextStates")
    .select("activeSharedArchivePointId")
    .where("conversationId", "=", conversationId)
    .executeTakeFirst()
  const archivePointId = row?.activeSharedArchivePointId
  return archivePointId ? loadArchivePoint(archivePointId) : null
}

export async function loadActivePrivateArchivePoint(
  sessionId?: string
): Promise<CanonicalArchivePoint | null> {
  if (!sessionId) return null
  await ensureSessionContextState(sessionId)
  const row = await db
    .selectFrom("sessionContextStates")
    .select("activePrivateArchivePointId")
    .where("sessionId", "=", sessionId)
    .executeTakeFirst()
  const archivePointId = row?.activePrivateArchivePointId
  return archivePointId ? loadArchivePoint(archivePointId) : null
}
