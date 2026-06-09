import type { FastifyInstance, FastifyReply } from "fastify"
import { IsoInstantStringSchema } from "@synapse/shared/schemas"
import { z } from "zod"
import { REMOTE_AGENT_RUNTIME_KINDS } from "@synapse/shared"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
import {
  bindRemoteAgent,
  checkRemoteAgentMessages,
  completeRemoteAgentDeliveries,
  createRemoteAgentPlanApprovalTask,
  createRemoteAgentMachinePairingSession,
  createRemoteAgentUserInputTask,
  failRemoteAgentDeliveries,
  getMachineKeyFromHeaders,
  getRemoteAgent,
  getRemoteAgentConversationHistory,
  getRemoteAgentMachine,
  listRemoteAgentGroupTaskGrants,
  listRemoteAgentConversations,
  listRemoteAgentMachines,
  listRemoteAgents,
  searchRemoteAgentMessages,
  sendRemoteAgentConversationMessage,
  updateRemoteAgentGroupTaskGrants,
} from "./service.js"
import { handleRemoteAgentMcpRequest } from "./mcp-endpoint.js"

const runtimeKindSchema = z.enum(REMOTE_AGENT_RUNTIME_KINDS)
const createMachineSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).optional(),
})

const bindRemoteAgentSchema = z.object({
  machineId: z.uuid(),
  runtimeKind: runtimeKindSchema,
  runtimePath: z.string().trim().min(1).optional(),
  localRootPath: z.string().trim().min(1).optional(),
})

const groupTaskGrantsSchema = z.object({
  workspaceMemberIds: z.array(z.uuid()).max(200),
})

const historyQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).optional(),
  beforeSequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const checkMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

const searchMessagesQuerySchema = z.object({
  conversationId: z.uuid(),
  q: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const sendMessageSchema = z.object({
  conversationId: z.uuid(),
  clientMessageId: z.uuid().optional(),
  contentBlocks: z.array(z.any()).min(1),
  replyToItemId: z.uuid().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

const completeDeliveriesSchema = z.object({
  deliveryIds: z.array(z.uuid()).min(1),
})

const failDeliveriesSchema = z.object({
  deliveryIds: z.array(z.uuid()).min(1),
  reason: z.string().trim().max(2000).optional(),
})

const internalUserInputTaskSchema = z.object({
  conversationId: z.uuid(),
  runKey: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  instructions: z.string().trim().max(5000).optional(),
  questions: z.array(z.any()).min(1).max(4),
  expiresAt: IsoInstantStringSchema.optional(),
})

const internalPlanApprovalTaskSchema = z.object({
  conversationId: z.uuid(),
  runKey: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(255),
  summary: z.string().trim().max(5000).optional(),
  planMarkdown: z.string().trim().min(1),
  checklist: z.array(z.any()).optional(),
  collaborationMode: z.string().trim().max(120).optional(),
  collaborationState: z.record(z.string(), z.any()).optional(),
  expiresAt: IsoInstantStringSchema.optional(),
})

function getRequestUserId(request: any) {
  return (request as any).user!.userId as string
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  const message =
    error instanceof Error && error.message ? error.message : "Request failed"

  if (/not found/i.test(message)) {
    return reply.status(404).send({ error: message })
  }
  if (
    /not allowed|forbidden|access denied|authentication failed/i.test(message)
  ) {
    return reply.status(403).send({ error: message })
  }
  if (/required|invalid/i.test(message)) {
    return reply.status(400).send({ error: message })
  }
  return reply.status(400).send({ error: message })
}

async function requireWorkspaceRemoteAgentAdmin(
  request: any,
  reply: FastifyReply
) {
  return requireRequestAction(
    request,
    reply,
    "workspace.manage_remote_agents",
    request.params.workspaceId,
    "Not allowed to manage remote agents in this workspace"
  )
}

export default async function remoteAgentsController(app: FastifyInstance) {
  const workspacePreHandler = [authMiddleware, workspaceMiddleware]
  const internalPrefixes = ["/internal", "/api/v1/internal"] as const

  app.get<{
    Params: { workspaceId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agents",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await listRemoteAgents({
            workspaceId: request.params.workspaceId,
            userId: getRequestUserId(request),
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.get<{
    Params: { workspaceId: string; remoteAgentId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await getRemoteAgent({
            workspaceId: request.params.workspaceId,
            remoteAgentId: request.params.remoteAgentId,
            userId: getRequestUserId(request),
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.post<{
    Params: { workspaceId: string; remoteAgentId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/bind",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.edit",
        request.params.remoteAgentId,
        "Not allowed to bind this remote agent"
      )
      if (!allowed) return
      try {
        const body = bindRemoteAgentSchema.parse(request.body)
        return reply.send(
          await bindRemoteAgent({
            workspaceId: request.params.workspaceId,
            remoteAgentId: request.params.remoteAgentId,
            userId: getRequestUserId(request),
            machineId: body.machineId,
            runtimeKind: body.runtimeKind,
            runtimePath: body.runtimePath,
            localRootPath: body.localRootPath,
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.get<{
    Params: { workspaceId: string; remoteAgentId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/group-task-grants",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.grant",
        request.params.remoteAgentId,
        "Not allowed to manage this remote agent grant state"
      )
      if (!allowed) return
      try {
        return reply.send(
          await listRemoteAgentGroupTaskGrants({
            workspaceId: request.params.workspaceId,
            remoteAgentId: request.params.remoteAgentId,
            userId: getRequestUserId(request),
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.put<{
    Params: { workspaceId: string; remoteAgentId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/group-task-grants",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.grant",
        request.params.remoteAgentId,
        "Not allowed to manage this remote agent grant state"
      )
      if (!allowed) return
      try {
        const body = groupTaskGrantsSchema.parse(request.body)
        return reply.send(
          await updateRemoteAgentGroupTaskGrants({
            workspaceId: request.params.workspaceId,
            remoteAgentId: request.params.remoteAgentId,
            userId: getRequestUserId(request),
            workspaceMemberIds: body.workspaceMemberIds,
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.post<{
    Params: { workspaceId: string }
    Body: unknown
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agent-machines/pairing-sessions",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      if (!(await requireWorkspaceRemoteAgentAdmin(request, reply))) return
      try {
        const body = createMachineSchema.parse(request.body)
        return reply.status(201).send(
          await createRemoteAgentMachinePairingSession({
            workspaceId: request.params.workspaceId,
            userId: getRequestUserId(request),
            title: body.title,
            description: body.description,
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.get<{
    Params: { workspaceId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agent-machines",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await listRemoteAgentMachines({
            workspaceId: request.params.workspaceId,
            userId: getRequestUserId(request),
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  app.get<{
    Params: { workspaceId: string; machineId: string }
  }>(
    "/api/v1/workspaces/:workspaceId/remote-agent-machines/:machineId",
    { preHandler: workspacePreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await getRemoteAgentMachine({
            workspaceId: request.params.workspaceId,
            machineId: request.params.machineId,
            userId: getRequestUserId(request),
          })
        )
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  for (const prefix of internalPrefixes) {
    const mcpRoute = `${prefix}/remote-agents/:remoteAgentId/mcp/:conversationId`
    app.post<{
      Params: { remoteAgentId: string; conversationId: string }
    }>(mcpRoute, handleRemoteAgentMcpRequest)
    app.get<{
      Params: { remoteAgentId: string; conversationId: string }
    }>(mcpRoute, handleRemoteAgentMcpRequest)
    app.delete<{
      Params: { remoteAgentId: string; conversationId: string }
    }>(mcpRoute, handleRemoteAgentMcpRequest)

    app.post<{
      Params: { remoteAgentId: string }
      Body: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/tasks/user-input`,
      async (request, reply) => {
        try {
          const body = internalUserInputTaskSchema.parse(request.body)
          return reply.send(
            await createRemoteAgentUserInputTask({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              conversationId: body.conversationId,
              runKey: body.runKey,
              title: body.title,
              instructions: body.instructions,
              questions: body.questions,
              expiresAt: body.expiresAt,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.post<{
      Params: { remoteAgentId: string }
      Body: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/tasks/plan-approval`,
      async (request, reply) => {
        try {
          const body = internalPlanApprovalTaskSchema.parse(request.body)
          return reply.send(
            await createRemoteAgentPlanApprovalTask({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              conversationId: body.conversationId,
              runKey: body.runKey,
              title: body.title,
              summary: body.summary,
              planMarkdown: body.planMarkdown,
              checklist: body.checklist,
              collaborationMode: body.collaborationMode,
              collaborationState: body.collaborationState,
              expiresAt: body.expiresAt,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.get<{
      Params: { remoteAgentId: string }
    }>(
      `${prefix}/remote-agents/:remoteAgentId/conversations`,
      async (request, reply) => {
        try {
          return reply.send(
            await listRemoteAgentConversations({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.get<{
      Params: { remoteAgentId: string }
      Querystring: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/check-messages`,
      async (request, reply) => {
        try {
          const query = checkMessagesQuerySchema.parse(request.query)
          return reply.send(
            await checkRemoteAgentMessages({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              limit: query.limit,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.post<{
      Params: { remoteAgentId: string }
      Body: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/complete-deliveries`,
      async (request, reply) => {
        try {
          const body = completeDeliveriesSchema.parse(request.body)
          return reply.send(
            await completeRemoteAgentDeliveries({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              deliveryIds: body.deliveryIds,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.post<{
      Params: { remoteAgentId: string }
      Body: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/fail-deliveries`,
      async (request, reply) => {
        try {
          const body = failDeliveriesSchema.parse(request.body)
          return reply.send(
            await failRemoteAgentDeliveries({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              deliveryIds: body.deliveryIds,
              reason: body.reason,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.get<{
      Params: { remoteAgentId: string; conversationId: string }
      Querystring: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/history/:conversationId`,
      async (request, reply) => {
        try {
          const query = historyQuerySchema.parse(request.query)
          return reply.send(
            await getRemoteAgentConversationHistory({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              conversationId: request.params.conversationId,
              afterSequence: query.afterSequence,
              beforeSequence: query.beforeSequence,
              limit: query.limit,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.post<{
      Params: { remoteAgentId: string }
      Body: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/send`,
      async (request, reply) => {
        try {
          const body = sendMessageSchema.parse(request.body)
          return reply.send(
            await sendRemoteAgentConversationMessage({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              conversationId: body.conversationId,
              clientMessageId: body.clientMessageId,
              contentBlocks: body.contentBlocks,
              replyToItemId: body.replyToItemId,
              metadata: body.metadata,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    app.get<{
      Params: { remoteAgentId: string }
      Querystring: unknown
    }>(
      `${prefix}/remote-agents/:remoteAgentId/search`,
      async (request, reply) => {
        try {
          const query = searchMessagesQuerySchema.parse(request.query)
          return reply.send(
            await searchRemoteAgentMessages({
              remoteAgentId: request.params.remoteAgentId,
              machineKey: getMachineKeyFromHeaders(request),
              conversationId: query.conversationId,
              query: query.q,
              limit: query.limit,
            })
          )
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )
  }
}
