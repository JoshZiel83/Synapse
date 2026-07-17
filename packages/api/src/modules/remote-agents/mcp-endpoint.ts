// Reverse-MCP endpoint: the per-conversation MCP server the remote-agent
// daemon's spawned runtime (claude / codex CLI) talks back to over
// Streamable HTTP.
//
// TRACING RULE (remediation plan §4.C, runtime-probe-proven): NO traceparent
// is EVER injected into the agent-runtime MCP config (headers baked into the
// claude/codex MCP server entry). The runtime's config is frozen at spawn, so
// a static header would glue every tool call of a whole multi-turn session
// under one long-dead parent — strictly worse than no correlation. Instead,
// correlation is server-side: ONE self-created span per tools/call invocation
// (parented on `params._meta.{traceparent,tracestate}` per SEP-414 when a
// future runtime sends it, else the ambient request span) plus span LINKS to
// the delivery-origin traces of the turn (`synapse.link.kind=delivery_origin`)
// via the session-scoped turn-carrier cache. Do not "fix" this by adding a
// traceparent header to the runtime MCP config.

import { randomUUID } from "node:crypto"
import type { FastifyRequest, FastifyReply } from "fastify"
import {
  context,
  defaultTextMapGetter,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type Link,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
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
import { isValidTraceparent } from "../../infrastructure/observability/traceparent.js"
import { linkUpstreamTraces } from "../../workers/job-tracing.js"
import { MAX_TRACESTATE_LENGTH, type TraceCarrier } from "@synapse/shared"

const log = createLogger("remote-agent.mcp")
const tracer = trace.getTracer("synapse-remote-agent-mcp")
// Trace-context-only extraction for link building / `_meta` parenting — a
// PRIVATE propagator instance per the §3c carrier contract (never the global
// FirstPartyOnlyPropagator composite for manual carriers).
const carrierPropagator = new W3CTraceContextPropagator()

/**
 * Session-scoped cache of the turn's delivery-origin traceparents (deduped by
 * trace id, FIFO cap 20 — matches the origin_carriers wire cap). Every
 * tools/call span is created with LINKS to the cached origins;
 * check_messages / read_history refresh the cache from the delivery rows they
 * fetch and post-`addLink` the origins discovered mid-handler.
 */
const TURN_CARRIER_CAP = 20
export class TurnCarrierCache {
  private readonly byTraceId = new Map<string, string>()

  /**
   * Remember valid, previously unseen origin traceparents; returns the NEWLY
   * added ones (the post-fetch `addLink` set).
   */
  addAll(traceparents: Array<string | null | undefined>): string[] {
    const added: string[] = []
    for (const traceparent of traceparents) {
      if (!isValidTraceparent(traceparent)) continue
      const traceId = traceparent.slice(3, 35)
      if (this.byTraceId.has(traceId)) continue
      while (this.byTraceId.size >= TURN_CARRIER_CAP) {
        const oldest = this.byTraceId.keys().next().value
        if (oldest === undefined) break
        this.byTraceId.delete(oldest)
      }
      this.byTraceId.set(traceId, traceparent)
      added.push(traceparent)
    }
    return added
  }

  list(): string[] {
    return [...this.byTraceId.values()]
  }
}

/**
 * Creation-time span links for the turn's delivery-origin traces. Unsampled
 * origins are skipped (the head-sampled backend never stores them — same rule
 * as linkUpstreamTraces), as is the would-be self-link when an origin IS the
 * span's own trace (single-origin `_meta`/header-parented case).
 */
function deliveryOriginLinks(
  traceparents: readonly string[],
  ownTraceId: string | undefined
): Link[] {
  const links: Link[] = []
  for (const traceparent of traceparents) {
    const extracted = carrierPropagator.extract(
      ROOT_CONTEXT,
      { traceparent },
      defaultTextMapGetter
    )
    const spanContext = trace.getSpanContext(extracted)
    if (!spanContext || !isSpanContextValid(spanContext)) continue
    if (spanContext.traceId === ownTraceId) continue
    if ((spanContext.traceFlags & TraceFlags.SAMPLED) === 0) continue
    links.push({
      context: spanContext,
      attributes: { "synapse.link.kind": "delivery_origin" },
    })
  }
  return links
}

/**
 * Cache-refresh + mid-handler link step shared by the tools that fetch
 * delivery rows: newly discovered origins are LINKed onto the active
 * tools/call span (post-creation `addLink` — the rows are only knowable
 * inside the handler).
 */
function linkNewDeliveryOrigins(
  turnCarriers: TurnCarrierCache,
  originTraceparents: Array<string | null | undefined>
): void {
  const added = turnCarriers.addAll(originTraceparents)
  if (added.length > 0) {
    linkUpstreamTraces(added, "delivery_origin")
  }
}

type ActiveTransport = {
  transport: StreamableHTTPServerTransport
  server: McpServer
  remoteAgentId: string
  conversationId: string
  /** The session's delivery-origin trace cache (tools/call span links). */
  turnCarriers: TurnCarrierCache
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

// PR #14: surface a [runtime:<name>] / [plugin:<name>] origin badge in the tool
// description so reverse-MCP callers can attribute results back to the source
// (ToolSource kinds are system | plugin | runtime; system emits no badge).
// Reads the structured ToolRef (Layer A).
function describeToolOrigin(ref: ToolRef): string {
  switch (ref.source.kind) {
    case "runtime":
      return ref.source.runtimeName
        ? `[runtime:${ref.source.runtimeName}]`
        : "[runtime]"
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
  turnCarriers: TurnCarrierCache
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
      // Refresh the turn's origin cache + link origins discovered mid-handler
      // onto the active tools/call span. The presenter below deliberately
      // keeps origin_traceparent OUT of the agent-facing result.
      linkNewDeliveryOrigins(
        params.turnCarriers,
        deliveries.map((delivery) => delivery.originTraceparent)
      )
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
      // Refresh the turn's origin cache from the pending rows (see
      // check_messages) — origin_traceparent never reaches the tool result.
      linkNewDeliveryOrigins(
        params.turnCarriers,
        deliveryRows.map((row) => row.originTraceparent)
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
  return buildImTools({ ...params, turnCarriers: new TurnCarrierCache() })
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
  // and returns ready-to-execute plugin + runtime_capability tools.
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
 * The parent Context + SpanKind for one tools/call invocation (§4.C C3b):
 * a valid SEP-414 `params._meta.{traceparent,tracestate}` carrier wins
 * (SERVER — the caller propagated a remote parent; installed MCP SDK 1.29.0
 * parses `_meta` as a looseObject so the keys survive; claude/codex CLIs send
 * none today — future-proofing), else the AMBIENT context (INTERNAL — child
 * of the reverse-MCP HTTP request span).
 */
function toolCallParentContext(meta: unknown): {
  parentContext: Context
  kind: SpanKind
} {
  if (isRecord(meta) && isValidTraceparent(meta.traceparent)) {
    const carrier: TraceCarrier = { traceparent: meta.traceparent }
    if (
      typeof meta.tracestate === "string" &&
      meta.tracestate.length > 0 &&
      meta.tracestate.length <= MAX_TRACESTATE_LENGTH
    ) {
      carrier.tracestate = meta.tracestate
    }
    // Global-propagator extract is the sanctioned receiver path (P-D2: the
    // Sentry-ON composite extracts a plain carrier correctly).
    return {
      parentContext: propagation.extract(ROOT_CONTEXT, carrier),
      kind: SpanKind.SERVER,
    }
  }
  return { parentContext: context.active(), kind: SpanKind.INTERNAL }
}

/**
 * Register a single unified tool registry on the low-level Server via
 * setRequestHandler(ListTools/CallTool). This replaces per-tool
 * `registerTool(...)` so projected tools can advertise their full raw JSON
 * Schema without being forced through a lossy Zod round-trip, while IM tools
 * keep their Zod validation.
 *
 * Every invocation runs inside ONE self-created `tools/call {name}` span
 * (creation-time links to the turn's delivery-origin traces; `isError`
 * results mark ERROR; always ended in `finally`).
 */
function installUnifiedToolRegistry(
  server: McpServer,
  tools: RegisteredTool[],
  spanScope: {
    remoteAgentId: string
    conversationId: string
    turnCarriers: TurnCarrierCache
  }
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
    const name = request.params.name
    const { parentContext, kind } = toolCallParentContext(request.params._meta)
    const parentSpanContext = trace.getSpanContext(parentContext)
    const attributes: Attributes = {
      "mcp.method.name": "tools/call",
      "mcp.tool.name": name,
      "synapse.remote_agent.id": spanScope.remoteAgentId,
      "synapse.conversation.id": spanScope.conversationId,
    }
    return tracer.startActiveSpan(
      `tools/call ${name}`,
      {
        kind,
        attributes,
        // Creation-time links to the turn's delivery-origin traces —
        // send_message (and every other tool) joins the traces whose
        // deliveries fed this turn.
        links: deliveryOriginLinks(
          spanScope.turnCarriers.list(),
          parentSpanContext?.traceId
        ),
      },
      parentContext,
      async (span) => {
        const fail = (text: string) => {
          span.setStatus({ code: SpanStatusCode.ERROR, message: text })
          return {
            content: [{ type: "text" as const, text }],
            isError: true,
          }
        }
        try {
          const tool = byName.get(name)
          if (!tool) {
            return fail(`Unknown tool: ${name}`)
          }
          const rawArgs = (request.params.arguments ?? {}) as Record<
            string,
            unknown
          >
          let args = rawArgs
          // IM tools validate input against their Zod schema before dispatch
          // (the old registerTool() did this automatically; the low-level path
          // must do it explicitly so bad input is rejected, not silently
          // accepted).
          if (tool.zodSchema) {
            const parsed = tool.zodSchema.safeParse(rawArgs)
            if (!parsed.success) {
              return fail(
                `Invalid arguments for ${tool.name}: ${parsed.error.message}`
              )
            }
            args = parsed.data as Record<string, unknown>
          }
          try {
            const result = await tool.handler(args)
            if (result.isError) {
              span.setStatus({ code: SpanStatusCode.ERROR })
            }
            return result
          } catch (error) {
            span.recordException(error as Error)
            return fail(error instanceof Error ? error.message : String(error))
          }
        } finally {
          span.end()
        }
      }
    )
  })
}

/**
 * Test seams for the CallTool span matrix (mcp-endpoint.test.ts): the
 * registry installer takes any object shaped like `McpServer` (only
 * `server.registerCapabilities` / `server.setRequestHandler` are touched), so
 * tests capture the CallTool handler off a stub and invoke it directly —
 * pinning SERVER-vs-INTERNAL parent selection, creation-time delivery-origin
 * links (self-link + flags-00 exclusion), and the error→span status mapping
 * without a transport.
 */
export const __installUnifiedToolRegistryForTest = installUnifiedToolRegistry
export type RegisteredToolForSpanTest = RegisteredTool

function reapIdleTransports() {
  const now = Date.now()
  for (const [sessionId, active] of transportsBySessionId) {
    if (now - active.lastActivityAt > IDLE_TIMEOUT_MS) {
      transportsBySessionId.delete(sessionId)
      log.info(
        {
          sessionId,
          remoteAgentId: active.remoteAgentId,
          conversationId: active.conversationId,
          idleMs: now - active.lastActivityAt,
        },
        "reaped idle reverse-MCP session"
      )
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
  const turnCarriers = new TurnCarrierCache()
  const imTools = buildImTools({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    machineKey: params.machineKey,
    turnCarriers,
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
  installUnifiedToolRegistry(server, [...imTools, ...resolvedTools], {
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    turnCarriers,
  })

  let storedSessionId: string | undefined
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      storedSessionId = id
      transportsBySessionId.set(id, active)
      log.info(
        {
          sessionId: id,
          remoteAgentId: params.remoteAgentId,
          conversationId: params.conversationId,
          toolCount: imTools.length + resolvedTools.length,
        },
        "reverse-MCP session created"
      )
    },
  })
  const active: ActiveTransport = {
    transport,
    server,
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    turnCarriers,
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
  // Request-level correlation: the reverse-MCP HTTP request span (which the
  // patched @fastify/otel now always ENDS, hijacked replies included) carries
  // the agent/conversation identifiers so Tempo/logs queries can slice this
  // ingress by principal.
  const requestSpan = trace.getActiveSpan()
  requestSpan?.setAttributes({
    "synapse.remote_agent.id": request.params.remoteAgentId,
    "synapse.conversation.id": request.params.conversationId,
  })
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
    log.warn(
      { remoteAgentId: request.params.remoteAgentId, reason: message },
      "reverse-MCP machine authentication failed"
    )
    return reply.code(401).send({ error: message })
  }
  try {
    await requireRemoteAgentConversationAccessOnDefaultDb(
      request.params.conversationId,
      request.params.remoteAgentId
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(
      {
        remoteAgentId: request.params.remoteAgentId,
        conversationId: request.params.conversationId,
        reason: message,
      },
      "reverse-MCP conversation access denied"
    )
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
  log.debug(
    {
      method: request.method,
      remoteAgentId: request.params.remoteAgentId,
      conversationId: request.params.conversationId,
      sessionId: sessionId ?? "initialize",
    },
    "reverse-MCP request"
  )

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
