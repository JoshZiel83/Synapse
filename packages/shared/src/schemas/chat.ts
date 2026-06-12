import { z } from "zod"
import {
  CHAT_TYPING_STATES,
  CONVERSATION_KINDS,
  PLAN_APPROVAL_DECISIONS,
  PUSH_TOKEN_PLATFORMS,
  RUNTIME_AUTHORIZATION_PRESETS,
  TASK_DECISIONS,
} from "../constants/enums.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"

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

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies / queries for the chat APP routes. Single-sourced
// here so the API parser and the web/mobile clients share one definition (this
// replaces both the controller's local zod schemas AND the hand-written
// ChatXxxRequest interfaces that used to live in types/index.ts — the two had
// drifted as independent tracks). `metadata` is a passthrough config record.

const chatUuidSchema = z.uuid()
const chatJsonRecordSchema = z.record(z.string(), z.any()).optional()

/** POST /chat/conversations body. strictObject: legacy fields → clean 400. */
export const ChatConversationCreateInputSchema = z.strictObject({
  clientRequestId: chatUuidSchema,
  kind: z.enum(CONVERSATION_KINDS),
  title: z.string().trim().min(1).max(255).optional(),
  workspaceMemberIds: z.array(chatUuidSchema).optional().default([]),
  actorIds: z.array(chatUuidSchema).optional().default([]),
  remoteAgentIds: z.array(chatUuidSchema).optional().default([]),
  metadata: chatJsonRecordSchema,
})
export type ChatConversationCreateInputSchemaType = z.infer<
  typeof ChatConversationCreateInputSchema
>

/** POST/PUT /chat/client-instances(/:id) body. */
export const ChatClientInstanceRegistrationInputSchema = z.object({
  platform: z.string().trim().min(1).max(64).optional(),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
  metadata: chatJsonRecordSchema,
})
export type ChatClientInstanceRegistrationInputSchemaType = z.infer<
  typeof ChatClientInstanceRegistrationInputSchema
>

/** GET /chat/conversations/:id/messages query. */
export const ChatConversationMessagesQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(0).optional(),
    beforeSequence: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    clientInstanceId: chatUuidSchema,
  })
  .refine(
    (value) =>
      !(
        typeof value.afterSequence === "number" &&
        typeof value.beforeSequence === "number"
      ),
    { message: "afterSequence and beforeSequence cannot both be provided" }
  )
export type ChatConversationMessagesQuerySchemaType = z.infer<
  typeof ChatConversationMessagesQuerySchema
>

/** PATCH /chat/conversations/:id body. */
export const ChatConversationPatchInputSchema = z
  .object({
    title: z.string().trim().min(1).max(255).nullable().optional(),
    metadata: chatJsonRecordSchema,
  })
  .refine(
    (value) => value.title !== undefined || value.metadata !== undefined,
    { message: "At least one of title or metadata must be provided" }
  )
export type ChatConversationPatchInputSchemaType = z.infer<
  typeof ChatConversationPatchInputSchema
>

/** POST /chat/conversations/:id/participants body. */
export const ChatAddParticipantsInputSchema = z
  .strictObject({
    workspaceMemberIds: z.array(chatUuidSchema).optional().default([]),
    actorIds: z.array(chatUuidSchema).optional().default([]),
    remoteAgentIds: z.array(chatUuidSchema).optional().default([]),
  })
  .refine(
    (value) =>
      value.workspaceMemberIds.length +
        value.actorIds.length +
        value.remoteAgentIds.length >
      0,
    { message: "At least one participant identifier is required" }
  )
export type ChatAddParticipantsInputSchemaType = z.infer<
  typeof ChatAddParticipantsInputSchema
>

/** POST /chat/push-tokens body. */
export const ChatPushTokenRegistrationInputSchema = z.object({
  platform: z.enum(PUSH_TOKEN_PLATFORMS),
  token: z.string().trim().min(1).max(2048),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
  metadata: chatJsonRecordSchema,
})
export type ChatPushTokenRegistrationInputSchemaType = z.infer<
  typeof ChatPushTokenRegistrationInputSchema
>

/** POST /chat/conversations/:id/typing body. */
export const ChatTypingInputSchema = z.object({
  state: z.enum(CHAT_TYPING_STATES),
})
export type ChatTypingInputSchemaType = z.infer<typeof ChatTypingInputSchema>

/** GET /chat/sync query. */
export const ChatSyncQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type ChatSyncQuerySchemaType = z.infer<typeof ChatSyncQuerySchema>

/** POST /chat/conversations/:id/messages body. */
export const ChatSendMessageInputSchema = z.object({
  contentBlocks: z.array(CanonicalContentBlockSchema).min(1),
  clientMessageId: chatUuidSchema,
  replyToItemId: chatUuidSchema.optional(),
  clientInstanceId: chatUuidSchema,
  metadata: chatJsonRecordSchema,
})
export type ChatSendMessageInputSchemaType = z.infer<
  typeof ChatSendMessageInputSchema
>

/** POST /chat/conversations/:id/read-watermark body. */
export const ChatReadWatermarkInputSchema = z.object({
  readUpToSequence: z.number().int().min(0),
  lastVisibleSequence: z.number().int().min(0).optional(),
  clientInstanceId: chatUuidSchema,
})
export type ChatReadWatermarkInputSchemaType = z.infer<
  typeof ChatReadWatermarkInputSchema
>

/** A single answer in a user-input task resolution. */
export const ChatTaskAnswerInputSchema = z.object({
  questionId: z.string().trim().min(1),
  selectedOptionIds: z.array(z.string().trim().min(1)).optional(),
  otherText: z.string().trim().optional(),
  text: z.string().trim().optional(),
})
export type ChatTaskAnswerInputSchemaType = z.infer<
  typeof ChatTaskAnswerInputSchema
>

const chatResolveTaskCommandSchema = z.object({
  commandId: chatUuidSchema,
  baseRevision: z.number().int().min(1),
})

const chatResolveTaskUserInputSchema = chatResolveTaskCommandSchema
  .extend({
    answers: z.array(ChatTaskAnswerInputSchema).min(1),
    note: z.string().trim().optional(),
  })
  .strict()

const chatResolveTaskPlanApprovalSchema = chatResolveTaskCommandSchema
  .extend({
    decision: z.enum(PLAN_APPROVAL_DECISIONS),
    note: z.string().trim().optional(),
  })
  .strict()

const chatResolveTaskRuntimeAuthorizationApproveSchema =
  chatResolveTaskCommandSchema
    .extend({
      decision: z.literal(TASK_DECISIONS[0]),
      preset: z.enum(RUNTIME_AUTHORIZATION_PRESETS),
      selectedGrantOptionId: z.string().trim().min(1),
      note: z.string().trim().optional(),
    })
    .strict()

const chatResolveTaskRuntimeAuthorizationRejectSchema =
  chatResolveTaskCommandSchema
    .extend({
      decision: z.literal(TASK_DECISIONS[1]),
      note: z.string().trim().optional(),
    })
    .strict()

/** POST /chat/conversations/:id/tasks/:taskId/respond body (discriminated). */
export const ChatTaskResolveInputSchema = z.union([
  chatResolveTaskUserInputSchema,
  chatResolveTaskPlanApprovalSchema,
  chatResolveTaskRuntimeAuthorizationApproveSchema,
  chatResolveTaskRuntimeAuthorizationRejectSchema,
])
export type ChatTaskResolveInputSchemaType = z.infer<
  typeof ChatTaskResolveInputSchema
>
