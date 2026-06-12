import type { FastifyInstance, FastifyReply } from "fastify"
import {
  RemoteAgentListResponseSchema,
  RemoteAgentResponseSchema,
  RemoteAgentGroupTaskGrantsResponseSchema,
  RemoteAgentMachinePairingSessionResponseSchema,
  RemoteAgentMachineListResponseSchema,
  RemoteAgentMachineDetailResponseSchema,
} from "@synapse/shared/schemas"
import { z } from "zod"
import { REMOTE_AGENT_RUNTIME_KINDS } from "@synapse/shared"
// /api/v1/internal/* is the daemon↔API machine RPC surface (wireRoute). Its
// body/query contracts are single-sourced in @synapse/device-protocol so the
// API parser and the daemon client reference one definition (round-6 P1-5).
import {
  RemoteAgentUserInputTaskBodySchema,
  RemoteAgentPlanApprovalTaskBodySchema,
  RemoteAgentSendMessageBodySchema,
  RemoteAgentCompleteDeliveriesBodySchema,
  RemoteAgentFailDeliveriesBodySchema,
  RemoteAgentHistoryQuerySchema,
  RemoteAgentCheckMessagesQuerySchema,
  RemoteAgentSearchMessagesQuerySchema,
} from "@synapse/device-protocol"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
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
import {
  presentGroupTaskGrant,
  presentMachineBinding,
  presentMachineFromCamelRow,
  presentMachineListItem,
  presentMessageDelivery,
  presentRemoteAgent,
  presentRemoteAgentConversation,
  presentRuntimeCatalogEntry,
} from "./presenter.js"

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

// Machine RPC body/query contracts (daemon↔API). Single-sourced in
// @synapse/device-protocol — these aliases keep the route handlers terse.
const historyQuerySchema = RemoteAgentHistoryQuerySchema
const checkMessagesQuerySchema = RemoteAgentCheckMessagesQuerySchema
const searchMessagesQuerySchema = RemoteAgentSearchMessagesQuerySchema
const sendMessageSchema = RemoteAgentSendMessageBodySchema
const completeDeliveriesSchema = RemoteAgentCompleteDeliveriesBodySchema
const failDeliveriesSchema = RemoteAgentFailDeliveriesBodySchema
const internalUserInputTaskSchema = RemoteAgentUserInputTaskBodySchema
const internalPlanApprovalTaskSchema = RemoteAgentPlanApprovalTaskBodySchema

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

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agents",
    {
      schema: RemoteAgentListResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      try {
        const { remoteAgents } = await listRemoteAgents({
          workspaceId: request.params.workspaceId,
          userId: getRequestUserId(request),
        })
        return {
          remoteAgents: remoteAgents.map((rec) =>
            presentRemoteAgent(rec, rec.requiresContactApproval)
          ),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId",
    {
      schema: RemoteAgentResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      try {
        const { remoteAgent } = await getRemoteAgent({
          workspaceId: request.params.workspaceId,
          remoteAgentId: request.params.remoteAgentId,
          userId: getRequestUserId(request),
        })
        return {
          remoteAgent: presentRemoteAgent(
            remoteAgent,
            remoteAgent.requiresContactApproval
          ),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/bind",
    {
      schema: RemoteAgentResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
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
        const { remoteAgent } = await bindRemoteAgent({
          workspaceId: request.params.workspaceId,
          remoteAgentId: request.params.remoteAgentId,
          userId: getRequestUserId(request),
          machineId: body.machineId,
          runtimeKind: body.runtimeKind,
          runtimePath: body.runtimePath,
          localRootPath: body.localRootPath,
        })
        return {
          remoteAgent: presentRemoteAgent(
            remoteAgent,
            remoteAgent.requiresContactApproval
          ),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/group-task-grants",
    {
      schema: RemoteAgentGroupTaskGrantsResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      const allowed = await requireRequestAction(
        request,
        reply,
        "remote_agent.grant",
        request.params.remoteAgentId,
        "Not allowed to manage this remote agent grant state"
      )
      if (!allowed) return
      try {
        const { grants } = await listRemoteAgentGroupTaskGrants({
          workspaceId: request.params.workspaceId,
          remoteAgentId: request.params.remoteAgentId,
          userId: getRequestUserId(request),
        })
        return {
          grants: grants.map((grant) =>
            presentGroupTaskGrant(grant, grant.avatarUrl)
          ),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "PUT",
    "/api/v1/workspaces/:workspaceId/remote-agents/:remoteAgentId/group-task-grants",
    {
      schema: RemoteAgentGroupTaskGrantsResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
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
        const { grants } = await updateRemoteAgentGroupTaskGrants({
          workspaceId: request.params.workspaceId,
          remoteAgentId: request.params.remoteAgentId,
          userId: getRequestUserId(request),
          workspaceMemberIds: body.workspaceMemberIds,
        })
        return {
          grants: grants.map((grant) =>
            presentGroupTaskGrant(grant, grant.avatarUrl)
          ),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/remote-agent-machines/pairing-sessions",
    {
      schema: RemoteAgentMachinePairingSessionResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      if (!(await requireWorkspaceRemoteAgentAdmin(request, reply))) return
      try {
        const body = createMachineSchema.parse(request.body)
        const session = await createRemoteAgentMachinePairingSession({
          workspaceId: request.params.workspaceId,
          userId: getRequestUserId(request),
          title: body.title,
          description: body.description,
        })
        reply.status(201)
        return {
          machine: presentMachineFromCamelRow(session.machine),
          apiKey: session.apiKey,
          daemonCommand: session.daemonCommand,
          oneClickCommands: session.oneClickCommands,
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agent-machines",
    {
      schema: RemoteAgentMachineListResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      try {
        const { machines } = await listRemoteAgentMachines({
          workspaceId: request.params.workspaceId,
          userId: getRequestUserId(request),
        })
        return {
          machines: machines.map(presentMachineListItem),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/remote-agent-machines/:machineId",
    {
      schema: RemoteAgentMachineDetailResponseSchema,
      options: { preHandler: workspacePreHandler },
    },
    async (request: any, reply) => {
      try {
        const detail = await getRemoteAgentMachine({
          workspaceId: request.params.workspaceId,
          machineId: request.params.machineId,
          userId: getRequestUserId(request),
        })
        return {
          machine: presentMachineFromCamelRow(detail.machine),
          runtimeCatalog: detail.runtimeCatalog.map(presentRuntimeCatalogEntry),
          bindings: detail.bindings.map(presentMachineBinding),
        }
      } catch (error) {
        return sendServiceError(reply, error)
      }
    }
  )

  for (const prefix of internalPrefixes) {
    const mcpRoute = `${prefix}/remote-agents/:remoteAgentId/mcp/:conversationId`
    const mcpHandler = (request: any, reply: FastifyReply) =>
      handleRemoteAgentMcpRequest(request, reply)
    wireRoute(app, "POST", mcpRoute, {}, mcpHandler)
    wireRoute(app, "GET", mcpRoute, {}, mcpHandler)
    wireRoute(app, "DELETE", mcpRoute, {}, mcpHandler)

    wireRoute(
      app,
      "POST",
      `${prefix}/remote-agents/:remoteAgentId/tasks/user-input`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "POST",
      `${prefix}/remote-agents/:remoteAgentId/tasks/plan-approval`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "GET",
      `${prefix}/remote-agents/:remoteAgentId/conversations`,
      {},
      async (request: any, reply) => {
        try {
          const { conversations } = await listRemoteAgentConversations({
            remoteAgentId: request.params.remoteAgentId,
            machineKey: getMachineKeyFromHeaders(request),
          })
          return reply.send({
            conversations: conversations.map(presentRemoteAgentConversation),
          })
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    wireRoute(
      app,
      "GET",
      `${prefix}/remote-agents/:remoteAgentId/check-messages`,
      {},
      async (request: any, reply) => {
        try {
          const query = checkMessagesQuerySchema.parse(request.query)
          const { deliveries } = await checkRemoteAgentMessages({
            remoteAgentId: request.params.remoteAgentId,
            machineKey: getMachineKeyFromHeaders(request),
            limit: query.limit,
          })
          return reply.send({
            deliveries: deliveries.map(presentMessageDelivery),
          })
        } catch (error) {
          return sendServiceError(reply, error)
        }
      }
    )

    wireRoute(
      app,
      "POST",
      `${prefix}/remote-agents/:remoteAgentId/complete-deliveries`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "POST",
      `${prefix}/remote-agents/:remoteAgentId/fail-deliveries`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "GET",
      `${prefix}/remote-agents/:remoteAgentId/history/:conversationId`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "POST",
      `${prefix}/remote-agents/:remoteAgentId/send`,
      {},
      async (request: any, reply) => {
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

    wireRoute(
      app,
      "GET",
      `${prefix}/remote-agents/:remoteAgentId/search`,
      {},
      async (request: any, reply) => {
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
