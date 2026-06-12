import { z } from "zod"
import { PUSH_TOKEN_PLATFORMS } from "../constants/enums.js"

/**
 * App-facing contracts for the chat module's APP routes (master plan §5.3).
 * chat is a Tier-A app-facing module: every workspace-scoped, authenticated
 * route returns a domain value that `appRoute` → `sendData` wraps in
 * `{ data: ... }`. These schemas describe the value each handler RETURNS (the
 * helper does the `{ data }` wrapping), so a `{ conversation }` envelope is
 * modeled as `z.object({ conversation: ... })` here.
 *
 * Top-level discriminant / scalar fields are modeled explicitly. The deeply
 * nested presentation views the service/presenter already own — conversation
 * views, hydrated conversation items (a discriminated message/event union with
 * canonical content blocks + per-event payload maps), participant summaries,
 * runtime-state maps, and sync-event payloads — are genuinely-open shapes the
 * boundary only round-trips unchanged. They are modeled as `z.unknown()` /
 * open records for now; deepening them is tracked under P1-3.
 */

const timestampSchema = z.string()

/** A single hydrated conversation view (open presentation shape). */
const ChatConversationViewSchema = z.unknown()

/** A single hydrated conversation item — message/event union (open). */
const ChatConversationItemSchema = z.unknown()

/** GET /chat/bootstrap. */
export const ChatBootstrapViewSchema = z.object({
  workspaceMemberId: z.string(),
  clientInstanceRequired: z.literal(true),
  conversations: z.array(ChatConversationViewSchema),
  nextInboxCursor: z.number(),
})
export type ChatBootstrapViewSchemaType = z.infer<
  typeof ChatBootstrapViewSchema
>

/** GET /chat/sync. `events` carry per-type open payloads. */
export const ChatSyncViewSchema = z.object({
  events: z.array(z.unknown()),
  nextCursor: z.number(),
  hasMore: z.boolean(),
})
export type ChatSyncViewSchemaType = z.infer<typeof ChatSyncViewSchema>

/** POST/PUT /chat/client-instances(/:id). */
export const ChatClientInstanceViewSchema = z.object({
  clientInstanceId: z.string(),
  workspaceMemberId: z.string(),
})
export type ChatClientInstanceViewSchemaType = z.infer<
  typeof ChatClientInstanceViewSchema
>

/**
 * POST /chat/conversations, GET/PATCH /chat/conversations/:id, and
 * POST /chat/conversations/:id/participants — all return `{ conversation }`.
 */
export const ChatConversationEnvelopeViewSchema = z.object({
  conversation: ChatConversationViewSchema,
})
export type ChatConversationEnvelopeViewSchemaType = z.infer<
  typeof ChatConversationEnvelopeViewSchema
>

/** GET /chat/conversations — `{ workspaceMemberId, conversations }`. */
export const ChatConversationListViewSchema = z.object({
  workspaceMemberId: z.string(),
  conversations: z.array(ChatConversationViewSchema),
})
export type ChatConversationListViewSchemaType = z.infer<
  typeof ChatConversationListViewSchema
>

/** GET /chat/conversations/:id/messages. */
export const ChatConversationMessagesViewSchema = z.object({
  conversation: ChatConversationViewSchema,
  items: z.array(ChatConversationItemSchema),
  runtimeByActor: z.record(z.string(), z.unknown()),
  runtimeByRemoteAgent: z.record(z.string(), z.unknown()),
  participantReadWatermarkSequence: z.number(),
  deviceState: z.unknown().optional(),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
})
export type ChatConversationMessagesViewSchemaType = z.infer<
  typeof ChatConversationMessagesViewSchema
>

/** GET /chat/conversations/:id/actors/:actorId/runtime-turns/:turnId. */
export const ChatRuntimeTurnDetailViewSchema = z.unknown()
export type ChatRuntimeTurnDetailViewSchemaType = z.infer<
  typeof ChatRuntimeTurnDetailViewSchema
>

/** POST /chat/conversations/:id/messages — `{ item }`. */
export const ChatSendMessageViewSchema = z.object({
  item: ChatConversationItemSchema,
})
export type ChatSendMessageViewSchemaType = z.infer<
  typeof ChatSendMessageViewSchema
>

/** POST /chat/conversations/:id/read-watermark. */
export const ChatReadWatermarkViewSchema = z.object({
  conversationId: z.string(),
  workspaceMemberId: z.string(),
  participantId: z.string(),
  readWatermarkSequence: z.number(),
  lastReadAt: timestampSchema,
})
export type ChatReadWatermarkViewSchemaType = z.infer<
  typeof ChatReadWatermarkViewSchema
>

/**
 * DELETE /chat/conversations/:id/participants/:pid and
 * POST /chat/conversations/:id/leave — `{ conversationId, participantId, state }`.
 */
export const ChatParticipantRemovalViewSchema = z.object({
  conversationId: z.string(),
  participantId: z.string(),
  state: z.enum(["left", "removed"]),
})
export type ChatParticipantRemovalViewSchemaType = z.infer<
  typeof ChatParticipantRemovalViewSchema
>

/** A persisted push-token row (presenter shape). */
const ChatPushTokenViewSchema = z.object({
  id: z.string(),
  workspaceMemberId: z.string(),
  platform: z.enum(PUSH_TOKEN_PLATFORMS),
  token: z.string(),
  deviceLabel: z.string().nullable(),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
})

/** POST /chat/push-tokens — `{ token }`. */
export const ChatPushTokenRegistrationViewSchema = z.object({
  token: ChatPushTokenViewSchema,
})
export type ChatPushTokenRegistrationViewSchemaType = z.infer<
  typeof ChatPushTokenRegistrationViewSchema
>

/** GET /chat/push-tokens — `{ tokens }`. */
export const ChatPushTokenListViewSchema = z.object({
  tokens: z.array(ChatPushTokenViewSchema),
})
export type ChatPushTokenListViewSchemaType = z.infer<
  typeof ChatPushTokenListViewSchema
>

/** DELETE /chat/push-tokens/:tokenId — `{ deleted }`. */
export const ChatPushTokenDeleteViewSchema = z.object({
  deleted: z.boolean(),
})
export type ChatPushTokenDeleteViewSchemaType = z.infer<
  typeof ChatPushTokenDeleteViewSchema
>

/** POST /chat/conversations/:id/typing — `{ broadcast }`. */
export const ChatTypingBroadcastViewSchema = z.object({
  broadcast: z.boolean(),
})
export type ChatTypingBroadcastViewSchemaType = z.infer<
  typeof ChatTypingBroadcastViewSchema
>

/** POST /chat/conversations/:id/messages/:itemId/retry. */
export const ChatMessageRetryViewSchema = z.object({
  retryEnqueued: z.boolean(),
  sessionId: z.string(),
  actorId: z.string(),
})
export type ChatMessageRetryViewSchemaType = z.infer<
  typeof ChatMessageRetryViewSchema
>

/**
 * POST /chat/conversations/:id/tasks/:taskId/respond — `{ outcome, task }`.
 * The enriched `task` is a genuinely-open viewer-scoped task summary.
 */
export const ChatTaskRespondViewSchema = z.object({
  outcome: z.string(),
  task: z.unknown(),
})
export type ChatTaskRespondViewSchemaType = z.infer<
  typeof ChatTaskRespondViewSchema
>

/** GET /_debug/chat/dedup-counters — open in-process counter snapshot. */
export const ChatDedupCountersViewSchema = z.record(z.string(), z.unknown())
export type ChatDedupCountersViewSchemaType = z.infer<
  typeof ChatDedupCountersViewSchema
>

/** POST /_debug/chat/realtime-outbox-gc — `{ deleted }`. */
export const ChatRealtimeOutboxGcViewSchema = z.object({
  deleted: z.number(),
})
export type ChatRealtimeOutboxGcViewSchemaType = z.infer<
  typeof ChatRealtimeOutboxGcViewSchema
>
