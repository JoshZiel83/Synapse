import { z } from "zod"
import {
  ACTOR_RUNTIME_HEALTHS,
  AUTOMATION_RULE_CATEGORIES,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  CHAT_MEMBERSHIP_UPDATE_REASONS,
  CHAT_PARTICIPANT_REMOVAL_STATES,
  CHAT_TYPING_STATES,
  CONVERSATION_EVENT_CONTEXT_POLICIES,
  CONVERSATION_EVENT_TIMELINE_POLICIES,
  CONVERSATION_FEED_EVENT_TYPE,
  CONVERSATION_FEED_ITEM_SUBTYPES,
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_KINDS,
  CONVERSATION_ITEM_ROLES,
  CONVERSATION_ITEM_SCOPES,
  CONVERSATION_ITEM_SURFACES,
  CONVERSATION_ITEM_TYPES,
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS,
  CONVERSATION_MESSAGE_SUBTYPES,
  CONVERSATION_PARTICIPANT_STATES,
  CONVERSATION_PARTICIPANT_TYPES,
  CONVERSATION_STATUSES,
  CONVERSATION_REPLY_REF_SUBTYPES,
  MEMORY_CATEGORIES,
  PLAN_APPROVAL_DECISIONS,
  PUSH_TOKEN_PLATFORMS,
  REMOTE_AGENT_RUNTIME_KINDS,
  REMOTE_AGENT_RUNTIME_STATES,
  RUNTIME_AUTHORIZATION_PRESETS,
  SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES,
  SESSION_STATUSES,
  TASK_DECISIONS,
  TRANSPORT_DELIVERY_STATUSES,
  TRANSPORT_ENDPOINT_TYPES,
  TRANSPORT_KINDS,
} from "../constants/enums.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"
import { RemoteAgentRuntimeCapabilityViewSchema } from "./remote-agents.js"
import {
  SubjectRefSchema,
  TaskNoticeSummarySchema,
  TaskSummarySchema,
} from "./tasks.js"
import type {
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
} from "../types/index.js"

/**
 * App-facing contracts for the chat module's APP routes (master plan §5.3).
 * chat is a Tier-A app-facing module: every workspace-scoped, authenticated
 * route returns a domain value that `appRoute` → `sendData` wraps in
 * `{ data: ... }`. These schemas describe the value each handler RETURNS (the
 * helper does the `{ data }` wrapping), so a `{ conversation }` envelope is
 * modeled as `z.object({ conversation: ... })` here.
 *
 * Top-level discriminant / scalar fields are modeled explicitly. The remaining
 * deliberately-open presentation shapes are hydrated conversation item
 * transport/event details. Runtime-state maps, device state, sync events,
 * viewer-scoped task summaries, and runtime-turn activity detail are modeled
 * below because web/mobile consume them as stable shared views.
 */

// Canonical wire-instant schema (single source of truth — C1). Validates the
// `…mmmZ` shape and brands the output so these DTO schemas stay branded end to
// end, matching the `Timestamp` (= IsoInstantString) field types they feed.
const timestampSchema = IsoInstantStringSchema

export const ChatSocketClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string().optional(),
    workspaceId: z.string().min(1),
  }),
  z
    .object({
      type: z.literal("subscribe"),
      key: z.string().min(1),
      topic: z.enum(["inbox", "conversation"]),
      conversationId: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.topic === "conversation" && !value.conversationId) {
        ctx.addIssue({
          code: "custom",
          path: ["conversationId"],
          message: "conversation subscriptions require conversationId",
        })
      }
    }),
  z.object({
    type: z.literal("unsubscribe"),
    key: z.string().min(1),
  }),
  z.object({
    type: z.literal("pong"),
  }),
  z.object({
    type: z.literal("typing"),
    conversationId: z.string().min(1),
    state: z.enum(CHAT_TYPING_STATES),
  }),
])

export type ChatSocketClientMessage = z.infer<
  typeof ChatSocketClientMessageSchema
>

const ConversationEntityRefSchema = z.object({
  participantId: z.string().optional(),
  participantType: z.enum(CONVERSATION_PARTICIPANT_TYPES),
  workspaceMemberId: z.string().optional(),
  actorId: z.string().optional(),
  remoteAgentId: z.string().optional(),
  externalUserKey: z.string().optional(),
  transportAddressId: z.string().optional(),
  transportKind: z.enum(TRANSPORT_KINDS).optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
})

const ChatParticipantSummarySchema = ConversationEntityRefSchema.omit({
  participantId: true,
  participantType: true,
  name: true,
}).extend({
  participantId: z.string(),
  conversationId: z.string(),
  participantType: z.enum(CONVERSATION_PARTICIPANT_TYPES),
  name: z.string(),
  roleKey: z.string(),
  state: z.enum(CONVERSATION_PARTICIPANT_STATES),
  metadata: z.record(z.string(), z.unknown()),
  joinedAt: timestampSchema,
  leftAt: timestampSchema.optional(),
  sessionId: z.string().optional(),
  sessionStatus: z
    .union([z.enum(SESSION_STATUSES), z.enum(REMOTE_AGENT_RUNTIME_STATES)])
    .optional(),
})

const ConversationParticipantRefSchema = ConversationEntityRefSchema.extend({
  participantId: z.string(),
  participantType: z.enum(CONVERSATION_PARTICIPANT_TYPES),
})

const ChatConversationPresentationSchema = z.object({
  chatType: z.enum(CONVERSATION_KINDS),
  subtitle: z.string().optional(),
  avatarParticipantIds: z.array(z.string()),
  peerParticipantId: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatarEmoji: z.string().optional(),
})

const ChatConversationPermissionsSchema = z.object({
  canManageConversation: z.boolean(),
  canManageParticipants: z.boolean(),
  canRename: z.boolean(),
})

const ChatConversationLastItemSchema = z.object({
  itemId: z.string(),
  sequence: z.number().int().nonnegative(),
  itemType: z.enum(CONVERSATION_ITEM_TYPES),
  subtype: z.enum(CONVERSATION_FEED_ITEM_SUBTYPES),
  previewText: z.string(),
  authorParticipantId: z.string().optional(),
  author: ConversationEntityRefSchema.optional(),
  createdAt: timestampSchema,
})

const ConversationMessageTransportContextSchema = z.object({
  direction: z.enum(CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS),
  transportKind: z.enum(TRANSPORT_KINDS),
  transportAccountId: z.string().optional(),
  endpointType: z.enum(TRANSPORT_ENDPOINT_TYPES).optional(),
  endpointExternalId: z.string().optional(),
  externalMessageId: z.string().optional(),
  transportAddressId: z.string().optional(),
  senderExternalId: z.string().optional(),
})

const ConversationMessageTransportDeliverySchema = z.object({
  linkId: z.string(),
  transportKind: z.enum(TRANSPORT_KINDS),
  direction: z.enum(CONVERSATION_MESSAGE_TRANSPORT_DIRECTIONS),
  deliveryStatus: z.enum(TRANSPORT_DELIVERY_STATUSES),
  endpointType: z.enum(TRANSPORT_ENDPOINT_TYPES).optional(),
  endpointExternalId: z.string().optional(),
  endpointDisplayName: z.string().optional(),
  externalMessageId: z.string().optional(),
  deliveredAt: timestampSchema.optional(),
  metadata: z.record(z.string(), z.unknown()),
})

/** A single hydrated conversation view. */
const ChatConversationViewSchema = z.object({
  conversationId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  kind: z.enum(CONVERSATION_KINDS),
  isIm: z.boolean(),
  status: z.enum(CONVERSATION_STATUSES),
  unreadCount: z.number().int().nonnegative(),
  muted: z.boolean(),
  archived: z.boolean(),
  pinnedSortKey: timestampSchema.optional(),
  updatedAt: timestampSchema,
  createdAt: timestampSchema,
  participants: z.array(ChatParticipantSummarySchema),
  presentation: ChatConversationPresentationSchema,
  permissions: ChatConversationPermissionsSchema,
  viewerParticipantId: z.string().optional(),
  lastItem: ChatConversationLastItemSchema.optional(),
})

const ConversationReplyRefSchema = z.object({
  itemId: z.string(),
  ref: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
  itemType: z.enum(CONVERSATION_ITEM_TYPES),
  subtype: z.enum(CONVERSATION_REPLY_REF_SUBTYPES),
  author: ConversationEntityRefSchema.optional(),
  previewText: z.string(),
  previewBlocks: z.array(CanonicalContentBlockSchema),
  createdAt: timestampSchema.optional(),
  isUnavailable: z.boolean().optional(),
})

const ChatConversationItemBaseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  sequence: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  clientMessageId: z.string().optional(),
  role: z.enum(CONVERSATION_ITEM_ROLES),
  scope: z.enum(CONVERSATION_ITEM_SCOPES),
  surface: z.enum(CONVERSATION_ITEM_SURFACES),
  authorParticipantId: z.string().optional(),
  author: ConversationEntityRefSchema.optional(),
  replyToItemId: z.string().optional(),
  replyTo: ConversationReplyRefSchema.optional(),
  causedByItemId: z.string().optional(),
  content: z.string(),
  contentBlocks: z.array(CanonicalContentBlockSchema),
  metadata: z.record(z.string(), z.unknown()),
  restrictedAudienceParticipantIds: z.array(z.string()).optional(),
  restrictedAudience: z.array(ConversationEntityRefSchema).optional(),
  createdAt: timestampSchema,
})

const ParticipantEventPayloadSchema = z.object({
  batchId: z.string(),
  initiator: ConversationEntityRefSchema.optional(),
  participants: z.array(ConversationParticipantRefSchema),
  focusItemId: z.string().optional(),
})

const MemoryEventPayloadBaseSchema = z.object({
  actor: ConversationEntityRefSchema,
  memoryId: z.string(),
  memoryOwner: SubjectRefSchema,
  memoryScope: SubjectRefSchema.optional(),
  memoryNamespaceKey: z.string(),
  memoryCategory: z.enum(MEMORY_CATEGORIES),
  textDigest: z.string().optional(),
  sourceItemId: z.string().optional(),
  sourceTurnId: z.string().optional(),
})

const ActorRenamedEventPayloadSchema = z.object({
  actor: ConversationEntityRefSchema,
  oldName: z.string().optional(),
  newName: z.string(),
  sourceTurnId: z.string().optional(),
})

const ActorAvatarChangedEventPayloadSchema = z.object({
  actor: ConversationEntityRefSchema,
  oldAvatarEmoji: z.string().optional(),
  newAvatarEmoji: z.string().optional(),
  oldAvatarUrl: z.string().optional(),
  newAvatarUrl: z.string().optional(),
  sourceTurnId: z.string().optional(),
})

const AutomationNoticePayloadSchema = z.object({
  automationId: z.string(),
  executionId: z.string(),
  occurrenceId: z.string(),
  category: z.enum(AUTOMATION_RULE_CATEGORIES),
  sourceKind: z.enum(AUTOMATION_TRIGGER_SOURCE_KINDS),
  eventSourceId: z.string().optional(),
  eventSourceName: z.string().optional(),
  sourceLabel: z.string().optional(),
  sourceTitle: z.string().optional(),
  sourceSummary: z.string().optional(),
  sourceDescription: z.string().optional(),
  occurredAt: timestampSchema.optional(),
  message: z.string(),
  messageBlocks: z.array(CanonicalContentBlockSchema).optional(),
})

const TaskRequestedEventPayloadSchema = z.object({
  task: TaskSummarySchema,
})

const ConversationFeedEventPayloadEnvelopeSchema = z.discriminatedUnion(
  "subtype",
  [
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_JOINED),
      eventPayload: ParticipantEventPayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED),
      eventPayload: ParticipantEventPayloadSchema.extend({
        reason: z.string().optional(),
      }),
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT),
      eventPayload: ParticipantEventPayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.MEMORY_SAVED),
      eventPayload: MemoryEventPayloadBaseSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.MEMORY_UPDATED),
      eventPayload: MemoryEventPayloadBaseSchema.extend({
        supersedesMemoryId: z.string().optional(),
      }),
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.ACTOR_RENAMED),
      eventPayload: ActorRenamedEventPayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.ACTOR_AVATAR_CHANGED),
      eventPayload: ActorAvatarChangedEventPayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.AUTOMATION_NOTICE),
      eventPayload: AutomationNoticePayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.TASK_REQUESTED),
      eventPayload: TaskRequestedEventPayloadSchema,
    }),
    z.object({
      subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.TASK_NOTICE),
      eventPayload: TaskNoticeSummarySchema,
    }),
  ]
)

export function parseConversationFeedEventPayload<
  T extends ConversationFeedEventType,
>(subtype: T, eventPayload: unknown): ConversationFeedEventPayloadMap[T] {
  const parsed = ConversationFeedEventPayloadEnvelopeSchema.parse({
    subtype,
    eventPayload,
  })
  return parsed.eventPayload as ConversationFeedEventPayloadMap[T]
}

const ChatConversationEventItemBaseSchema =
  ChatConversationItemBaseSchema.extend({
    itemType: z.literal("event"),
    eventTimelinePolicy: z
      .enum(CONVERSATION_EVENT_TIMELINE_POLICIES)
      .optional(),
    eventContextPolicy: z.enum(CONVERSATION_EVENT_CONTEXT_POLICIES).optional(),
  })

const ChatConversationEventItemSchema = z.discriminatedUnion("subtype", [
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_JOINED),
    eventPayload: ParticipantEventPayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_KICKED),
    eventPayload: ParticipantEventPayloadSchema.extend({
      reason: z.string().optional(),
    }),
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.PARTICIPANT_LEFT),
    eventPayload: ParticipantEventPayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.MEMORY_SAVED),
    eventPayload: MemoryEventPayloadBaseSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.MEMORY_UPDATED),
    eventPayload: MemoryEventPayloadBaseSchema.extend({
      supersedesMemoryId: z.string().optional(),
    }),
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.ACTOR_RENAMED),
    eventPayload: ActorRenamedEventPayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.ACTOR_AVATAR_CHANGED),
    eventPayload: ActorAvatarChangedEventPayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.AUTOMATION_NOTICE),
    eventPayload: AutomationNoticePayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.TASK_REQUESTED),
    eventPayload: TaskRequestedEventPayloadSchema,
  }),
  ChatConversationEventItemBaseSchema.extend({
    subtype: z.literal(CONVERSATION_FEED_EVENT_TYPE.TASK_NOTICE),
    eventPayload: TaskNoticeSummarySchema,
  }),
])

/** A single hydrated conversation item; policies stay explicit passthrough. */
const ChatConversationItemSchema = z.union([
  ChatConversationItemBaseSchema.extend({
    itemType: z.literal("message"),
    subtype: z.enum(CONVERSATION_MESSAGE_SUBTYPES),
    transport: ConversationMessageTransportContextSchema.optional(),
    transportDeliveries: z
      .array(ConversationMessageTransportDeliverySchema)
      .optional(),
  }),
  ChatConversationItemBaseSchema.extend({
    itemType: z.literal("summary"),
    subtype: z.literal(CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY),
    transport: ConversationMessageTransportContextSchema.optional(),
    transportDeliveries: z
      .array(ConversationMessageTransportDeliverySchema)
      .optional(),
  }),
  ChatConversationItemBaseSchema.extend({
    itemType: z.literal("control"),
    subtype: z.enum(CONVERSATION_MESSAGE_SUBTYPES),
    transport: ConversationMessageTransportContextSchema.optional(),
    transportDeliveries: z
      .array(ConversationMessageTransportDeliverySchema)
      .optional(),
  }),
  ChatConversationEventItemSchema,
])

const ChatDeviceStateSchema = z.object({
  clientInstanceId: z.string(),
  conversationId: z.string(),
  lastVisibleSequence: z.number().int().nonnegative(),
  lastInboxSeq: z.number().int().nonnegative(),
  lastOpenedAt: timestampSchema.optional(),
  draftPayload: z.record(z.string(), z.unknown()),
})

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

const actorRuntimeActivityStates = [
  "pending",
  "running",
  "input_required",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const

const actorRuntimeToolKinds = ["system", "plugin", "device"] as const

const actorRuntimeTaskStatuses = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const

const actorRuntimePhases = [
  "idle",
  "thinking",
  "tool",
  "responding",
  "blocked",
  "error",
] as const

const PresentationStringSchema = z.object({
  key: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  fallback: z.string(),
})

const ActorRuntimeProcessingTargetSchema = z.object({
  wakeupId: z.string(),
  participantType: z.enum(SESSION_WAKEUP_SOURCE_PARTICIPANT_TYPES).optional(),
  participantId: z.string().optional(),
  name: z.string(),
  summary: z.string().optional(),
  createdAt: timestampSchema,
  attachedAt: timestampSchema.optional(),
})

const ActorRuntimeToolSourceSchema = z.object({
  kind: z.enum(actorRuntimeToolKinds),
  displayName: z.string().optional(),
  upstreamToolName: z.string().optional(),
})

const ActorRuntimeTurnActivityItemSchema = z.object({
  toolCallId: z.string(),
  toolKind: z.enum(actorRuntimeToolKinds),
  toolName: z.string(),
  source: ActorRuntimeToolSourceSchema.optional(),
  state: z.enum(actorRuntimeActivityStates),
  displayTitle: z.string(),
  displayDetail: z.string().optional(),
  icon: z.string().optional(),
  titlePresentation: PresentationStringSchema.optional(),
  detailPresentation: PresentationStringSchema.optional(),
  resultSummary: PresentationStringSchema.optional(),
  requestBlocks: z.array(CanonicalContentBlockSchema),
  resultBlocks: z.array(CanonicalContentBlockSchema),
  taskStatus: z.enum(actorRuntimeTaskStatuses).optional(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
})

const ActorRuntimeTurnPreviewToolSchema = z.object({
  toolCallId: z.string(),
  toolKind: z.enum(actorRuntimeToolKinds),
  toolName: z.string(),
  source: ActorRuntimeToolSourceSchema.optional(),
  state: z.enum(actorRuntimeActivityStates),
  displayTitle: z.string(),
  displayDetail: z.string().optional(),
  icon: z.string().optional(),
  titlePresentation: PresentationStringSchema.optional(),
  detailPresentation: PresentationStringSchema.optional(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
})

const ActorRuntimeTurnPreviewSchema = z.object({
  turnId: z.string(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  processingTargets: z.array(ActorRuntimeProcessingTargetSchema),
  activeTool: ActorRuntimeTurnPreviewToolSchema.optional(),
  lastCompletedTool: ActorRuntimeTurnPreviewToolSchema.optional(),
  totalToolCallCount: z.number().int().nonnegative(),
  completedToolCallCount: z.number().int().nonnegative(),
  failedToolCallCount: z.number().int().nonnegative(),
})

const RuntimeLastErrorSchema = z.object({
  message: z.string(),
  at: timestampSchema,
})

export const ActorRuntimeStateSchema = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
  actorId: z.string(),
  actorDisplayName: z.string(),
  laneState: z.enum(SESSION_STATUSES),
  health: z.enum(ACTOR_RUNTIME_HEALTHS),
  phase: z.enum(actorRuntimePhases),
  statusText: z.string().optional(),
  pendingWakeupCount: z.number().int().nonnegative(),
  currentTurnPreview: ActorRuntimeTurnPreviewSchema.optional(),
  latestWakeupAt: timestampSchema.optional(),
  lastError: RuntimeLastErrorSchema.optional(),
  updatedAt: timestampSchema,
})

const RemoteAgentRuntimeStateSchema = z.object({
  remoteAgentId: z.string(),
  runtimeKind: z.enum(REMOTE_AGENT_RUNTIME_KINDS),
  state: z.enum(REMOTE_AGENT_RUNTIME_STATES),
  statusText: z.string().optional(),
  activeConversationId: z.string().optional(),
  activeTaskId: z.string().optional(),
  sessionId: z.string().optional(),
  pendingConversationCount: z.number().int().nonnegative(),
  unreadDeliveryCount: z.number().int().nonnegative(),
  lastActivityAt: timestampSchema.optional(),
  lastRunStartedAt: timestampSchema.optional(),
  lastRunFinishedAt: timestampSchema.optional(),
  lastError: RuntimeLastErrorSchema.optional(),
  updatedAt: timestampSchema,
  capabilities: RemoteAgentRuntimeCapabilityViewSchema.optional(),
})

const ChatSyncEventBaseSchema = z.object({
  syncSeq: z.number().int().nonnegative(),
  memberSeq: z.number().int().nonnegative(),
  workspaceId: z.string(),
  workspaceMemberId: z.string(),
  conversationId: z.string().optional(),
  itemId: z.string().optional(),
  occurredAt: timestampSchema,
})

const ChatSyncEventSchema = z.discriminatedUnion("eventType", [
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("conversation.upsert"),
    payload: z.object({
      conversation: ChatConversationViewSchema,
    }),
  }),
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("conversation.item.created"),
    payload: z.object({
      conversationId: z.string(),
      item: ChatConversationItemSchema,
    }),
  }),
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("conversation.read.updated"),
    payload: z.object({
      conversationId: z.string(),
      workspaceMemberId: z.string(),
      participantId: z.string(),
      readWatermarkSequence: z.number().int().nonnegative(),
      lastReadAt: timestampSchema,
    }),
  }),
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("task.updated"),
    payload: z.object({
      conversationId: z.string(),
      taskId: z.string(),
      itemId: z.string().optional(),
      task: TaskSummarySchema,
    }),
  }),
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("remote_agent.runtime_updated"),
    payload: z.object({
      remoteAgentId: z.string(),
      snapshot: RemoteAgentRuntimeStateSchema,
    }),
  }),
  ChatSyncEventBaseSchema.extend({
    eventType: z.literal("conversation.membership.updated"),
    payload: z.object({
      conversationId: z.string(),
      selfState: z.enum(CONVERSATION_PARTICIPANT_STATES),
      reason: z.enum(CHAT_MEMBERSHIP_UPDATE_REASONS).optional(),
      participants: z.array(ChatParticipantSummarySchema),
    }),
  }),
])

/** GET /chat/sync. */
export const ChatSyncViewSchema = z.object({
  events: z.array(ChatSyncEventSchema),
  nextCursor: z.number(),
  hasMore: z.boolean(),
})
export type ChatSyncViewSchemaType = z.infer<typeof ChatSyncViewSchema>

/** GET /chat/conversations/:id/messages. */
export const ChatConversationMessagesViewSchema = z.object({
  conversation: ChatConversationViewSchema,
  items: z.array(ChatConversationItemSchema),
  runtimeByActor: z.record(z.string(), ActorRuntimeStateSchema),
  runtimeByRemoteAgent: z.record(z.string(), RemoteAgentRuntimeStateSchema),
  participantReadWatermarkSequence: z.number(),
  deviceState: ChatDeviceStateSchema.optional(),
  hasMoreBefore: z.boolean(),
  hasMoreAfter: z.boolean(),
})
export type ChatConversationMessagesViewSchemaType = z.infer<
  typeof ChatConversationMessagesViewSchema
>

/** GET /chat/conversations/:id/actors/:actorId/runtime-turns/:turnId. */
export const ChatRuntimeTurnDetailViewSchema = z.object({
  conversationId: z.string(),
  actorId: z.string(),
  actorDisplayName: z.string(),
  turnId: z.string(),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  processingTargets: z.array(ActorRuntimeProcessingTargetSchema),
  items: z.array(ActorRuntimeTurnActivityItemSchema),
})
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
  state: z.enum(CHAT_PARTICIPANT_REMOVAL_STATES),
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
 * The enriched `task` is the shared viewer-scoped task summary.
 */
export const ChatTaskRespondViewSchema = z.object({
  outcome: z.string(),
  task: TaskSummarySchema,
})
export type ChatTaskRespondViewSchemaType = z.infer<
  typeof ChatTaskRespondViewSchema
>

/** GET /_debug/chat/dedup-counters — in-process numeric counter snapshot. */
export const ChatDedupCountersViewSchema = z.record(
  z.string(),
  z.number().int().nonnegative()
)
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
const chatJsonRecordSchema = z.record(z.string(), z.unknown()).optional()

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
