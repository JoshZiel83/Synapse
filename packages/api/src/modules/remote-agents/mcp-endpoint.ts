import { randomUUID } from "node:crypto"
import type { FastifyRequest, FastifyReply } from "fastify"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { textBlock, type ToolDefinition } from "@synapse/shared"
import type { ConversationBoundary } from "@synapse/shared/types"
import { z, type ZodTypeAny } from "zod"
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
import { resolveMcpToolsForRemoteAgent } from "../mcp-plugins/tool-resolver.js"

type ActiveTransport = {
  transport: StreamableHTTPServerTransport
  server: McpServer
  remoteAgentId: string
  conversationId: string
  shutdown: () => Promise<void>
  lastActivityAt: number
}

/** Map of MCP session id → live transport. Stateful Streamable-HTTP mode. */
const transportsBySessionId = new Map<string, ActiveTransport>()
const IDLE_TIMEOUT_MS = 10 * 60_000

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

function jsonSchemaPropertyToZod(prop: unknown): ZodTypeAny {
  if (!prop || typeof prop !== "object") return z.any()
  const p = prop as { type?: string | string[]; enum?: unknown[] }
  if (Array.isArray(p.enum) && p.enum.every((v) => typeof v === "string")) {
    return z.enum(p.enum as [string, ...string[]])
  }
  const t = Array.isArray(p.type) ? p.type[0] : p.type
  switch (t) {
    case "string":
      return z.string()
    case "number":
    case "integer":
      return z.number()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(z.any())
    case "object":
      return z.record(z.any())
    default:
      return z.any()
  }
}

function toolDefinitionToZodShape(
  def: ToolDefinition
): Record<string, ZodTypeAny> {
  const shape: Record<string, ZodTypeAny> = {}
  const required = new Set(def.parameters?.required ?? [])
  for (const [key, prop] of Object.entries(def.parameters?.properties ?? {})) {
    const base = jsonSchemaPropertyToZod(prop)
    shape[key] = required.has(key) ? base : base.optional()
  }
  return shape
}

function registerImTools(params: {
  server: McpServer
  remoteAgentId: string
  conversationId: string
  machineKey: string
}) {
  const { server } = params
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
      description:
        "Return pending message deliveries for the conversation this MCP session is bound to.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
      outputSchema: { deliveries: z.array(z.any()) },
    },
    async ({ limit }) => {
      // Scoping to params.conversationId is load-bearing for session
      // isolation: a per-conversation runtime asking the IM surface for
      // "what's queued?" must never see another conversation's deliveries,
      // even though the underlying remote_agent participates in many.
      const result = await checkRemoteAgentMessages({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
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
}

async function registerResolvedTools(params: {
  server: McpServer
  workspaceId: string
  remoteAgentId: string
  conversationId: string
  conversationKind: "private" | "group" | "virtual"
  conversationBoundary: ConversationBoundary
  sessionKey: string
}): Promise<() => Promise<void>> {
  // The resolver evaluates resource_access_bindings exactly like an actor
  // would (workspace + conversation grants for the remote-agent path) and
  // returns ready-to-execute plugin + relay tool definitions. We mount each
  // one as a passthrough that calls back into the same executor.
  //
  // conversationKind + conversationBoundary are LOAD-BEARING here: the
  // resolver's conversation_type mask filter (loadVisiblePlugins +
  // loadVisibleRelayExposures) rejects rows that don't match the conversation
  // type, and shared/utils:maskAllowsConversationType returns false when
  // either field is missing. Without these two values plugin / relay tools
  // would be silently filtered out even when authorization passes.
  const resolved = await resolveMcpToolsForRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    conversationKind: params.conversationKind,
    conversationBoundary: params.conversationBoundary,
    sessionId: params.sessionKey,
  })
  for (const def of resolved.tools as ToolDefinition[]) {
    try {
      params.server.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: toolDefinitionToZodShape(def),
        },
        async (input: Record<string, unknown>) => {
          const output = await resolved.executor(def.name, input ?? {})
          return {
            content: Array.isArray(output.content)
              ? (output.content as any)
              : [
                  {
                    type: "text" as const,
                    text: JSON.stringify(output, null, 2),
                  },
                ],
            isError: output.isError ?? undefined,
          }
        }
      )
    } catch (error) {
      console.warn(
        "[remote-agent mcp] tool registration skipped",
        def.name,
        error instanceof Error ? error.message : error
      )
    }
  }
  return resolved.shutdown
}

function reapIdleTransports() {
  const now = Date.now()
  for (const [sessionId, active] of transportsBySessionId) {
    if (now - active.lastActivityAt > IDLE_TIMEOUT_MS) {
      transportsBySessionId.delete(sessionId)
      void active.shutdown().catch(() => undefined)
      void active.server.close().catch(() => undefined)
      void active.transport.close().catch(() => undefined)
    }
  }
}

setInterval(reapIdleTransports, 60_000).unref?.()

function extractMcpSessionId(request: FastifyRequest): string | undefined {
  const raw = request.headers["mcp-session-id"]
  if (Array.isArray(raw)) return raw[0]
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return undefined
}

async function createSessionTransport(params: {
  remoteAgentId: string
  conversationId: string
  machineKey: string
  workspaceId: string
  conversationKind: "private" | "group" | "virtual"
  conversationBoundary: ConversationBoundary
}): Promise<ActiveTransport> {
  // sessionId is used downstream as a cache scope (relay tool runtime context
  // map keys, "session:<id>:turn:<uuid>" reuse keys) AND historically fed into
  // a UUID-typed column lookup in subject-resolution. The subject-resolution
  // path is now gated on actorId so non-UUID values are safe there, but we
  // still hand the resolver a real UUID so any future caller that treats
  // sessionId as a UUID does not silently break the reverse-MCP surface.
  const sessionKey = randomUUID()
  const server = new McpServer(
    { name: "synapse", version: "0.1.0" },
    { capabilities: { logging: {} } }
  )
  registerImTools({
    server,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    machineKey: params.machineKey,
  })
  // Deliberately NOT wrapped in try/catch: an earlier version swallowed the
  // resolver failure and mounted only the IM tools, which meant a UUID-column
  // crash in the resolver looked like a clean tools/list to the caller while
  // plugin/relay grants silently disappeared. Re-throwing here makes the
  // failure surface as an initialize HTTP 500 — the loud failure mode is the
  // correct one for the "tool projection" acceptance point in the plan.
  const pluginShutdown = await registerResolvedTools({
    server,
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    conversationKind: params.conversationKind,
    conversationBoundary: params.conversationBoundary,
    sessionKey,
  })
  let storedSessionId: string | undefined
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      storedSessionId = id
      transportsBySessionId.set(id, active)
    },
  })
  const active: ActiveTransport = {
    transport,
    server,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    shutdown: pluginShutdown,
    lastActivityAt: Date.now(),
  }
  transport.onclose = () => {
    if (storedSessionId) transportsBySessionId.delete(storedSessionId)
  }
  await server.connect(transport)
  return active
}

async function loadConversationTypeFacts(conversationId: string): Promise<{
  kind: "private" | "group" | "virtual"
  boundary: ConversationBoundary
} | null> {
  const result = await executeSql<{
    kind: "private" | "group" | "virtual"
    boundary: ConversationBoundary
  }>(`SELECT kind, boundary FROM conversations WHERE id = $1 LIMIT 1`, [
    conversationId,
  ])
  return result.rows[0] ?? null
}

export async function handleRemoteAgentMcpRequest(
  request: FastifyRequest<{
    Params: { remoteAgentId: string; conversationId: string }
  }>,
  reply: FastifyReply
) {
  const machineKey = getMachineKeyFromHeaders(request)
  // Authentication (machineKey) and authorization (conversation belongs to
  // this remote_agent) are split deliberately:
  //   - 401 means "we couldn't identify the caller" → bad/missing machineKey,
  //     or the machine isn't bound to this remote_agent at all.
  //   - 403 means "you authenticated fine, but the conversation isn't yours"
  //     → the remote_agent isn't an active participant of that conversation.
  // Treating both as 401 would let a leaked machineKey probe the
  // conversation-id space and learn which ones exist by status code alone.
  let workspaceId: string
  try {
    const auth = await authenticateMachineForRemoteAgent({
      remoteAgentId: request.params.remoteAgentId,
      machineKey,
    })
    workspaceId = auth.workspaceId
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(401).send({ error: message })
  }
  try {
    await requireRemoteAgentConversationAccess(
      { query: (text: string, values?: any[]) => executeSql(text, values) },
      request.params.conversationId,
      request.params.remoteAgentId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(403).send({ error: message })
  }
  const conversationFacts = await loadConversationTypeFacts(
    request.params.conversationId
  )
  if (!conversationFacts) {
    return reply.code(404).send({ error: "Conversation not found" })
  }

  const sessionId = extractMcpSessionId(request)
  let active: ActiveTransport | undefined
  if (sessionId) {
    active = transportsBySessionId.get(sessionId)
    if (
      active &&
      (active.remoteAgentId !== request.params.remoteAgentId ||
        active.conversationId !== request.params.conversationId)
    ) {
      // Mcp-Session-Id is global. Cross-(agent, conversation) reuse would let
      // a different agent's session be commandeered just by including the id;
      // refuse instead of silently routing.
      return reply.code(404).send({ error: "Unknown MCP session id" })
    }
  }
  if (!active) {
    if (sessionId) {
      return reply.code(404).send({ error: "Unknown MCP session id" })
    }
    if (!isInitializeRequest((request as any).body)) {
      return reply
        .code(400)
        .send({ error: "First request must be an MCP initialize" })
    }
    active = await createSessionTransport({
      remoteAgentId: request.params.remoteAgentId,
      conversationId: request.params.conversationId,
      machineKey,
      workspaceId,
      conversationKind: conversationFacts.kind,
      conversationBoundary: conversationFacts.boundary,
    })
  }
  active.lastActivityAt = Date.now()

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
  for (const active of transportsBySessionId.values()) {
    void active.shutdown().catch(() => undefined)
    void active.server.close().catch(() => undefined)
    void active.transport.close().catch(() => undefined)
  }
  transportsBySessionId.clear()
}
