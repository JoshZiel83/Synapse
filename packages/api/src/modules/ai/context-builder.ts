import type {
  ActorRuntimeWakeup,
  AssistantToolHistory,
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  CanonicalFileCategory,
  CanonicalToolCall,
  CanonicalToolResult,
  ToolResultOrigin,
} from "@synapse/shared"
import {
  buildConversationMessageRef,
  CONVERSATION_MESSAGE_SUBTYPE,
  isToolResultOrigin,
  parseJsonObject,
  parseJsonObjectOrUndefined,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import type {
  CanonicalContextAuthor,
  CanonicalContextItem,
  CanonicalContextTarget,
} from "@synapse/shared/types"
import {
  extractText,
  fileRefBlock,
  normalizeCanonicalContentBlocks,
  textBlock,
  textBlocks,
} from "@synapse/shared"
import { renderConversationEventContextBlocks } from "../chat/event-registry.js"
import {
  getToolCallsForSession,
  getToolResultsByToolCallIds,
  getToolResultPartsByResultIds,
} from "./repo.js"
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"

/**
 * Read the authoritative tool result data for a session from the
 * tool_calls / tool_results / tool_result_parts tables and return a map
 * keyed by provider_call_id (and also by tool_calls.id as fallback) →
 * CanonicalToolResult.
 *
 * Pre-load this once per session before calling buildSessionContextItems
 * with `executionToolResults: map` so tool_result/child_result rows use
 * the execution tables as source of truth instead of falling back to the
 * session_message.metadata projection (the Phase 5 plan requirement).
 *
 * For each tool_call we take the LATEST tool_results row (highest
 * result_index) and assemble the canonical content from
 * tool_result_parts via itemPartsToCanonicalContentBlocks.
 */
export async function loadExecutionToolResultsForSession(
  sessionId: string
): Promise<Map<string, CanonicalToolResult>> {
  const out = new Map<string, CanonicalToolResult>()
  if (!sessionId) return out

  const toolCalls = await getToolCallsForSession(sessionId)
  if (toolCalls.length === 0) return out

  const callsById = new Map<
    string,
    { id: string; providerCallId: string | null; toolName: string }
  >()
  for (const row of toolCalls) {
    callsById.set(row.id, row)
  }
  const toolCallIds = [...callsById.keys()]

  // Take the latest tool_results row per tool_call (highest result_index).
  const results = await getToolResultsByToolCallIds(toolCallIds)
  const latestByCall = new Map<string, (typeof results)[number]>()
  for (const row of results) {
    if (!latestByCall.has(row.toolCallId)) latestByCall.set(row.toolCallId, row)
  }
  if (latestByCall.size === 0) return out

  const resultIds = [...latestByCall.values()].map((r) => r.id)
  const parts = await getToolResultPartsByResultIds(resultIds)
  const partsByResult = new Map<string, any[]>()
  for (const row of parts) {
    const arr = partsByResult.get(row.toolResultId) || []
    arr.push(row)
    partsByResult.set(row.toolResultId, arr)
  }

  for (const [toolCallId, resultRow] of latestByCall.entries()) {
    const call = callsById.get(toolCallId)
    if (!call) continue
    const meta = resultRow.metadata
    const contentBlocks = itemPartsToCanonicalContentBlocks(
      partsByResult.get(resultRow.id) || []
    )
    const origin: ToolResultOrigin = isToolResultOrigin(meta.origin)
      ? meta.origin
      : { kind: "system", registryKey: call.toolName }
    const structuredContent =
      meta.structuredContent && typeof meta.structuredContent === "object"
        ? (meta.structuredContent as Record<string, unknown>)
        : undefined
    const innerMetadata = extractInnerMetadata(meta)

    const canonical: CanonicalToolResult = {
      // Canonical toolCallId is ALWAYS the tool_calls.id (the internal UUID that
      // the assistant tool-call also carries as callId). providerCallId is
      // metadata only — never the pairing key, or a cross-turn replay would send
      // the provider-native id on the result while the assistant tool-call uses
      // the UUID, breaking reconcileToolPairing's exact match.
      toolCallId: call.id,
      toolName: call.toolName,
      content: contentBlocks,
      ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
      ...(resultRow.isError !== null && resultRow.isError !== undefined
        ? { isError: resultRow.isError }
        : {}),
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      origin,
      ...(innerMetadata ? { metadata: innerMetadata } : {}),
    }

    // Index by BOTH provider_call_id and the DB row id so callers that
    // wrote either to session_message.metadata.toolCallId can hit.
    if (call.providerCallId) out.set(call.providerCallId, canonical)
    out.set(call.id, canonical)
  }

  return out
}

type ContextAuthorParticipantRow = {
  id?: string
  actor_id?: string | null
  workspace_member_id?: string | null
  user_id?: string | null
  participant_name?: string | null
  user_name?: string | null
  display_name?: string | null
}

type ContextAuthorSourceRow = {
  authorParticipant?: ContextAuthorParticipantRow | null
  author_participant?: ContextAuthorParticipantRow | null
  authorParticipantId?: string | null
  author_participant_id?: string | null
  author_actor_id?: string | null
  author_user_id?: string | null
  author_name?: string | null
  role?: string | null
  sessionId?: string | null
  session_id?: string | null
}

function mimeToCategory(mimeType: string): CanonicalFileCategory {
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("video/")) return "video"
  return "document"
}

function parseMetadata(metadata: unknown): Record<string, unknown> {
  return parseJsonObject(metadata)
}

function parseSizeBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return 0
}

export function itemPartsToCanonicalBlocks(
  parts: any[]
): CanonicalContentBlock[] {
  const blocks: CanonicalContentBlock[] = []

  for (const part of parts || []) {
    if (part.part_type === "text") {
      blocks.push(textBlock(part.text_value || ""))
      continue
    }

    if (part.part_type === "file_ref" && part.ref_sha256) {
      const metadata = parseMetadata(part.metadata)
      blocks.push(
        fileRefBlock({
          sha256: part.ref_sha256,
          path:
            part.ref_path ??
            (typeof metadata.path === "string" ? metadata.path : undefined),
          mimeType:
            part.mime_type ||
            (typeof metadata.mimeType === "string"
              ? metadata.mimeType
              : null) ||
            "application/octet-stream",
          name:
            part.name ||
            (typeof metadata.name === "string" ? metadata.name : undefined) ||
            "file",
          sizeBytes: parseSizeBytes(metadata.sizeBytes),
          category: (metadata.category as CanonicalFileCategory) || "document",
        })
      )
      continue
    }

    if (part.part_type === "json") {
      const payload = parseJsonObjectOrUndefined(part.json_value)
      if (!payload) continue
      const normalized = normalizeCanonicalContentBlocks([
        payload as CanonicalContentBlockInput,
      ])
      if (normalized.length > 0) {
        blocks.push(...normalized)
      }
    }
  }

  return blocks
}

function buildAuthor(
  row: ContextAuthorSourceRow,
  actorId?: string
): CanonicalContextAuthor | undefined {
  const authorParticipant = row.authorParticipant || row.author_participant

  if (authorParticipant?.actor_id || row.author_actor_id) {
    const participantId =
      authorParticipant?.id ||
      row.authorParticipantId ||
      row.author_participant_id
    const resolvedActorId = authorParticipant?.actor_id || row.author_actor_id
    return {
      participantId: participantId || undefined,
      participantType: "actor",
      actorId: resolvedActorId || undefined,
      sessionId: row.sessionId || row.session_id || undefined,
      name:
        authorParticipant?.participant_name ||
        authorParticipant?.display_name ||
        row.author_name ||
        undefined,
      isSelf: resolvedActorId === actorId,
    }
  }

  if (authorParticipant?.workspace_member_id || row.author_user_id) {
    return {
      participantId:
        authorParticipant?.id ||
        row.authorParticipantId ||
        row.author_participant_id ||
        undefined,
      participantType: "workspace_member",
      userId: authorParticipant?.user_id || row.author_user_id || undefined,
      sessionId: row.sessionId || row.session_id || undefined,
      name:
        authorParticipant?.user_name ||
        authorParticipant?.display_name ||
        row.author_name ||
        undefined,
      isSelf: false,
    }
  }

  if (row.role === "system") {
    return {
      participantId:
        authorParticipant?.id ||
        row.authorParticipantId ||
        row.author_participant_id ||
        undefined,
      participantType: "system",
      sessionId: row.sessionId || row.session_id || undefined,
      name: authorParticipant?.display_name || row.author_name || "System",
      isSelf: false,
    }
  }

  return undefined
}

function buildTargets(targets: any[]): CanonicalContextTarget[] | undefined {
  if (!targets || targets.length === 0) return undefined
  const built = targets.map((target) => ({
    participantId:
      target.participantId || target.participant_id || target.id || undefined,
    participantType: (target.participant_type ||
      "system") as CanonicalContextTarget["participantType"],
    actorId: target.actor_id || target.actorId || undefined,
    userId: target.user_id || target.userId || undefined,
    name:
      target.user_name ||
      target.participant_name ||
      target.display_name ||
      undefined,
  }))
  return built.length > 0 ? built : undefined
}

function buildContextItemRef(item: {
  sequence?: number | string
  scope?: string
  surface?: string
}) {
  const sequence =
    typeof item.sequence === "number"
      ? item.sequence
      : typeof item.sequence === "string"
        ? Number(item.sequence)
        : NaN
  if (
    !Number.isFinite(sequence) ||
    item.scope !== "shared" ||
    item.surface !== "visible"
  ) {
    return undefined
  }
  return buildConversationMessageRef(sequence)
}

export function conversationItemToContextItem(
  item: any,
  actorId: string
): CanonicalContextItem | null {
  const parts = Array.isArray(item.contentBlocks)
    ? normalizeCanonicalContentBlocks(
        item.contentBlocks as CanonicalContentBlockInput[]
      )
    : itemPartsToCanonicalBlocks(item.parts || [])
  const metadata = parseMetadata(item.metadata)
  const eventPayload = parseMetadata(item.eventPayload ?? item.event_payload)
  const author = buildAuthor(item, actorId)
  const targets = buildTargets(
    item.contextTargets?.length > 0
      ? item.contextTargets
      : item.context_targets?.length > 0
        ? item.context_targets
        : item.restrictedAudience || item.targets || []
  )
  const itemType = item.itemType || item.item_type
  const conversationId = item.conversationId || item.conversation_id
  const sessionId = item.sessionId || item.session_id
  const turnId = item.turnId || item.turn_id
  const createdAt = item.createdAt || item.created_at
  const eventTimelinePolicy =
    item.eventTimelinePolicy || item.event_timeline_policy
  const eventContextPolicy =
    item.eventContextPolicy || item.event_context_policy
  const itemRef = buildContextItemRef({
    sequence: item.sequence,
    scope: item.scope || "shared",
    surface: item.surface || "visible",
  })

  if (metadata.excludeFromContext === true) {
    return null
  }

  if (
    itemType === "message" &&
    item.subtype === CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE
  ) {
    return null
  }

  if (itemType === "event" || item.role === "system") {
    const contextPolicy = (eventContextPolicy || "shared") as
      | "none"
      | "shared"
      | "actor_private"
      | "targeted_members"
    if (contextPolicy === "none") {
      return null
    }

    const renderedContextParts = renderConversationEventContextBlocks(
      item.subtype || "event",
      eventPayload
    )
    const eventParts =
      renderedContextParts && renderedContextParts.length > 0
        ? renderedContextParts
        : parts
    return {
      kind: "event",
      itemId: item.id,
      itemRef,
      replyable: Boolean(itemRef),
      conversationId,
      sessionId: sessionId || undefined,
      turnId: turnId || undefined,
      sequence: item.sequence,
      createdAt: createdAt ? assertIsoInstant(createdAt) : undefined,
      scope: item.scope || "shared",
      surface: item.surface || "visible",
      eventType: item.subtype || "event",
      eventPayload,
      timelinePolicy: eventTimelinePolicy || undefined,
      contextPolicy,
      author,
      targets,
      parts: eventParts.length > 0 ? eventParts : textBlocks(""),
      metadata,
    }
  }

  return {
    kind: "message",
    itemId: item.id,
    itemRef,
    replyable: Boolean(itemRef),
    conversationId,
    sessionId: sessionId || undefined,
    turnId: turnId || undefined,
    sequence: item.sequence,
    createdAt: createdAt ? assertIsoInstant(createdAt) : undefined,
    scope: item.scope || "shared",
    surface: item.surface || "visible",
    messageType: item.subtype || "chat",
    role: item.role || "user",
    author,
    targets,
    replyTo: item.replyTo || item.reply_to,
    parts: parts.length > 0 ? parts : textBlocks(""),
    metadata,
  }
}

function buildInterruptNotice(interrupt: {
  type: string
  content: string
  contentBlocks?: CanonicalContentBlock[]
}): CanonicalContextItem {
  const parts =
    interrupt.contentBlocks && interrupt.contentBlocks.length > 0
      ? interrupt.contentBlocks
      : textBlocks(interrupt.content)
  return {
    kind: "system_notice",
    noticeType: "interrupt",
    scope: "private",
    surface: "internal",
    parts,
    metadata: {
      interruptType: interrupt.type,
    },
  }
}

function buildWakeupNotice(
  wakeup: Pick<
    ActorRuntimeWakeup,
    "wakeupId" | "sourceType" | "sourceName" | "summary" | "reasonText"
  >
): CanonicalContextItem {
  const title = wakeup.sourceName
    ? `${wakeup.sourceType} from ${wakeup.sourceName}`
    : wakeup.sourceType
  const reason = wakeup.reasonText?.trim() || wakeup.summary.trim()
  return {
    kind: "system_notice",
    itemId: `wakeup:${wakeup.wakeupId}`,
    scope: "private",
    surface: "internal",
    // noticeType identifies this as a wakeup notice; the body holds the
    // raw reason without a bracket-prefix. compileSystemNoticeItem wraps
    // these in <system_notice noticeType="wakeup"> so the LLM has the
    // semantic tag without us injecting it into the text payload.
    noticeType: "wakeup",
    parts: textBlocks(reason),
    metadata: {
      wakeupId: wakeup.wakeupId,
      sourceType: wakeup.sourceType,
      sourceName: wakeup.sourceName,
      summary: wakeup.summary,
      reasonText: wakeup.reasonText,
      title,
    },
  }
}

function expandToolHistoryContextItems(
  items: CanonicalContextItem[],
  messageId: string,
  conversationId: string | undefined,
  sessionId: string,
  sequence: number | undefined,
  finalText: string,
  toolHistory: AssistantToolHistory
) {
  if (!toolHistory.rounds || toolHistory.rounds.length === 0) {
    if (finalText) {
      items.push({
        kind: "message",
        itemId: messageId,
        conversationId,
        sessionId,
        sequence,
        scope: "shared",
        surface: "visible",
        messageType: "assistant_message",
        role: "assistant",
        author: {
          participantType: "actor",
          sessionId,
          isSelf: true,
        },
        parts: textBlocks(finalText),
      })
    }
    return
  }

  for (
    let roundIndex = 0;
    roundIndex < toolHistory.rounds.length;
    roundIndex++
  ) {
    const round = toolHistory.rounds[roundIndex]
    const toolCalls: CanonicalToolCall[] = round.toolCalls.map((toolCall) => ({
      callId: toolCall.callId,
      providerCallId: toolCall.providerCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      metadata: toolCall.metadata,
    }))
    const toolResults: CanonicalToolResult[] = round.toolResults.map(
      (toolResult) => {
        const item: CanonicalToolResult = {
          toolCallId: toolResult.toolCallId,
          providerCallId: toolResult.providerCallId,
          toolName: toolResult.toolName,
          content: toolResult.content,
          isError: toolResult.isError,
          origin: toolResult.origin,
          metadata: toolResult.metadata,
        }
        // Phase 1+ first-class fields — carry them through, otherwise the
        // context window forgets where the result came from and what its
        // structured sidecar said. Was missed in the original Phase 5.
        if (toolResult.structuredContent !== undefined) {
          item.structuredContent = toolResult.structuredContent
        }
        if (toolResult.origin !== undefined) {
          item.origin = toolResult.origin
        }
        return item
      }
    )

    items.push({
      kind: "tool_call_batch",
      itemId: `${messageId}:tool-call:${roundIndex}`,
      conversationId,
      sessionId,
      sequence,
      scope: "private",
      surface: "internal",
      role: "assistant",
      author: {
        participantType: "actor",
        sessionId,
        isSelf: true,
      },
      content: round.content,
      toolCalls,
    })

    if (toolResults.length > 0) {
      items.push({
        kind: "tool_result_batch",
        itemId: `${messageId}:tool-result:${roundIndex}`,
        conversationId,
        sessionId,
        sequence,
        scope: "private",
        surface: "internal",
        toolResults,
      })
    }
  }

  if (finalText) {
    items.push({
      kind: "message",
      itemId: messageId,
      conversationId,
      sessionId,
      sequence,
      scope: "shared",
      surface: "visible",
      messageType: "assistant_message",
      role: "assistant",
      author: {
        participantType: "actor",
        sessionId,
        isSelf: true,
      },
      parts: textBlocks(finalText),
    })
  }
}

interface SessionMessageRow {
  id: string
  sessionId: string
  conversationId?: string
  sequence?: number
  createdAt?: import("@synapse/shared").Timestamp
  role: string
  contentBlocks: CanonicalContentBlock[]
  metadata: Record<string, unknown> | string
}

function sessionMessageText(message: SessionMessageRow) {
  return extractText(message.contentBlocks || [])
}

// Keys that ai/index.ts writes flat into tool_results.metadata alongside
// the original CanonicalToolResult.metadata fields. When rehydrating, we
// pull them out individually and the residual is the original tool metadata.
const TOOL_RESULT_METADATA_RESERVED_KEYS = new Set([
  "toolCallId",
  "toolName",
  "providerCallId",
  "isError",
  "origin",
  "structuredContent",
])

function extractInnerMetadata(
  meta: Record<string, unknown>
): Record<string, unknown> | undefined {
  const residual: Record<string, unknown> = {}
  let hasAny = false
  for (const [key, value] of Object.entries(meta)) {
    if (TOOL_RESULT_METADATA_RESERVED_KEYS.has(key)) continue
    residual[key] = value
    hasAny = true
  }
  return hasAny ? residual : undefined
}

// Convert a session_message row with role="tool_result" into a structured
// CanonicalToolResultBatchContextItem. Writers persist
// toolCallId/toolName/origin/structuredContent/isError under msg.metadata so
// the batch can be reconstructed without extra DB lookups.
function buildToolResultBatchFromSessionMessage(
  msg: SessionMessageRow,
  meta: Record<string, unknown>,
  options: {
    scope: "shared" | "private"
    surface: "visible" | "internal"
    // Override the synthetic toolName/origin used when the writer didn't
    // preserve structured identifiers in metadata.
    defaultToolName?: string
    defaultOrigin?: ToolResultOrigin
    // Authoritative tool result data pre-loaded from
    // tool_calls / tool_results / tool_result_parts. Keyed by the
    // provider_call_id (or LLM-side callId), which matches
    // session_message.metadata.toolCallId. When the key resolves, we use
    // the execution-table data as source of truth instead of the
    // metadata-based reconstruction.
    executionToolResults?: Map<string, CanonicalToolResult>
  }
): CanonicalContextItem {
  const metaToolCallId =
    typeof meta.toolCallId === "string" && meta.toolCallId.length > 0
      ? (meta.toolCallId as string)
      : undefined
  const metaProviderCallId =
    typeof meta.providerCallId === "string" && meta.providerCallId.length > 0
      ? (meta.providerCallId as string)
      : undefined

  // Prefer the execution-tables row when available (Phase 5 plan):
  // tool_calls/tool_results/tool_result_parts are the canonical source of
  // truth for tool results; session_message.metadata is a cached projection
  // used when the caller doesn't pre-load the execution data.
  const executionMatch =
    options.executionToolResults &&
    ((metaToolCallId && options.executionToolResults.get(metaToolCallId)) ||
      (metaProviderCallId &&
        options.executionToolResults.get(metaProviderCallId)) ||
      undefined)

  if (executionMatch) {
    return {
      kind: "tool_result_batch",
      itemId: msg.id,
      conversationId: msg.conversationId,
      sessionId: msg.sessionId,
      sequence: msg.sequence,
      createdAt: msg.createdAt,
      scope: options.scope,
      surface: options.surface,
      toolResults: [executionMatch],
    }
  }

  const toolCallId = metaToolCallId || `legacy-tool-call:${msg.id}`
  const toolName =
    typeof meta.toolName === "string" && meta.toolName.length > 0
      ? (meta.toolName as string)
      : options.defaultToolName || "unknown_tool"
  const providerCallId = metaProviderCallId
  const isError =
    typeof meta.isError === "boolean" ? (meta.isError as boolean) : undefined
  const structuredContent =
    meta.structuredContent && typeof meta.structuredContent === "object"
      ? (meta.structuredContent as Record<string, unknown>)
      : undefined
  const origin = isToolResultOrigin(meta.origin)
    ? meta.origin
    : options.defaultOrigin ||
      ({ kind: "system", registryKey: toolName } as const)
  // The writer (ai/index.ts) flattens the original tool metadata into
  // tool_results.metadata next to the reserved keys above (no
  // `innerMetadata` wrapper). Recover by stripping the reserved keys.
  const innerMetadata = extractInnerMetadata(meta)

  const toolResult: CanonicalToolResult = {
    toolCallId,
    providerCallId,
    toolName,
    content: msg.contentBlocks,
    isError,
    structuredContent,
    origin,
    metadata: innerMetadata,
  }

  return {
    kind: "tool_result_batch",
    itemId: msg.id,
    conversationId: msg.conversationId,
    sessionId: msg.sessionId,
    sequence: msg.sequence,
    createdAt: msg.createdAt,
    scope: options.scope,
    surface: options.surface,
    toolResults: [toolResult],
  }
}

export function buildSessionContextItems(
  sessionMessages: SessionMessageRow[],
  options: {
    crossTurnToolHistory?: boolean
    interrupts?: {
      type: string
      content: string
      contentBlocks?: CanonicalContentBlock[]
    }[]
    wakeups?: Pick<
      ActorRuntimeWakeup,
      "wakeupId" | "sourceType" | "sourceName" | "summary" | "reasonText"
    >[]
    // Phase 8+ review: when present, this map (keyed by provider_call_id or
    // the LLM-side callId) is the AUTHORITATIVE source of truth for tool
    // results — pre-loaded from the tool_calls / tool_results /
    // tool_result_parts tables by the caller via
    // loadExecutionToolResultsForSession(). Tool_result session_messages
    // first look here; the metadata-based reconstruction is a fallback for
    // rows whose execution table data was lost or never written.
    executionToolResults?: Map<string, CanonicalToolResult>
  } = {}
): CanonicalContextItem[] {
  const items: CanonicalContextItem[] = []

  if (options.wakeups) {
    items.push(...options.wakeups.map(buildWakeupNotice))
  }

  for (const msg of sessionMessages) {
    const meta = parseMetadata(msg.metadata)
    if (meta.excludeFromContext === true) {
      continue
    }
    switch (msg.role) {
      case "user": {
        items.push({
          kind: "message",
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          createdAt: msg.createdAt,
          scope: "shared",
          surface: "visible",
          messageType: "user_message",
          role: "user",
          author: {
            participantType: "workspace_member",
            sessionId: msg.sessionId,
            isSelf: false,
          },
          parts: msg.contentBlocks,
          metadata: meta,
        })
        break
      }

      case "assistant": {
        if (options.crossTurnToolHistory && meta.toolHistory) {
          expandToolHistoryContextItems(
            items,
            msg.id,
            msg.conversationId,
            msg.sessionId,
            msg.sequence,
            sessionMessageText(msg),
            meta.toolHistory as AssistantToolHistory
          )
        } else {
          items.push({
            kind: "message",
            itemId: msg.id,
            conversationId: msg.conversationId,
            sessionId: msg.sessionId,
            sequence: msg.sequence,
            createdAt: msg.createdAt,
            scope: "shared",
            surface: "visible",
            messageType: "assistant_message",
            role: "assistant",
            author: {
              participantType: "actor",
              sessionId: msg.sessionId,
              isSelf: true,
            },
            parts: msg.contentBlocks,
            metadata: meta,
          })
        }
        break
      }

      case "system": {
        items.push({
          kind: "system_notice",
          itemId: msg.id,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          sequence: msg.sequence,
          createdAt: msg.createdAt,
          scope: "shared",
          surface: "visible",
          noticeType: "task_instruction",
          // Body holds the raw instruction; compileSystemNoticeItem wraps
          // it in <system_notice noticeType="task_instruction"> so the
          // model can read the semantic tag from the XML, not from a
          // baked-in text prefix.
          parts: msg.contentBlocks,
          metadata: meta,
        })
        break
      }

      case "child_result": {
        items.push(
          buildToolResultBatchFromSessionMessage(msg, meta, {
            scope: "private",
            surface: "internal",
            defaultToolName: "child_actor",
            defaultOrigin: { kind: "system", registryKey: "child_actor" },
            executionToolResults: options.executionToolResults,
          })
        )
        break
      }

      case "tool_result": {
        items.push(
          buildToolResultBatchFromSessionMessage(msg, meta, {
            scope: "private",
            surface: "internal",
            executionToolResults: options.executionToolResults,
          })
        )
        break
      }
    }
  }

  if (options.interrupts) {
    items.push(...options.interrupts.map(buildInterruptNotice))
  }

  return items
}

export function buildConversationContextItems(params: {
  visibleItems: any[]
  actorId: string
  sessionMessages: SessionMessageRow[]
  interrupts?: {
    type: string
    content: string
    contentBlocks?: CanonicalContentBlock[]
  }[]
  wakeups?: Pick<
    ActorRuntimeWakeup,
    "wakeupId" | "sourceType" | "sourceName" | "summary" | "reasonText"
  >[]
  // Phase 10 symmetry with buildSessionContextItems — caller pre-loads
  // tool_calls/tool_results/tool_result_parts and passes them so the
  // execution tables are the source of truth for tool result rebuild.
  executionToolResults?: Map<string, CanonicalToolResult>
}) {
  const items: CanonicalContextItem[] = []

  if (params.wakeups) {
    items.push(...params.wakeups.map(buildWakeupNotice))
  }

  if (params.interrupts) {
    items.push(...params.interrupts.map(buildInterruptNotice))
  }

  for (const item of params.visibleItems) {
    const contextItem = conversationItemToContextItem(item, params.actorId)
    if (contextItem) items.push(contextItem)
  }

  for (const sessionMessage of params.sessionMessages) {
    // Phase 10 symmetry: both tool_result AND child_result session_messages
    // route through buildToolResultBatchFromSessionMessage, matching the
    // buildSessionContextItems branches. Previously child_result was
    // silently skipped in the group/thread path.
    if (sessionMessage.role === "tool_result") {
      items.push(
        buildToolResultBatchFromSessionMessage(
          sessionMessage,
          parseMetadata(sessionMessage.metadata),
          {
            scope: "private",
            surface: "internal",
            executionToolResults: params.executionToolResults,
          }
        )
      )
    } else if (sessionMessage.role === "child_result") {
      items.push(
        buildToolResultBatchFromSessionMessage(
          sessionMessage,
          parseMetadata(sessionMessage.metadata),
          {
            scope: "private",
            surface: "internal",
            defaultToolName: "child_actor",
            defaultOrigin: { kind: "system", registryKey: "child_actor" },
            executionToolResults: params.executionToolResults,
          }
        )
      )
    }
  }

  const lastSequence =
    params.visibleItems.length > 0
      ? params.visibleItems[params.visibleItems.length - 1].sequence
      : 0
  return { items, lastSequence }
}

export function buildAdHocContextItems(
  messages: Array<{
    role: "user" | "assistant"
    content: CanonicalContentBlock[]
  }>
): CanonicalContextItem[] {
  return messages.map((message, index) => ({
    kind: "message",
    itemId: `adhoc:${index}`,
    scope: "shared",
    surface: "visible",
    messageType: "adhoc",
    role: message.role,
    author: {
      participantType:
        message.role === "assistant" ? "actor" : "workspace_member",
      isSelf: message.role === "assistant",
    },
    parts: message.content,
  }))
}
