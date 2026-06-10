import {
  isGroupConversationKind,
  isThreadConversationKind,
  type SessionMessage,
} from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"
import { parseSessionCollaborationState } from "./collaboration-state.js"
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

/**
 * Parse the `collaboration_state` JSONB. Business JSON: must be a valid object
 * (throws otherwise) before it reaches business logic. Kept here as the decode
 * boundary for the session presenter.
 */
function parseCollaborationStateJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("collaboration_state must be a JSON object")
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `collaboration_state must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("collaboration_state must be an object")
  }
  return value as Record<string, unknown>
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
    collaborationState: parseSessionCollaborationState(
      parseCollaborationStateJson(row.collaborationState)
    ),
    isGroupConversation: isGroupConversationKind(row.conversationKind),
    hasThreadContext: isThreadConversationKind(row.conversationKind),
  }
  return presented
}

export function presentSessionMessageRole(
  row: Pick<SessionMessageItemRow, "role" | "subtype">
): SessionMessage["role"] {
  if (row.subtype === "tool_result" || row.role === "tool") {
    return "tool_result"
  }
  return row.role
}

function buildMetadataFromItem(item: { metadata?: unknown }) {
  return typeof item.metadata === "string"
    ? JSON.parse(item.metadata)
    : { ...((item.metadata as Record<string, unknown>) || {}) }
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
    metadata: buildMetadataFromItem(row),
    createdAt: serializeInstant(row.createdAt) as SessionMessage["createdAt"],
  } as SessionMessage
}
