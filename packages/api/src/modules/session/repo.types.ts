import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

/**
 * Session module DB-row types. Repo file: the only place in the session module
 * allowed to reference TableRow (guard-layering r2). See master plan §8.
 */

export type SessionRow = TableRow<"sessions"> & {
  actorDisplayName?: string | null
  conversationKind?: string | null
  conversationIsIm?: unknown
  conversationTitle?: string | null
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
  metadata: unknown
}

export type ConversationItemPartRow = TableRow<"conversationItemParts">

// Runtime engine (session/runtime.ts) DB-row types. Tier-D engine: these named
// aliases keep the runtime helper free of the kysely TableRow/TableInsert alias.
export type ToolResultRow = TableRow<"toolResults">
export type ToolResultPartRow = TableRow<"toolResultParts">
export type ToolCallTaskRow = TableRow<"toolCallTasks">
export type SessionWakeupRow = TableRow<"sessionWakeups">
export type SessionWakeupMetadataInsert =
  TableInsert<"sessionWakeups">["metadata"]
