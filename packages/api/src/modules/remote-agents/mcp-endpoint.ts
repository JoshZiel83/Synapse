import { randomUUID } from "node:crypto"
import type { FastifyRequest, FastifyReply } from "fastify"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  isInitializeRequest,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  RemoteAgentMcpCheckMessagesToolInputSchema,
  RemoteAgentMcpListConversationsToolInputSchema,
  RemoteAgentMcpReadHistoryToolInputSchema,
  RemoteAgentMcpSearchMessagesToolInputSchema,
  RemoteAgentMcpSendMessageToolInputSchema,
  type RemoteAgentMcpCheckMessagesToolInput,
  type RemoteAgentMcpReadHistoryToolInput,
  type RemoteAgentMcpSearchMessagesToolInput,
  type RemoteAgentMcpSendMessageToolInput,
} from "@synapse/device-protocol"
import {
  textBlock,
  computeWireNames,
  type ToolDefinition,
  type ProjectedToolDefinition,
  type ToolRef,
  type NamePolicyItem,
} from "@synapse/shared"
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
import {
  presentMessageDelivery,
  presentRemoteAgentConversation,
} from "./presenter.js"
import { listPendingDeliveryRefs, getConversationTypeFacts } from "./repo.js"
import { requireRemoteAgentConversationAccessOnDefaultDb } from "../chat/remote-agent-bridge.js"
import { projectToolsForPrincipal } from "../capability-projection/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("remote-agent.mcp")

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

type McpToolResult = {
  content: Array<Record<string, unknown>>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/**
 * A registered tool in the unified reverse-MCP registry.
 *
 * `inputSchema` is the JSON Schema advertised to the caller via tools/list —
 * for IM tools it is derived once from `zodSchema` (so the SAME schema both
 * validates input and is advertised); for projected plugin/device tools it is
 * the tool's lossless `rawInputSchema` (or the lossy `parameters` projection as
 * a fallback). When `zodSchema` is present, call_tool validates input against it
 * BEFORE dispatch — projected tools are validated downstream by their executor.
 */
type RegisteredTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  zodSchema?: z.ZodType
  handler: (input: Record<string, unknown>) => Promise<McpToolResult>
}

export type RemoteAgentMcpToolForTest = Pick<
  RegisteredTool,
  "name" | "inputSchema" | "zodSchema"
>

function jsonToolResult<T extends Record<string, unknown>>(
  structuredContent: T
): McpToolResult {
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

/** Convert the exact Zod schema used for validation into tools/list JSON Schema. */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readMcpToolContentBlocks(
  content: unknown
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(content)) return null
  if (!content.every(isRecord)) return null
  return content
}

// PR #14: surface a [device:<name>] / [plugin:<name>] / [skill:<name>]
// origin badge in the tool description so reverse-MCP callers can attribute
// results back to the source. Reads the structured ToolRef (Layer A).
function describeToolOrigin(ref: ToolRef): string {
  switch (ref.source.kind) {
    case "device":
      return ref.source.deviceName
        ? `[device:${ref.source.deviceName}]`
        : "[device]"
    case "plugin":
      return `[plugin:${ref.source.installationId}]`
    case "system":
      return ""
  }
}

function buildImTools(params: {
  remoteAgentId: string
  conversationId: string
  machineKey: string
}): RegisteredTool[] {
  const tools: RegisteredTool[] = []

  tools.push({
    name: "list_conversations",
    description:
      "List conversations this remote agent participates in, including unread counts.",
    inputSchema: zodToJsonSchema(
      RemoteAgentMcpListConversationsToolInputSchema
    ),
    zodSchema: RemoteAgentMcpListConversationsToolInputSchema,
    handler: async () => {
      const { conversations } = await listRemoteAgentConversations({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
      })
      return jsonToolResult({
        conversations: conversations.map(presentRemoteAgentConversation),
      })
    },
  })

  tools.push({
    name: "check_messages",
    description:
      "Return pending message deliveries for the conversation this MCP session is bound to.",
    inputSchema: zodToJsonSchema(RemoteAgentMcpCheckMessagesToolInputSchema),
    zodSchema: RemoteAgentMcpCheckMessagesToolInputSchema,
    handler: async (input) => {
      const { limit } = input as RemoteAgentMcpCheckMessagesToolInput
      // Scoping to params.conversationId is load-bearing for session
      // isolation: a per-conversation runtime asking the IM surface for
      // "what's queued?" must never see another conversation's deliveries.
      const { deliveries } = await checkRemoteAgentMessages({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        limit,
      })
      return jsonToolResult({
        deliveries: deliveries.map(presentMessageDelivery),
      })
    },
  })

  tools.push({
    name: "read_history",
    description:
      "Read visible conversation history for the conversation bound to this MCP session.",
    inputSchema: zodToJsonSchema(RemoteAgentMcpReadHistoryToolInputSchema),
    zodSchema: RemoteAgentMcpReadHistoryToolInputSchema,
    handler: async (input) => {
      const { after_sequence, before_sequence, limit } =
        input as RemoteAgentMcpReadHistoryToolInput
      const result = await getRemoteAgentConversationHistory({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        afterSequence: after_sequence,
        beforeSequence: before_sequence,
        limit,
      })
      const deliveryRows = await listPendingDeliveryRefs({
        remoteAgentId: params.remoteAgentId,
        conversationId: params.conversationId,
      })
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
      const completedDeliveryIds = deliveryRows
        .filter((row) => itemIds.has(row.itemId))
        .map((row) => row.id)
      if (completedDeliveryIds.length > 0) {
        await completeRemoteAgentDeliveries({
          remoteAgentId: params.remoteAgentId,
          machineKey: params.machineKey,
          deliveryIds: completedDeliveryIds,
        })
      }
      return jsonToolResult(result)
    },
  })

  tools.push({
    name: "send_message",
    description:
      "Send a text reply into the bound Synapse conversation as this remote agent.",
    inputSchema: zodToJsonSchema(RemoteAgentMcpSendMessageToolInputSchema),
    zodSchema: RemoteAgentMcpSendMessageToolInputSchema,
    handler: async (input) => {
      const { content, reply_to_item_id } =
        input as RemoteAgentMcpSendMessageToolInput
      const result = await sendRemoteAgentConversationMessage({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        clientMessageId: randomUUID(),
        contentBlocks: [textBlock(content)],
        replyToItemId: reply_to_item_id,
      })
      return jsonToolResult({ item: result.item })
    },
  })

  tools.push({
    name: "search_messages",
    description: "Search visible messages inside the bound conversation.",
    inputSchema: zodToJsonSchema(RemoteAgentMcpSearchMessagesToolInputSchema),
    zodSchema: RemoteAgentMcpSearchMessagesToolInputSchema,
    handler: async (input) => {
      const { query, limit } = input as RemoteAgentMcpSearchMessagesToolInput
      const result = await searchRemoteAgentMessages({
        remoteAgentId: params.remoteAgentId,
        machineKey: params.machineKey,
        conversationId: params.conversationId,
        query,
        limit,
      })
      return jsonToolResult(result)
    },
  })

  return tools
}

export function __buildImToolsForTest(params: {
  remoteAgentId: string
  conversationId: string
  machineKey: string
}): RemoteAgentMcpToolForTest[] {
  return buildImTools(params)
}

async function buildResolvedTools(params: {
  workspaceId: string
  remoteAgentId: string
  conversationId: string
  conversationKind: "direct" | "group"
  isImConversation: boolean
  sessionKey: string
  /** Names already taken on this surface (e.g. built-in IM tools). Projected
   *  plugin/device tools must qualify rather than shadow these. */
  reservedNames?: readonly string[]
}): Promise<{ tools: RegisteredTool[]; shutdown: () => Promise<void> }> {
  // The resolver evaluates workspace_resource_grants exactly like an actor would
  // and returns ready-to-execute plugin + device_capability tools.
  const resolved = await projectToolsForPrincipal({
    workspaceId: params.workspaceId,
    principal: {
      kind: "remote_agent",
      remoteAgentId: params.remoteAgentId,
      conversationId: params.conversationId,
    },
    conversationId: params.conversationId,
    conversationKind: params.conversationKind,
    isImConversation: params.isImConversation,
    consumer: "reverse_mcp",
    sessionId: params.sessionKey,
  })

  const tools: RegisteredTool[] = []
  const projected = resolved.tools as ProjectedToolDefinition[]
  // Build this surface's wire-name registry. Built-in IM tool names (passed as
  // reservedNames) are kept bare; a projected plugin/device tool that shares a
  // leaf name with one of them is forced to qualify, so it can never overwrite
  // the core IM handler in the unified byName registry.
  const items: NamePolicyItem[] = projected.map((def) => ({
    ref: def.ref,
    leafName: def.name,
  }))
  const registry = computeWireNames(items, params.reservedNames ?? [])
  const defByToolId = new Map<string, ProjectedToolDefinition>(
    projected.map((d) => [d.ref.toolId, d])
  )
  for (const [toolId, { wireName, ref }] of registry.byToolId) {
    const def = defByToolId.get(toolId)!
    const originBadge = describeToolOrigin(ref)
    const decoratedDescription = originBadge
      ? `${originBadge} ${def.description ?? ""}`.trim()
      : (def.description ?? "")
    // Prefer the lossless raw JSON Schema; fall back to the lossy `parameters`
    // projection. Projected tools are NOT re-validated here — their executor
    // performs domain validation downstream.
    const inputSchema: Record<string, unknown> =
      def.rawInputSchema ?? (def.parameters as Record<string, unknown>)
    tools.push({
      name: wireName,
      description: decoratedDescription,
      inputSchema,
      handler: async (input) => {
        const output = await resolved.executor(toolId, input ?? {})
        const content = readMcpToolContentBlocks(output.content)
        return {
          content: content ?? [
            {
              type: "text" as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
          isError: output.isError ?? undefined,
        }
      },
    })
  }
  return { tools, shutdown: resolved.shutdown }
}

/**
 * Register a single unified tool registry on the low-level Server via
 * setRequestHandler(ListTools/CallTool). This replaces per-tool
 * `registerTool(...)` so projected tools can advertise their full raw JSON
 * Schema without being forced through a lossy Zod round-trip, while IM tools
 * keep their Zod validation.
 */
function installUnifiedToolRegistry(
  server: McpServer,
  tools: RegisteredTool[]
): void {
  // Fail loud on a duplicate wire name rather than silently overwriting a
  // handler (e.g. a plugin tool shadowing a built-in IM tool). NamePolicy +
  // reservedNames should already prevent this; this is the backstop.
  const byName = new Map<string, RegisteredTool>()
  for (const t of tools) {
    if (byName.has(t.name)) {
      throw new Error(
        `Reverse-MCP tool name collision: "${t.name}" registered twice ` +
          `(a projected tool must not shadow a built-in/IM tool).`
      )
    }
    byName.set(t.name, t)
  }
  // Low-level handlers live on McpServer.server.
  const lowLevel = server.server
  lowLevel.registerCapabilities({ tools: {} })

  lowLevel.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  lowLevel.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${request.params.name}`,
          },
        ],
        isError: true,
      }
    }
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>
    let args = rawArgs
    // IM tools validate input against their Zod schema before dispatch (the
    // old registerTool() did this automatically; the low-level path must do it
    // explicitly so bad input is rejected, not silently accepted).
    if (tool.zodSchema) {
      const parsed = tool.zodSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
            },
          ],
          isError: true,
        }
      }
      args = parsed.data as Record<string, unknown>
    }
    try {
      return await tool.handler(args)
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      }
    }
  })
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
  conversationKind: "direct" | "group"
  isImConversation: boolean
}): Promise<ActiveTransport> {
  const sessionKey = randomUUID()
  const server = new McpServer(
    { name: "synapse", version: "0.1.0" },
    { capabilities: { logging: {} } }
  )
  const imTools = buildImTools({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    machineKey: params.machineKey,
  })
  // Deliberately NOT wrapped in try/catch: a resolver failure must surface as
  // an initialize HTTP 500, not silently drop plugin/device grants.
  const { tools: resolvedTools, shutdown: pluginShutdown } =
    await buildResolvedTools({
      workspaceId: params.workspaceId,
      remoteAgentId: params.remoteAgentId,
      conversationId: params.conversationId,
      conversationKind: params.conversationKind,
      isImConversation: params.isImConversation,
      sessionKey,
      // Reserve the built-in IM tool names so projected plugin/device tools
      // that share a leaf name qualify instead of shadowing the IM handler.
      reservedNames: imTools.map((t) => t.name),
    })
  installUnifiedToolRegistry(server, [...imTools, ...resolvedTools])

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

export async function handleRemoteAgentMcpRequest(
  request: FastifyRequest<{
    Params: { remoteAgentId: string; conversationId: string }
  }>,
  reply: FastifyReply
) {
  const machineKey = getMachineKeyFromHeaders(request)
  // Authentication (machineKey) and authorization (conversation belongs to
  // this remote_agent) are split deliberately:
  //   - 401 means "we couldn't identify the caller"
  //   - 403 means "you authenticated fine, but the conversation isn't yours"
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
    await requireRemoteAgentConversationAccessOnDefaultDb(
      request.params.conversationId,
      request.params.remoteAgentId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return reply.code(403).send({ error: message })
  }
  const conversationFacts = await getConversationTypeFacts(
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
      // a different agent's session be commandeered just by including the id.
      return reply.code(404).send({ error: "Unknown MCP session id" })
    }
  }
  if (!active) {
    if (sessionId) {
      return reply.code(404).send({ error: "Unknown MCP session id" })
    }
    if (!isInitializeRequest(request.body)) {
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
      isImConversation: conversationFacts.isIm,
    })
  }
  active.lastActivityAt = Date.now()

  reply.hijack()
  try {
    await active.transport.handleRequest(request.raw, reply.raw, request.body)
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
