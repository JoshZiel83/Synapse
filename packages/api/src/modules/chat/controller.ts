import type { FastifyInstance } from "fastify"
import { ZodError, z } from "zod"
import {
  CHAT_TYPING_STATES,
  CONVERSATION_KINDS,
  TASK_DECISIONS,
  PLAN_APPROVAL_DECISIONS,
  PUSH_TOKEN_PLATFORMS,
  RUNTIME_AUTHORIZATION_PRESETS,
} from "@synapse/shared"
import { CanonicalContentBlockSchema } from "@synapse/shared/schemas"
import {
  ChatBootstrapViewSchema,
  ChatClientInstanceViewSchema,
  ChatConversationEnvelopeViewSchema,
  ChatConversationListViewSchema,
  ChatConversationMessagesViewSchema,
  ChatDedupCountersViewSchema,
  ChatMessageRetryViewSchema,
  ChatParticipantRemovalViewSchema,
  ChatPushTokenDeleteViewSchema,
  ChatPushTokenListViewSchema,
  ChatPushTokenRegistrationViewSchema,
  ChatReadWatermarkViewSchema,
  ChatRealtimeOutboxGcViewSchema,
  ChatRuntimeTurnDetailViewSchema,
  ChatSendMessageViewSchema,
  ChatSyncViewSchema,
  ChatTaskRespondViewSchema,
  ChatTypingBroadcastViewSchema,
} from "@synapse/shared/schemas"
import { appRoute } from "../../infrastructure/http/route.js"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { requireWorkspaceMemberIdentity } from "./workspace-identity.js"
import {
  chatActorRuntimeParamsSchema,
  chatClientInstanceParamsSchema,
  chatConversationParamsSchema,
  chatTaskParamsSchema,
  chatWorkspaceParamsSchema,
  chatUuidSchema,
} from "./request-schemas.js"
import {
  createChatClientInstance,
  createChatConversation,
  getChatConversationActorRuntimeTurnDetail,
  getConversationParticipant,
  getChatBootstrap,
  getChatConversationMessages,
  getChatSync,
  isChatServiceError,
  sendChatConversationMessage,
  touchChatClientInstance,
  updateChatConversationReadWatermark,
  listChatConversations,
  getChatConversationDetail,
  patchChatConversation,
  addChatConversationParticipants,
  removeChatConversationParticipant,
  leaveChatConversation,
  registerChatPushToken,
  listChatPushTokens,
  deleteChatPushToken,
  broadcastTypingState,
  retryAssistantMessage,
} from "./service.js"
import {
  canUserViewTask,
  enrichTaskForUser,
  getTaskSummary,
  resolveTaskRequest,
} from "../tasks/service.js"
import { getChatDedupCountersSnapshot } from "./observability.js"
import { gcRealtimeEventOutbox } from "../../infrastructure/events/index.js"
import { isPlatformSuperAdmin } from "../platform/admin-service.js"

const CHAT_BASE_PATH = "/api/v1/workspaces/:workspaceId/chat"

const jsonRecordSchema = z.record(z.string(), z.any()).optional()

// CanonicalContentBlock zod is owned by @synapse/shared so any future
// consumer (ingest CLI, device-runtime, etc.) validates against the same
// shape the chat HTTP API enforces here.
const canonicalContentBlockSchema = CanonicalContentBlockSchema

// strictObject so legacy clients sending the removed `boundary` /
// `externalParticipants` fields get a clean 400 instead of having them silently
// stripped (zod's default object strips unknown keys). External participants are
// created only by the IM ingest path now; IM-ness is derived from the transport
// binding, never passed at create time.
const createConversationSchema = z.strictObject({
  clientRequestId: chatUuidSchema,
  kind: z.enum(CONVERSATION_KINDS),
  title: z.string().trim().min(1).max(255).optional(),
  workspaceMemberIds: z.array(chatUuidSchema).optional().default([]),
  actorIds: z.array(chatUuidSchema).optional().default([]),
  remoteAgentIds: z.array(chatUuidSchema).optional().default([]),
  metadata: jsonRecordSchema,
})

const registerClientInstanceSchema = z.object({
  platform: z.string().trim().min(1).max(64).optional(),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
  metadata: jsonRecordSchema,
})

const conversationMessagesQuerySchema = z
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
    {
      message: "afterSequence and beforeSequence cannot both be provided",
    }
  )

const patchConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(255).nullable().optional(),
    metadata: jsonRecordSchema,
  })
  .refine(
    (value) => value.title !== undefined || value.metadata !== undefined,
    { message: "At least one of title or metadata must be provided" }
  )

const addParticipantsSchema = z
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

const removeParticipantParamsSchema = z.object({
  workspaceId: chatUuidSchema,
  conversationId: chatUuidSchema,
  participantId: chatUuidSchema,
})

const pushTokenSchema = z.object({
  platform: z.enum(PUSH_TOKEN_PLATFORMS),
  token: z.string().trim().min(1).max(2048),
  deviceLabel: z.string().trim().min(1).max(255).optional(),
  metadata: jsonRecordSchema,
})

const typingSchema = z.object({
  state: z.enum(CHAT_TYPING_STATES),
})

const syncQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

const sendMessageSchema = z.object({
  contentBlocks: z.array(canonicalContentBlockSchema).min(1),
  clientMessageId: chatUuidSchema,
  replyToItemId: chatUuidSchema.optional(),
  clientInstanceId: chatUuidSchema,
  metadata: jsonRecordSchema,
})

const readWatermarkSchema = z.object({
  readUpToSequence: z.number().int().min(0),
  lastVisibleSequence: z.number().int().min(0).optional(),
  clientInstanceId: chatUuidSchema,
})

const taskAnswerSchema = z.object({
  questionId: z.string().trim().min(1),
  selectedOptionIds: z.array(z.string().trim().min(1)).optional(),
  otherText: z.string().trim().optional(),
  text: z.string().trim().optional(),
})

const resolveTaskCommandSchema = z.object({
  commandId: chatUuidSchema,
  baseRevision: z.number().int().min(1),
})

const resolveTaskUserInputSchema = resolveTaskCommandSchema
  .extend({
    answers: z.array(taskAnswerSchema).min(1),
    note: z.string().trim().optional(),
  })
  .strict()

const resolveTaskPlanApprovalSchema = resolveTaskCommandSchema
  .extend({
    decision: z.enum(PLAN_APPROVAL_DECISIONS),
    note: z.string().trim().optional(),
  })
  .strict()

const resolveTaskRuntimeAuthorizationApproveSchema = resolveTaskCommandSchema
  .extend({
    decision: z.literal(TASK_DECISIONS[0]),
    preset: z.enum(RUNTIME_AUTHORIZATION_PRESETS),
    selectedGrantOptionId: z.string().trim().min(1),
    note: z.string().trim().optional(),
  })
  .strict()

const resolveTaskRuntimeAuthorizationRejectSchema = resolveTaskCommandSchema
  .extend({
    decision: z.literal(TASK_DECISIONS[1]),
    note: z.string().trim().optional(),
  })
  .strict()

const resolveTaskSchema = z.union([
  resolveTaskUserInputSchema,
  resolveTaskPlanApprovalSchema,
  resolveTaskRuntimeAuthorizationApproveSchema,
  resolveTaskRuntimeAuthorizationRejectSchema,
])

function getRequestUserId(request: any) {
  return (request as any).user!.userId as string
}

async function resolveRequestWorkspaceMemberId(
  workspaceId: string,
  request: any,
  reply: any
) {
  try {
    const identity = await requireWorkspaceMemberIdentity(
      workspaceId,
      getRequestUserId(request)
    )
    return identity.workspaceMemberId
  } catch {
    reply.status(403).send({
      error: "You are not a member of this workspace",
      code: "workspace_access_denied",
    })
    return null
  }
}

function replyChatError(reply: any, error: unknown) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: error.issues[0]?.message ?? "Invalid request",
      code: "invalid_request",
      issues: error.issues,
    })
  }

  if (!isChatServiceError(error)) {
    throw error
  }

  return reply.status(error.statusCode).send({
    error: error.message,
    code: error.code,
    ...(error.details || {}),
  })
}

export default async function chatController(app: FastifyInstance) {
  app.addHook("onRequest", authMiddleware)

  // Authenticated read-only debug endpoint: returns the in-process
  // duplicate_*_total counters maintained in ./observability.ts. Useful
  // for the S6 dedup integration tests and for an ops dashboard. Auth
  // is required (via the onRequest hook above) so anonymous callers
  // can't probe the counter; no per-workspace data is exposed.
  appRoute(
    app,
    "GET",
    "/api/v1/_debug/chat/dedup-counters",
    { schema: ChatDedupCountersViewSchema },
    async () => getChatDedupCountersSnapshot()
  )

  // Platform-super-admin-only debug endpoint that forces a
  // realtime_event_outbox GC pass and returns the number of pruned
  // rows. The dispatcher loop runs the same GC periodically (see
  // infrastructure/events/index.ts); this endpoint lets ops + the S39
  // integration test trigger it on demand without waiting for the
  // loop's interval. Globally destructive (cross-workspace), so it
  // requires the super_admin platform access key specifically — NOT
  // the broader isPlatformAdmin set, which also admits workspace_admin
  // and model_admin (S41). Those scopes are workspace- or model-
  // bound and have no business running a process-wide table sweep.
  // Optional `?hours=N` overrides the retention window for the call.
  // The GC only ever deletes status='dispatched' rows, never 'failed'
  // (which is a retryable state in claimPendingRealtimeOutboxEntries),
  // so even hours=0 won't cause realtime event loss.
  appRoute(
    app,
    "POST",
    "/api/v1/_debug/chat/realtime-outbox-gc",
    { schema: ChatRealtimeOutboxGcViewSchema },
    async (request, reply) => {
      const userId = getRequestUserId(request)
      if (!(await isPlatformSuperAdmin(userId))) {
        reply.status(403).send({
          error: "Platform super_admin required to run realtime outbox GC.",
          code: "platform_super_admin_required",
        })
        return undefined
      }
      const query = (request.query ?? {}) as { hours?: string }
      const hours = query.hours ? Number.parseInt(query.hours, 10) : undefined
      const deleted = await gcRealtimeEventOutbox(
        Number.isFinite(hours) ? (hours as number) : undefined
      )
      return { deleted }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/bootstrap`,
    { schema: ChatBootstrapViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        return await getChatBootstrap({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/sync`,
    { schema: ChatSyncViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        const query = syncQuerySchema.parse(request.query)
        return await getChatSync({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          cursor: query.cursor,
          limit: query.limit,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/client-instances`,
    { schema: ChatClientInstanceViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        const body = registerClientInstanceSchema.parse(request.body)
        reply.status(201)
        return await createChatClientInstance({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          platform: body.platform,
          deviceLabel: body.deviceLabel,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "PUT",
    `${CHAT_BASE_PATH}/client-instances/:clientInstanceId`,
    { schema: ChatClientInstanceViewSchema },
    async (request, reply) => {
      try {
        const params = chatClientInstanceParamsSchema.parse(request.params)
        const body = registerClientInstanceSchema.parse(request.body)
        return await touchChatClientInstance({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          clientInstanceId: params.clientInstanceId,
          platform: body.platform,
          deviceLabel: body.deviceLabel,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations`,
    { schema: ChatConversationEnvelopeViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        const body = createConversationSchema.parse(request.body)
        return await createChatConversation({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          clientRequestId: body.clientRequestId,
          kind: body.kind,
          title: body.title,
          workspaceMemberIds: body.workspaceMemberIds,
          actorIds: body.actorIds,
          remoteAgentIds: body.remoteAgentIds,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/conversations/:conversationId/messages`,
    { schema: ChatConversationMessagesViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const query = conversationMessagesQuerySchema.parse(request.query)
        return await getChatConversationMessages({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          afterSequence: query.afterSequence,
          beforeSequence: query.beforeSequence,
          limit: query.limit,
          clientInstanceId: query.clientInstanceId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/conversations/:conversationId/actors/:actorId/runtime-turns/:turnId`,
    { schema: ChatRuntimeTurnDetailViewSchema },
    async (request, reply) => {
      try {
        const params = chatActorRuntimeParamsSchema.parse(request.params)
        return await getChatConversationActorRuntimeTurnDetail({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          actorId: params.actorId,
          turnId: params.turnId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/messages`,
    { schema: ChatSendMessageViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const body = sendMessageSchema.parse(request.body)
        const workspaceMemberId = await resolveRequestWorkspaceMemberId(
          params.workspaceId,
          request,
          reply
        )
        if (!workspaceMemberId) return undefined
        return await sendChatConversationMessage({
          workspaceId: params.workspaceId,
          workspaceMemberId,
          conversationId: params.conversationId,
          clientInstanceId: body.clientInstanceId,
          clientMessageId: body.clientMessageId,
          contentBlocks: body.contentBlocks as never,
          replyToItemId: body.replyToItemId,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/read-watermark`,
    { schema: ChatReadWatermarkViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const body = readWatermarkSchema.parse(request.body)
        const workspaceMemberId = await resolveRequestWorkspaceMemberId(
          params.workspaceId,
          request,
          reply
        )
        if (!workspaceMemberId) return undefined
        return await updateChatConversationReadWatermark({
          workspaceId: params.workspaceId,
          workspaceMemberId,
          conversationId: params.conversationId,
          clientInstanceId: body.clientInstanceId,
          readUpToSequence: body.readUpToSequence,
          lastVisibleSequence: body.lastVisibleSequence,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/tasks/:taskId/respond`,
    { schema: ChatTaskRespondViewSchema },
    async (request, reply) => {
      try {
        const params = chatTaskParamsSchema.parse(request.params)
        const body = resolveTaskSchema.parse(request.body)
        const workspaceMemberId = await resolveRequestWorkspaceMemberId(
          params.workspaceId,
          request,
          reply
        )
        if (!workspaceMemberId) return undefined

        const task = await getTaskSummary(params.taskId)
        if (
          !task ||
          task.workspaceId !== params.workspaceId ||
          task.conversationId !== params.conversationId
        ) {
          reply.status(404).send({
            error: "Task not found",
            code: "task_not_found",
          })
          return undefined
        }

        const canView = await canUserViewTask({
          taskId: task.id,
          userId: getRequestUserId(request),
        })
        if (!canView) {
          reply.status(403).send({
            error: "You cannot access this task",
            code: "task_access_denied",
          })
          return undefined
        }

        const resolverParticipant = await getConversationParticipant({
          conversationId: params.conversationId,
          workspaceMemberId,
        })
        if (!resolverParticipant?.id) {
          reply.status(403).send({
            error: "You are not an active participant in this conversation",
            code: "task_resolver_not_participant",
          })
          return undefined
        }

        try {
          const resolveParamsBase = {
            taskId: task.id,
            resolverWorkspaceMemberId: workspaceMemberId,
            resolverParticipantId: resolverParticipant.id,
            commandId: body.commandId,
            baseRevision: body.baseRevision,
          }
          const resolveParams =
            "answers" in body
              ? {
                  ...resolveParamsBase,
                  answers: body.answers,
                  note: body.note,
                }
              : body.decision === TASK_DECISIONS[1]
                ? {
                    ...resolveParamsBase,
                    decision: body.decision,
                    note: body.note,
                  }
                : "preset" in body && "selectedGrantOptionId" in body
                  ? {
                      ...resolveParamsBase,
                      decision: body.decision,
                      preset: body.preset,
                      selectedGrantOptionId: body.selectedGrantOptionId,
                      note: body.note,
                    }
                  : {
                      ...resolveParamsBase,
                      decision: body.decision,
                      note: body.note,
                    }

          const result = await resolveTaskRequest(resolveParams)
          const taskForViewer = await enrichTaskForUser(
            result.task,
            getRequestUserId(request)
          )
          if (result.outcome === "conflict") {
            reply.status(409).send({
              error: "Task state changed before this submission was applied",
              code: "task_conflict",
              outcome: result.outcome,
              task: taskForViewer,
            })
            return undefined
          }
          return {
            outcome: result.outcome,
            task: taskForViewer,
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to resolve task"
          reply.status(400).send({
            error: message,
            code: "task_resolution_failed",
          })
          return undefined
        }
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  // ====== Stage 3: conversation CRUD ======

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/conversations`,
    { schema: ChatConversationListViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        return await listChatConversations({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/conversations/:conversationId`,
    { schema: ChatConversationEnvelopeViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        return await getChatConversationDetail({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "PATCH",
    `${CHAT_BASE_PATH}/conversations/:conversationId`,
    { schema: ChatConversationEnvelopeViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const body = patchConversationSchema.parse(request.body)
        return await patchChatConversation({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          title: body.title,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/participants`,
    { schema: ChatConversationEnvelopeViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const body = addParticipantsSchema.parse(request.body)
        reply.status(201)
        return await addChatConversationParticipants({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          workspaceMemberIds: body.workspaceMemberIds,
          actorIds: body.actorIds,
          remoteAgentIds: body.remoteAgentIds,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${CHAT_BASE_PATH}/conversations/:conversationId/participants/:participantId`,
    { schema: ChatParticipantRemovalViewSchema },
    async (request, reply) => {
      try {
        const params = removeParticipantParamsSchema.parse(request.params)
        return await removeChatConversationParticipant({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          participantId: params.participantId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/leave`,
    { schema: ChatParticipantRemovalViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        return await leaveChatConversation({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  // ====== Stage 7: typing + push token registration ======

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/typing`,
    { schema: ChatTypingBroadcastViewSchema },
    async (request, reply) => {
      try {
        const params = chatConversationParamsSchema.parse(request.params)
        const body = typingSchema.parse(request.body)
        return await broadcastTypingState({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          state: body.state,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/push-tokens`,
    { schema: ChatPushTokenRegistrationViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        const body = pushTokenSchema.parse(request.body)
        reply.status(201)
        return await registerChatPushToken({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          platform: body.platform,
          token: body.token,
          deviceLabel: body.deviceLabel,
          metadata: body.metadata,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "GET",
    `${CHAT_BASE_PATH}/push-tokens`,
    { schema: ChatPushTokenListViewSchema },
    async (request, reply) => {
      try {
        const params = chatWorkspaceParamsSchema.parse(request.params)
        return await listChatPushTokens({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    `${CHAT_BASE_PATH}/push-tokens/:tokenId`,
    { schema: ChatPushTokenDeleteViewSchema },
    async (request, reply) => {
      try {
        const params = z
          .object({
            workspaceId: chatUuidSchema,
            tokenId: chatUuidSchema,
          })
          .parse(request.params)
        return await deleteChatPushToken({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          tokenId: params.tokenId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )

  // Retry a failed assistant turn (e.g. after a model_error_notice).
  appRoute(
    app,
    "POST",
    `${CHAT_BASE_PATH}/conversations/:conversationId/messages/:itemId/retry`,
    { schema: ChatMessageRetryViewSchema },
    async (request, reply) => {
      try {
        const params = z
          .object({
            workspaceId: chatUuidSchema,
            conversationId: chatUuidSchema,
            itemId: chatUuidSchema,
          })
          .parse(request.params)
        return await retryAssistantMessage({
          workspaceId: params.workspaceId,
          userId: getRequestUserId(request),
          conversationId: params.conversationId,
          itemId: params.itemId,
        })
      } catch (error) {
        replyChatError(reply, error)
        return undefined
      }
    }
  )
}
