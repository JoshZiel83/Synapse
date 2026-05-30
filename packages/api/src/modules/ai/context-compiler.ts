import type {
  CanonicalArchiveFrame,
  CanonicalContentBlock,
  ConversationMessage,
  ProviderContextManifest,
  ProviderContextWindow,
} from "@synapse/shared"
import {
  CONVERSATION_PARTICIPANT_TYPE,
  buildConversationMessageRef,
  textBlock,
} from "@synapse/shared"
import type {
  CanonicalContextItem,
  CanonicalContextTarget,
  ConversationEntityRef,
} from "@synapse/shared/types"

function xmlEscapeText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function xmlEscapeAttribute(value: string) {
  return xmlEscapeText(value).replace(/"/g, "&quot;")
}

function buildXmlAttributes(
  attributes: Record<string, string | number | boolean | undefined | null>
) {
  return Object.entries(attributes)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
    .map(([key, value]) => ` ${key}="${xmlEscapeAttribute(String(value))}"`)
    .join("")
}

function openXmlTag(
  tag: string,
  attributes: Record<string, string | number | boolean | undefined | null> = {}
) {
  return `<${tag}${buildXmlAttributes(attributes)}>`
}

function closeXmlTag(tag: string) {
  return `</${tag}>`
}

function selfClosingXmlTag(
  tag: string,
  attributes: Record<string, string | number | boolean | undefined | null> = {}
) {
  return `<${tag}${buildXmlAttributes(attributes)}/>`
}

function toXmlTextBlock(value: string) {
  return textBlock(value)
}

function formatContextTimestamp(timestamp?: string) {
  if (!timestamp) return ""
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ""
  return date.toISOString()
}

type XmlEntityLike = {
  participantId?: string
  participantType?: string
  name?: string
  title?: string
  role?: string
}

function compileEntityAttrs(prefix: string, entity?: XmlEntityLike) {
  if (!entity) return {}
  return {
    [`${prefix}ParticipantId`]: entity.participantId,
    [`${prefix}Type`]: entity.participantType,
    [`${prefix}Name`]: entity.name,
    [`${prefix}Title`]: entity.title,
    [`${prefix}Role`]: entity.role,
  }
}

function compileBodyBlocks(
  parts?: CanonicalContentBlock[]
): CanonicalContentBlock[] {
  if (!parts || parts.length === 0) {
    return [toXmlTextBlock("")]
  }

  const compiled: CanonicalContentBlock[] = []
  for (const part of parts) {
    if (part.type === "text") {
      compiled.push(toXmlTextBlock(xmlEscapeText(part.text)))
      continue
    }

    if (part.type === "mention") {
      compiled.push(
        toXmlTextBlock(
          selfClosingXmlTag("mention", {
            participantId: part.mention.participantId,
            participantType: part.mention.participantType,
            name: part.mention.name,
            title: part.mention.title,
            role: part.mention.role,
          })
        )
      )
      continue
    }

    compiled.push(
      toXmlTextBlock(
        selfClosingXmlTag("file-ref", {
          fileId: part.fileId,
          name: part.originalName,
          category: part.category,
          mimeType: part.mimeType,
        })
      )
    )
    compiled.push(part)
  }

  return compiled
}

function compileReplyPreviewBlocks(
  item: Extract<CanonicalContextItem, { kind: "message" }>
) {
  if (!item.replyTo) return []

  const ref =
    item.replyTo.ref ||
    (typeof item.replyTo.sequence === "number"
      ? buildConversationMessageRef(item.replyTo.sequence)
      : undefined)
  return [
    toXmlTextBlock(
      openXmlTag("reply_to", {
        ref,
        itemId: item.replyTo.itemId,
        sequence: item.replyTo.sequence,
        itemType: item.replyTo.itemType,
        subtype: item.replyTo.subtype,
        unavailable: item.replyTo.isUnavailable === true ? "true" : undefined,
        ...compileEntityAttrs("author", item.replyTo.author),
      })
    ),
    toXmlTextBlock(openXmlTag("preview")),
    toXmlTextBlock(xmlEscapeText(item.replyTo.previewText || "")),
    toXmlTextBlock(closeXmlTag("preview")),
    toXmlTextBlock(closeXmlTag("reply_to")),
  ]
}

function compileRestrictedAudience(
  targets?: Array<CanonicalContextTarget | undefined>
) {
  const resolved = (targets || []).filter(
    (target): target is CanonicalContextTarget => Boolean(target)
  )
  if (resolved.length === 0) return []

  return [
    toXmlTextBlock(openXmlTag("restricted_audience")),
    ...resolved.map((target) =>
      toXmlTextBlock(
        selfClosingXmlTag("participant", {
          participantId: target.participantId,
          participantType: target.participantType,
          name: target.name,
        })
      )
    ),
    toXmlTextBlock(closeXmlTag("restricted_audience")),
  ]
}

function compileMessageItem(
  item: Extract<CanonicalContextItem, { kind: "message" }>
): ConversationMessage {
  const ref =
    item.itemRef ||
    (typeof item.sequence === "number"
      ? buildConversationMessageRef(item.sequence)
      : undefined)
  const content: CanonicalContentBlock[] = [
    toXmlTextBlock(
      openXmlTag("message", {
        ref,
        itemId: item.itemId,
        sequence: item.sequence,
        createdAt: formatContextTimestamp(item.createdAt),
        scope: item.scope,
        surface: item.surface,
        role: item.role,
        subtype: item.messageType,
        replyable: item.replyable === true ? "true" : undefined,
        ...compileEntityAttrs("author", item.author),
      })
    ),
    ...compileReplyPreviewBlocks(item),
    ...compileRestrictedAudience(item.targets),
    toXmlTextBlock(openXmlTag("body")),
    ...compileBodyBlocks(item.parts),
    toXmlTextBlock(closeXmlTag("body")),
    toXmlTextBlock(closeXmlTag("message")),
  ]

  if (item.role === "assistant" && item.author?.isSelf) {
    return {
      role: "assistant",
      content,
    }
  }

  return {
    role: "user",
    content,
  }
}

function compileEventItem(
  item: Extract<CanonicalContextItem, { kind: "event" }>
): ConversationMessage {
  const ref =
    item.itemRef ||
    (typeof item.sequence === "number"
      ? buildConversationMessageRef(item.sequence)
      : undefined)
  const payloadText =
    item.eventPayload && Object.keys(item.eventPayload).length > 0
      ? JSON.stringify(item.eventPayload)
      : ""
  return {
    role: "user",
    content: [
      toXmlTextBlock(
        openXmlTag("event", {
          ref,
          itemId: item.itemId,
          sequence: item.sequence,
          createdAt: formatContextTimestamp(item.createdAt),
          eventType: item.eventType,
          scope: item.scope,
          surface: item.surface,
          timelinePolicy: item.timelinePolicy,
          contextPolicy: item.contextPolicy,
          replyable: item.replyable === true ? "true" : undefined,
          ...compileEntityAttrs("author", item.author),
        })
      ),
      ...compileRestrictedAudience(item.targets),
      toXmlTextBlock(openXmlTag("event_payload")),
      toXmlTextBlock(xmlEscapeText(payloadText)),
      toXmlTextBlock(closeXmlTag("event_payload")),
      toXmlTextBlock(openXmlTag("body")),
      ...compileBodyBlocks(item.parts),
      toXmlTextBlock(closeXmlTag("body")),
      toXmlTextBlock(closeXmlTag("event")),
    ],
  }
}

function compileSystemNoticeItem(
  item: Extract<CanonicalContextItem, { kind: "system_notice" }>
): ConversationMessage {
  return {
    role: "user",
    content: [
      toXmlTextBlock(
        openXmlTag("system_notice", {
          itemId: item.itemId,
          noticeType: item.noticeType,
          scope: item.scope,
          surface: item.surface,
          createdAt: formatContextTimestamp(item.createdAt),
        })
      ),
      toXmlTextBlock(openXmlTag("body")),
      ...compileBodyBlocks(item.parts),
      toXmlTextBlock(closeXmlTag("body")),
      toXmlTextBlock(closeXmlTag("system_notice")),
    ],
  }
}

function compileSummaryItem(
  item: Extract<CanonicalContextItem, { kind: "summary" }>
): ConversationMessage {
  return {
    role: "user",
    content: [
      toXmlTextBlock(
        openXmlTag("summary", {
          itemId: item.itemId,
          summaryType: item.summaryType,
          scope: item.scope,
          surface: item.surface,
          createdAt: formatContextTimestamp(item.createdAt),
        })
      ),
      toXmlTextBlock(openXmlTag("body")),
      ...compileBodyBlocks(item.parts),
      toXmlTextBlock(closeXmlTag("body")),
      toXmlTextBlock(closeXmlTag("summary")),
    ],
  }
}

function compileMemoryRecallItem(
  item: Extract<CanonicalContextItem, { kind: "memory_recall" }>
): ConversationMessage {
  const content: CanonicalContentBlock[] = [
    toXmlTextBlock(
      openXmlTag("memory_recall", {
        recallType: item.recallType,
        scope: item.scope,
        surface: item.surface,
      })
    ),
  ]

  for (const memory of item.memories) {
    content.push(
      toXmlTextBlock(
        openXmlTag("memory", {
          memoryId: memory.id,
          ownerKind: memory.owner.kind,
          scopeKind: memory.scope?.kind,
          namespaceKey: memory.namespaceKey,
          category: memory.category,
          importance: memory.importance,
          confidence: memory.confidence,
          textDigest: memory.textDigest,
        })
      ),
      toXmlTextBlock(openXmlTag("body")),
      ...compileBodyBlocks(memory.contentBlocks),
      toXmlTextBlock(closeXmlTag("body")),
      toXmlTextBlock(closeXmlTag("memory"))
    )
  }

  content.push(toXmlTextBlock(closeXmlTag("memory_recall")))
  return {
    role: "user",
    content,
  }
}

function compileManifestMessage(
  manifest: ProviderContextManifest
): ConversationMessage {
  const content: CanonicalContentBlock[] = [
    toXmlTextBlock(
      openXmlTag("conversation_manifest", {
        conversationId: manifest.conversationId,
        kind: manifest.conversationKind,
        im: manifest.isImConversation ? "true" : "false",
        selfParticipantId: manifest.selfParticipantId,
        selfActorId: manifest.selfActorId,
      })
    ),
    toXmlTextBlock(openXmlTag("participants")),
  ]

  for (const participant of manifest.participants) {
    const isSelf =
      (manifest.selfParticipantId &&
        participant.participantId === manifest.selfParticipantId) ||
      (participant.participantType === CONVERSATION_PARTICIPANT_TYPE.ACTOR &&
        participant.id === manifest.selfActorId)
    content.push(
      toXmlTextBlock(
        selfClosingXmlTag("participant", {
          participantId: participant.participantId,
          participantType: participant.participantType,
          name: participant.name,
          title: participant.title,
          role: participant.role,
          isSelf: isSelf ? "true" : undefined,
        })
      )
    )
  }

  content.push(
    toXmlTextBlock(closeXmlTag("participants")),
    toXmlTextBlock(closeXmlTag("conversation_manifest"))
  )
  return {
    role: "user",
    content,
  }
}

function compileArchiveFrameToConversationMessages(
  frame: CanonicalArchiveFrame
): ConversationMessage[] {
  const parts = frame.parts || [toXmlTextBlock("")]

  switch (frame.role) {
    case "assistant":
      return [
        {
          role: "assistant",
          content: parts,
          toolCalls:
            frame.toolCalls && frame.toolCalls.length > 0
              ? frame.toolCalls
              : undefined,
        },
      ]

    case "tool":
      if (frame.toolResults && frame.toolResults.length > 0) {
        return [
          {
            role: "tool_result",
            results: frame.toolResults,
          },
        ]
      }
      return [
        {
          role: "user",
          content: parts,
        },
      ]

    case "system":
    case "user":
    default:
      return [
        {
          role: "user",
          content: parts,
        },
      ]
  }
}

export async function compressContextItems(
  items: CanonicalContextItem[]
): Promise<CanonicalContextItem[]> {
  return items
}

export async function compressContextWindow(
  window: ProviderContextWindow
): Promise<ProviderContextWindow> {
  return window
}

export async function compileContextItemsToConversationMessages(
  items: CanonicalContextItem[]
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = []

  for (const item of items) {
    switch (item.kind) {
      case "system_notice":
        messages.push(compileSystemNoticeItem(item))
        break

      case "event":
        messages.push(compileEventItem(item))
        break

      case "message":
        messages.push(compileMessageItem(item))
        break

      case "tool_call_batch":
        messages.push({
          role: "assistant",
          content: item.content && item.content.length > 0 ? item.content : [],
          toolCalls: item.toolCalls,
        })
        break

      case "tool_result_batch":
        messages.push({
          role: "tool_result",
          results: item.toolResults,
        })
        break

      case "summary":
        messages.push(compileSummaryItem(item))
        break

      case "memory_recall":
        messages.push(compileMemoryRecallItem(item))
        break
    }
  }

  return messages
}

export async function compileContextWindowToConversationMessages(
  window: ProviderContextWindow
): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = []

  if (window.manifest) {
    messages.push(compileManifestMessage(window.manifest))
  }

  if (window.sharedArchivePoint) {
    for (const frame of window.sharedArchivePoint.frames) {
      messages.push(...compileArchiveFrameToConversationMessages(frame))
    }
  }

  if (window.privateArchivePoint) {
    for (const frame of window.privateArchivePoint.frames) {
      messages.push(...compileArchiveFrameToConversationMessages(frame))
    }
  }

  const orderedTailItems =
    window.orderedTailItems.length > 0
      ? window.orderedTailItems
      : [...window.sharedTailItems, ...window.privateTailItems]

  const tailMessages =
    await compileContextItemsToConversationMessages(orderedTailItems)
  messages.push(...tailMessages)

  return messages
}
