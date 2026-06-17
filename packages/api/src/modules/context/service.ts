import type { CanonicalContextItem, ConversationMessage } from "@synapse/shared"
import type {
  CanonicalArchiveFrame,
  ProviderContextManifest,
  ProviderContextWindow,
} from "@synapse/shared"
import { compileContextItemsToConversationMessages } from "../ai/context-compiler.js"
import {
  loadActivePrivateArchivePoint,
  loadActiveSharedArchivePoint,
  maybeCompactChain,
} from "./repo.js"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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
      buildArchiveFrames,
    }),
    maybeCompactChain({
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      chainScope: "private",
      items: params.items,
      buildArchiveFrames,
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
