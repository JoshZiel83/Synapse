import { randomUUID } from "node:crypto"
import type { FastifyRequest, FastifyReply } from "fastify"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { textBlock } from "@synapse/shared"
import { z } from "zod"
import {
  authenticateMachineForRemoteAgent,
  checkRemoteAgentMessages,
  completeRemoteAgentDeliveries,
  getMachineKeyFromHeaders,
  getRemoteAgentConversationHistory,
  listRemoteAgentConversations,
  searchRemoteAgentMessages,
  sendRemoteAgentConversationMessage,
} from "./service.js"
import { requireRemoteAgentConversationAccess } from "../chat/service.js"
import { executeSql } from "../../infrastructure/database/kysely.js"

type EndpointKey = string

type ActiveTransport = {
  transport: StreamableHTTPServerTransport
  server: McpServer
  remoteAgentId: string
  conversationId: string
  machineKey: string
  lastActivityAt: number
}

const transports = new Map<EndpointKey, ActiveTransport>()
const IDLE_TIMEOUT_MS = 10 * 60_000

function endpointKey(remoteAgentId: string, conversationId: string) {
  return `${remoteAgentId}:${conversationId}`
}

function jsonToolResult<T extends Record<string, unknown>>(
  structuredContent: T
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  }
}

function buildPerConversationMcpServer(params: {
  remoteAgentId: string
  conversationId: string
  machineKey: string
}) {
  const server = new McpServer(
    {
      name: "synapse",
      version: "0.1.0",
    },
    { capabilities: { logging: {} } }
  )

  server.registerTool(
    "list_conversations",
    {
      description:
        "List conversations this remote agent participates in, including unread counts.",
      inputSchema: {},
      outputSchema: { conversations: z.array(z.any()) },
    },
    async () => {
      const result = await listRemoteAgentConversations({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
      })
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "check_messages",
    {
      description: "Return pending message deliveries for this remote agent.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: { deliveries: z.array(z.any()) },
    },
    async ({ limit }) => {
      const result = await checkRemoteAgentMessages({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        limit,
      })
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "read_history",
    {
      description:
        "Read visible conversation history for the conversation bound to this MCP session.",
      inputSchema: {
        afterSequence: z.number().int().min(0).optional(),
        beforeSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: { items: z.array(z.any()) },
    },
    async ({ afterSequence, beforeSequence, limit }) => {
      const result = await getRemoteAgentConversationHistory({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        afterSequence,
        beforeSequence,
        limit,
      })
      const deliveryRows = await executeSql<{ id: string; item_id: string }>(
        `
          SELECT delivery.id, delivery.item_id
          FROM remote_agent_message_deliveries delivery
          WHERE delivery.remote_agent_id = $1
            AND delivery.conversation_id = $2
            AND delivery.status = 'pending'
        `,
        [params.remoteAgentId, params.conversationId]
      )
      const itemIds = new Set(
        result.items
          .map((item) =>
            item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : null
          )
          .filter((value): value is string => Boolean(value))
      )
      const completedDeliveryIds = deliveryRows.rows
        .filter((row) => itemIds.has(row.item_id))
        .map((row) => row.id)
      if (completedDeliveryIds.length > 0) {
        await completeRemoteAgentDeliveries({
          remoteAgentId: params.remoteAgentId,
          machineKey: params.machineKey,
          deliveryIds: completedDeliveryIds,
        })
      }
      return jsonToolResult(result)
    }
  )

  server.registerTool(
    "send_message",
    {
      description:
        "Send a text reply into the bound Synapse conversation as this remote agent.",
      inputSchema: {
        content: z.string().trim().min(1).max(20000),
        replyToItemId: z.string().uuid().optional(),
      },
      outputSchema: { item: z.any() },
    },
    async ({ content, replyToItemId }) => {
      const result = await sendRemoteAgentConversationMessage({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        clientMessageId: randomUUID(),
        contentBlocks: [textBlock(content)],
        replyToItemId,
      })
      return jsonToolResult({ item: result.item })
    }
  )

  server.registerTool(
    "search_messages",
    {
      description: "Search visible messages inside the bound conversation.",
      inputSchema: {
        query: z.string().trim().min(1).max(512),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: { matches: z.array(z.any()) },
    },
    async ({ query, limit }) => {
      const result = await searchRemoteAgentMessages({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        query,
        limit,
      })
      return jsonToolResult(result)
    }
  )

  return server
}

function reapIdleTransports() {
  const now = Date.now()
  for (const [key, active] of transports) {
    if (now - active.lastActivityAt > IDLE_TIMEOUT_MS) {
      transports.delete(key)
      void active.server.close().catch(() => undefined)
      void active.transport.close().catch(() => undefined)
    }
  }
}

setInterval(reapIdleTransports, 60_000).unref?.()

async function ensureTransport(params: {
  remoteAgentId: string
  conversationId: string
  machineKey: string
}) {
  const key = endpointKey(params.remoteAgentId, params.conversationId)
  const existing = transports.get(key)
  if (existing) {
    existing.lastActivityAt = Date.now()
    return existing
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  const server = buildPerConversationMcpServer(params)
  await server.connect(transport)
  const active: ActiveTransport = {
    transport,
    server,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    machineKey: params.machineKey,
    lastActivityAt: Date.now(),
  }
  transports.set(key, active)
  transport.onclose = () => {
    transports.delete(key)
  }
  return active
}

export async function handleRemoteAgentMcpRequest(
  request: FastifyRequest<{
    Params: { remoteAgentId: string; conversationId: string }
  }>,
  reply: FastifyReply
) {
  const machineKey = getMachineKeyFromHeaders(request)
  try {
    await authenticateMachineForRemoteAgent({
      remoteAgentId: request.params.remoteAgentId,
      machineKey,
    })
    await requireRemoteAgentConversationAccess(
      { query: (text: string, values?: any[]) => executeSql(text, values) },
      request.params.conversationId,
      request.params.remoteAgentId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(401).send({ error: message })
  }

  const active = await ensureTransport({
    remoteAgentId: request.params.remoteAgentId,
    conversationId: request.params.conversationId,
    machineKey,
  })

  reply.hijack()
  try {
    await active.transport.handleRequest(
      request.raw,
      reply.raw,
      (request as any).body
    )
  } catch (error) {
    if (!reply.raw.headersSent) {
      try {
        reply.raw.statusCode = 500
        reply.raw.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        )
      } catch {}
    }
  }
}

export function __clearMcpEndpointStateForTest() {
  for (const active of transports.values()) {
    void active.server.close().catch(() => undefined)
    void active.transport.close().catch(() => undefined)
  }
  transports.clear()
}
