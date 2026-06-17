import {
  CONVERSATION_MESSAGE_SUBTYPE,
  isGroupConversationKind,
  isThreadConversationKind,
  type SessionMessage,
} from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"
import type { IsoInstantString } from "../../infrastructure/datetime.js"
import { itemPartsToCanonicalContentBlocks } from "../chat/message-content.js"
import type {
  ConversationItemPartRow,
  SessionMessageItemRow,
  SessionRow,
} from "./repo.types.js"

/**
 * Session presentation layer: DB rows -> outward session/message DTOs.
 * Owns the Date -> IsoInstantString encoding (guard-layering r3) and the
 * row->view shaping (so service.ts carries no map*Row / serializeInstant).
 * See docs/architecture-boundary-refactor-master-plan.md §8.
 */

export function presentInstant(value: Date): IsoInstantString {
  return serializeInstant(value)
}

export function presentOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return value ? presentInstant(value) : undefined
}

export function presentSession(row: SessionRow | null) {
  if (!row) return null
  const presented = {
    ...row,
    conversationId: row.conversationId,
    conversationKind: row.conversationKind,
    isImConversation: Boolean(row.conversationIsIm),
    conversationTitle: row.conversationTitle,
    collaborationMode: row.collaborationMode || "default",
    activePlanApprovalTaskId: row.activePlanApprovalTaskId || undefined,
    collaborationState: row.collaborationState,
    isGroupConversation: isGroupConversationKind(row.conversationKind),
    hasThreadContext: isThreadConversationKind(row.conversationKind),
  }
  return presented
}

export function presentSessionMessageRole(
  row: Pick<SessionMessageItemRow, "role" | "subtype">
): SessionMessage["role"] {
  if (
    row.subtype === CONVERSATION_MESSAGE_SUBTYPE.TOOL_RESULT ||
    row.role === "tool"
  ) {
    return "tool_result"
  }
  return row.role
}

export function presentSessionMessage(
  row: SessionMessageItemRow,
  sessionId: string,
  parts: ConversationItemPartRow[]
): SessionMessage {
  return {
    id: row.id,
    sessionId,
    conversationId: row.conversationId,
    sequence: row.sequence,
    workspaceId: row.workspaceId,
    role: presentSessionMessageRole(row),
    contentBlocks: itemPartsToCanonicalContentBlocks(parts || []),
    fromActorId: row.fromActorId || undefined,
    fromWorkspaceMemberId: row.fromWorkspaceMemberId || undefined,
    metadata: row.metadata,
    createdAt: serializeInstant(row.createdAt) as SessionMessage["createdAt"],
  } as SessionMessage
}
