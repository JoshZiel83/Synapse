import type {
  CanonicalContentBlock,
  CanonicalContextItem,
  ConversationMessage,
} from "@synapse/shared"
import { query, transaction } from "../../infrastructure/database/index.js"
import type {
  CanonicalArchiveFrame,
  CanonicalArchivePoint,
  ProviderContextManifest,
  ProviderContextWindow,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { itemPartsToCanonicalBlocks } from "../ai/context-builder.js"
import { compileContextItemsToConversationMessages } from "../ai/context-compiler.js"
import { sql } from "kysely"

const MIN_COMPACTION_ITEMS = 12
const SHARED_ARCHIVE_TAIL_TARGET = 24
const PRIVATE_ARCHIVE_TAIL_TARGET = 32
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type QueryRunner = (text: string, params?: any[]) => Promise<{ rows: any[] }>

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>
  }
  return undefined
}

function parseJsonArray<T>(value: unknown): T[] | undefined {
  if (!value) return undefined
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[]
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    return value as T[]
  }
  return undefined
}

async function ensureConversationContextState(conversationId: string) {
  await db
    .insertInto("conversation_context_states")
    .values({
      conversation_id: conversationId,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) => oc.columns(["conversation_id"]).doNothing())
    .execute()
}

async function ensureSessionContextState(sessionId: string) {
  await db
    .insertInto("session_context_states")
    .values({
      session_id: sessionId,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) => oc.columns(["session_id"]).doNothing())
    .execute()
}

async function loadArchivePoint(
  archivePointId: string,
  runQuery: QueryRunner = query
): Promise<CanonicalArchivePoint | null> {
  const pointResult = await runQuery(
    `SELECT *
     FROM context_archive_points
     WHERE id = $1
     LIMIT 1`,
    [archivePointId]
  )

  const point = pointResult.rows[0]
  if (!point) return null

  const framesResult = await runQuery(
    `SELECT caf.*,
            cap.id AS part_id,
            cap.ordinal AS part_ordinal,
            cap.part_type,
            cap.text_value,
            cap.ref_path,
            cap.ref_sha256,
            cap.json_value,
            cap.mime_type,
            cap.name,
            cap.metadata AS part_metadata
     FROM context_archive_frames caf
     LEFT JOIN context_archive_frame_parts cap ON cap.archive_frame_id = caf.id
     WHERE caf.archive_point_id = $1
     ORDER BY caf.ordinal ASC, cap.ordinal ASC`,
    [archivePointId]
  )

  const frameMap = new Map<string, { row: any; parts: any[] }>()
  for (const row of framesResult.rows) {
    if (!frameMap.has(row.id)) {
      frameMap.set(row.id, { row, parts: [] })
    }
    if (row.part_id) {
      frameMap.get(row.id)!.parts.push({
        part_type: row.part_type,
        text_value: row.text_value,
        ref_path: row.ref_path,
        ref_sha256: row.ref_sha256,
        json_value: row.json_value,
        mime_type: row.mime_type,
        name: row.name,
        metadata: row.part_metadata,
      })
    }
  }

  const frames: CanonicalArchiveFrame[] = Array.from(frameMap.values()).map(
    ({ row, parts }) => ({
      frameId: row.id,
      role: row.role,
      frameType: row.frame_type,
      parts: parts.length > 0 ? itemPartsToCanonicalBlocks(parts) : undefined,
      toolCalls: parseJsonArray(row.tool_calls),
      toolResults: parseJsonArray(row.tool_results),
      sourceItemIds: Array.isArray(row.source_item_ids)
        ? row.source_item_ids
        : undefined,
      metadata: parseJsonObject(row.metadata),
    })
  )

  return {
    archivePointId: point.id,
    chainScope: point.chain_scope,
    conversationId: point.conversation_id,
    sessionId: point.session_id || undefined,
    parentArchivePointId: point.parent_archive_point_id || undefined,
    coversUntilSequence: Number(point.covers_until_sequence || 0),
    frames,
    metadata: parseJsonObject(point.metadata),
    createdAt: point.created_at?.toISOString?.() || point.created_at,
  }
}

function isUuid(value: string | undefined) {
  return !!value && UUID_PATTERN.test(value)
}

function buildArchiveFrameType(item: CanonicalContextItem) {
  switch (item.kind) {
    case "message":
      return item.messageType || "message"
    case "event":
      return `event:${item.eventType}`
    case "system_notice":
      return `notice:${item.noticeType}`
    case "tool_call_batch":
      return "tool_call_batch"
    case "tool_result_batch":
      return "tool_result_batch"
    case "summary":
      return `summary:${item.summaryType}`
    case "memory_recall":
      return `memory_recall:${item.recallType}`
  }
}

function buildArchiveFrameMetadata(
  item: CanonicalContextItem,
  frameIndex: number
) {
  return {
    contextKind: item.kind,
    scope: item.scope,
    surface: item.surface,
    sequence: item.sequence,
    frameIndex,
    ...(item.itemId && !isUuid(item.itemId)
      ? { syntheticSourceItemId: item.itemId }
      : {}),
  }
}

function conversationMessageToArchiveFrame(
  item: CanonicalContextItem,
  message: ConversationMessage,
  frameIndex: number
): CanonicalArchiveFrame {
  const sourceItemId = isUuid(item.itemId) ? item.itemId : undefined
  const sourceItemIds = sourceItemId ? [sourceItemId] : undefined
  const frameType =
    frameIndex === 0
      ? buildArchiveFrameType(item)
      : `${buildArchiveFrameType(item)}:${frameIndex}`

  if (message.role === "assistant") {
    return {
      role: "assistant",
      frameType,
      parts: message.content,
      toolCalls: message.toolCalls,
      sourceItemIds,
      metadata: buildArchiveFrameMetadata(item, frameIndex),
    }
  }

  if (message.role === "tool_result") {
    return {
      role: "tool",
      frameType,
      toolResults: message.results,
      sourceItemIds,
      metadata: buildArchiveFrameMetadata(item, frameIndex),
    }
  }

  return {
    role: "user",
    frameType,
    parts: message.content,
    sourceItemIds,
    metadata: buildArchiveFrameMetadata(item, frameIndex),
  }
}

async function buildArchiveFrames(
  items: CanonicalContextItem[]
): Promise<CanonicalArchiveFrame[]> {
  const frames: CanonicalArchiveFrame[] = []

  for (const item of items) {
    const compiledMessages = await compileContextItemsToConversationMessages([
      item,
    ])
    compiledMessages.forEach((message, index) => {
      frames.push(conversationMessageToArchiveFrame(item, message, index))
    })
  }

  return frames
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
  runQuery: QueryRunner,
  archivePointId: string,
  frames: CanonicalArchiveFrame[]
) {
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex]
    const frameResult = await runQuery(
      `INSERT INTO context_archive_frames
         (archive_point_id, ordinal, role, frame_type, tool_calls, tool_results, source_item_ids, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        archivePointId,
        frameIndex,
        frame.role,
        frame.frameType,
        frame.toolCalls ? JSON.stringify(frame.toolCalls) : null,
        frame.toolResults ? JSON.stringify(frame.toolResults) : null,
        frame.sourceItemIds && frame.sourceItemIds.length > 0
          ? frame.sourceItemIds
          : [],
        JSON.stringify(frame.metadata || {}),
      ]
    )

    const frameId = frameResult.rows[0]?.id
    if (!frameId || !frame.parts || frame.parts.length === 0) continue

    for (let partIndex = 0; partIndex < frame.parts.length; partIndex += 1) {
      const part = blockToArchivePart(frame.parts[partIndex]!)
      await runQuery(
        `INSERT INTO context_archive_frame_parts
           (archive_frame_id, ordinal, part_type, text_value, ref_path, ref_sha256, json_value, mime_type, name, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          frameId,
          partIndex,
          part.partType,
          part.textValue,
          part.refPath,
          part.refSha256,
          part.jsonValue,
          part.mimeType,
          part.name,
          JSON.stringify(part.metadata || {}),
        ]
      )
    }
  }
}

async function maybeCompactChain(params: {
  conversationId: string
  sessionId?: string
  chainScope: "shared" | "private"
  items: CanonicalContextItem[]
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

  await transaction(async (client) => {
    const runQuery = client.query.bind(client) as QueryRunner
    const stateResult = await runQuery(
      `SELECT ${archiveIdColumn} AS archive_point_id
       FROM ${stateTable}
       WHERE ${stateIdColumn} = $1
       FOR UPDATE`,
      [stateIdValue]
    )

    const activeArchivePointId = stateResult.rows[0]?.archive_point_id || null
    const activeArchivePoint = activeArchivePointId
      ? await loadArchivePoint(activeArchivePointId, runQuery)
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

    const deltaFrames = await buildArchiveFrames(itemsToArchive)
    const frames = [...(activeArchivePoint?.frames || []), ...deltaFrames]
    if (frames.length === 0) {
      return
    }

    const archivePointResult = await runQuery(
      `INSERT INTO context_archive_points
         (conversation_id, session_id, chain_scope, parent_archive_point_id, covers_until_sequence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        params.conversationId,
        params.chainScope === "private" ? params.sessionId || null : null,
        params.chainScope,
        activeArchivePointId,
        targetCoverage,
        JSON.stringify({
          strategyKey: "lossless_archive_v1",
          appendedItemCount: itemsToArchive.length,
          totalFrameCount: frames.length,
        }),
      ]
    )

    const archivePointId = archivePointResult.rows[0]?.id
    if (!archivePointId) {
      return
    }

    await insertArchiveFrames(runQuery, archivePointId, frames)

    const compactionRunResult = await runQuery(
      `INSERT INTO context_compaction_runs
         (conversation_id, session_id, chain_scope, strategy_key, base_archive_point_id, output_archive_point_id, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)
       RETURNING id`,
      [
        params.conversationId,
        params.chainScope === "private" ? params.sessionId || null : null,
        params.chainScope,
        "lossless_archive_v1",
        activeArchivePointId,
        archivePointId,
        JSON.stringify({
          appendedItemCount: itemsToArchive.length,
          targetCoverage,
        }),
      ]
    )

    const compactionRunId = compactionRunResult.rows[0]?.id
    if (compactionRunId) {
      if (activeArchivePointId) {
        await runQuery(
          `INSERT INTO context_compaction_run_inputs
             (run_id, input_kind, archive_point_id, metadata)
           VALUES ($1, 'archive_point', $2, $3)`,
          [
            compactionRunId,
            activeArchivePointId,
            JSON.stringify({ role: "base" }),
          ]
        )
      }

      await runQuery(
        `INSERT INTO context_compaction_run_inputs
           (run_id, input_kind, from_sequence, to_sequence, metadata)
         VALUES ($1, 'sequence_range', $2, $3, $4)`,
        [
          compactionRunId,
          activeCoverage + 1,
          targetCoverage,
          JSON.stringify({ appendedItemCount: itemsToArchive.length }),
        ]
      )
    }

    await runQuery(
      `UPDATE ${stateTable}
       SET ${archiveIdColumn} = $2,
           updated_at = NOW()
       WHERE ${stateIdColumn} = $1`,
      [stateIdValue, archivePointId]
    )
  })
}

async function loadActiveSharedArchivePoint(
  conversationId: string
): Promise<CanonicalArchivePoint | null> {
  await ensureConversationContextState(conversationId)
  const row = await db
    .selectFrom("conversation_context_states")
    .select("active_shared_archive_point_id")
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst()
  const archivePointId = row?.active_shared_archive_point_id
  return archivePointId ? loadArchivePoint(archivePointId) : null
}

async function loadActivePrivateArchivePoint(
  sessionId?: string
): Promise<CanonicalArchivePoint | null> {
  if (!sessionId) return null
  await ensureSessionContextState(sessionId)
  const row = await db
    .selectFrom("session_context_states")
    .select("active_private_archive_point_id")
    .where("session_id", "=", sessionId)
    .executeTakeFirst()
  const archivePointId = row?.active_private_archive_point_id
  return archivePointId ? loadArchivePoint(archivePointId) : null
}

function isCoveredByArchive(
  item: CanonicalContextItem,
  coversUntilSequence: number
) {
  return (
    typeof item.sequence === "number" && item.sequence <= coversUntilSequence
  )
}

export async function buildProviderContextWindow(params: {
  conversationId: string
  sessionId?: string
  items: CanonicalContextItem[]
  manifest?: ProviderContextManifest
}): Promise<ProviderContextWindow> {
  await Promise.all([
    maybeCompactChain({
      conversationId: params.conversationId,
      chainScope: "shared",
      items: params.items,
    }),
    maybeCompactChain({
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      chainScope: "private",
      items: params.items,
    }),
  ])

  const [sharedArchivePoint, privateArchivePoint] = await Promise.all([
    loadActiveSharedArchivePoint(params.conversationId),
    loadActivePrivateArchivePoint(params.sessionId),
  ])

  const sharedCoverage = sharedArchivePoint?.coversUntilSequence ?? 0
  const privateCoverage = privateArchivePoint?.coversUntilSequence ?? 0

  const sharedTailItems: CanonicalContextItem[] = []
  const privateTailItems: CanonicalContextItem[] = []
  const orderedTailItems: CanonicalContextItem[] = []

  for (const item of params.items) {
    const covered =
      item.scope === "shared"
        ? isCoveredByArchive(item, sharedCoverage)
        : isCoveredByArchive(item, privateCoverage)

    if (covered) continue

    if (item.scope === "shared") {
      sharedTailItems.push(item)
    } else {
      privateTailItems.push(item)
    }
    orderedTailItems.push(item)
  }

  return {
    manifest: params.manifest,
    sharedArchivePoint,
    sharedTailItems,
    privateArchivePoint,
    privateTailItems,
    orderedTailItems,
  }
}

export function buildAdHocProviderContextWindow(
  items: CanonicalContextItem[],
  manifest?: ProviderContextManifest
): ProviderContextWindow {
  return {
    manifest,
    sharedArchivePoint: null,
    sharedTailItems: items,
    privateArchivePoint: null,
    privateTailItems: [],
    orderedTailItems: items,
  }
}
