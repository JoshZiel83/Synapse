import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"
import type { SessionCollaborationState } from "@synapse/shared/types"

/**
 * Session module DB-row types. Repo file: the only place in the session module
 * allowed to reference TableRow (guard-layering r2). See master plan §8.
 */

export type SessionRow = Omit<TableRow<"sessions">, "collaborationState"> & {
  collaborationState: SessionCollaborationState
  actorDisplayName?: string | null
  conversationKind?: string | null
  conversationIsIm?: unknown
  conversationTitle?: string | null
}

export type SessionDbRow = Omit<SessionRow, "collaborationState"> & {
  collaborationState: unknown
}

export type SessionMessageItemRow = {
  id: string
  sessionId: string | null
  conversationId: string
  sequence: number | string
  workspaceId: string
  subtype: string
  role: TableRow<"conversationItems">["role"]
  fromActorId: string | null
  fromWorkspaceMemberId: string | null
  createdAt: Date
  metadata: Record<string, unknown>
}

export type SessionMessageItemDbRow = Omit<
  SessionMessageItemRow,
  "metadata"
> & {
  metadata: unknown
}

export type ConversationItemPartRow = TableRow<"conversationItemParts">

// Runtime engine (session/runtime.ts) DB-row types. Tier-D engine: these named
// aliases keep the runtime helper free of the kysely TableRow/TableInsert alias.
export type ToolCallRow = Omit<
  TableRow<"toolCalls">,
  "normalizedInput" | "sourceSnapshot"
> & {
  normalizedInput: Record<string, unknown>
  sourceSnapshot: Record<string, unknown>
}
export type ToolCallDbRow = Omit<
  ToolCallRow,
  "normalizedInput" | "sourceSnapshot"
> & {
  normalizedInput: unknown
  sourceSnapshot: unknown
}
export type ToolResultRow = Omit<TableRow<"toolResults">, "metadata"> & {
  metadata: Record<string, unknown>
}
export type ToolResultDbRow = Omit<ToolResultRow, "metadata"> & {
  metadata: unknown
}
export type ToolResultPartRow = TableRow<"toolResultParts">
export type ToolCallTaskRow = Omit<
  TableRow<"toolCallTasks">,
  "finalErrorPayload" | "finalResultPayload"
> & {
  finalErrorPayload: unknown
  finalResultPayload: unknown
}
export type ToolCallTaskDbRow = Omit<
  ToolCallTaskRow,
  "finalErrorPayload" | "finalResultPayload"
> & {
  finalErrorPayload: unknown
  finalResultPayload: unknown
}
export type SessionWakeupRow = Omit<TableRow<"sessionWakeups">, "metadata"> & {
  metadata: Record<string, unknown>
}
export type SessionWakeupDbRow = Omit<SessionWakeupRow, "metadata"> & {
  metadata: unknown
}
export type SessionWakeupMetadataInsert =
  TableInsert<"sessionWakeups">["metadata"]
