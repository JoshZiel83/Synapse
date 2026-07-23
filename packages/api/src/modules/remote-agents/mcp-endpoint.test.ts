import assert from "node:assert/strict"
import { test } from "node:test"

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import {
  __buildImToolsForTest,
  __installUnifiedToolRegistryForTest,
  readMcpToolContentBlocks,
  type RegisteredToolForSpanTest,
} from "./mcp-endpoint.js"
import { TurnCarrierCache } from "./turn-carriers.js"

// Real provider + in-memory exporter so the tools/call spans are assertable;
// real context manager so ambient parenting works; the global propagator is
// the extract path toolCallParentContext uses for a valid `_meta` carrier.
const exporter = new InMemorySpanExporter()
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const REMOTE_AGENT_ID = "00000000-0000-4000-8000-000000000020"
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000021"
const ITEM_ID = "00000000-0000-4000-8000-000000000022"

function buildTools() {
  return __buildImToolsForTest({
    remoteAgentId: REMOTE_AGENT_ID,
    conversationId: CONVERSATION_ID,
    machineKey: "machine-key",
  })
}

function requireTool(name: string) {
  const tool = buildTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `missing tool ${name}`)
  assert.ok(tool.zodSchema, `missing zod schema for ${name}`)
  return tool
}

function schemaProperties(inputSchema: Record<string, unknown>) {
  const properties = inputSchema.properties
  assert.ok(properties && typeof properties === "object")
  return properties as Record<string, unknown>
}

test("reverse-MCP read_history advertises and validates snake_case history inputs", () => {
  const tool = requireTool("read_history")
  const properties = schemaProperties(tool.inputSchema)
  assert.ok(properties.after_sequence)
  assert.ok(properties.before_sequence)
  assert.equal("afterSequence" in properties, false)
  assert.equal("beforeSequence" in properties, false)
  assert.equal(
    tool.zodSchema!.safeParse({ after_sequence: 1, limit: 20 }).success,
    true
  )
  assert.equal(tool.zodSchema!.safeParse({ afterSequence: 1 }).success, false)
})

test("reverse-MCP send_message advertises and validates snake_case reply id", () => {
  const tool = requireTool("send_message")
  const properties = schemaProperties(tool.inputSchema)
  assert.ok(properties.reply_to_item_id)
  assert.equal("replyToItemId" in properties, false)
  assert.equal(
    tool.zodSchema!.safeParse({
      content: "hello",
      reply_to_item_id: ITEM_ID,
    }).success,
    true
  )
  assert.equal(
    tool.zodSchema!.safeParse({
      content: "hello",
      replyToItemId: ITEM_ID,
    }).success,
    false
  )
})

test("reverse-MCP list_conversations keeps a strict empty input schema", () => {
  const tool = requireTool("list_conversations")
  assert.deepEqual(schemaProperties(tool.inputSchema), {})
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.equal(tool.zodSchema!.safeParse({}).success, true)
  assert.equal(tool.zodSchema!.safeParse({ limit: 1 }).success, false)
})

// TurnCarrierCache's own unit tests (dedupe/cap/epoch/registry) live in
// turn-carriers.test.ts — the class moved to its own module (C). This file
// exercises it only through the tools/call span matrix below.

// ─── tools/call span matrix (§4.C C3b — via the registry test seam) ─────────

type CallToolHandler = (request: {
  method: "tools/call"
  params: {
    name: string
    arguments?: Record<string, unknown>
    _meta?: Record<string, unknown>
  }
}) => Promise<{ content: unknown[]; isError?: boolean }>

/**
 * Install the unified registry on a STUB McpServer and capture the CallTool
 * handler — the schema's `method` literal disambiguates ListTools/CallTool.
 */
function captureCallToolHandler(
  tools: RegisteredToolForSpanTest[],
  turnCarriers = new TurnCarrierCache()
): CallToolHandler {
  const byMethod = new Map<string, unknown>()
  const stub = {
    server: {
      registerCapabilities: () => undefined,
      setRequestHandler: (schema: unknown, handler: unknown) => {
        const method = (schema as { shape: { method: { value: string } } })
          .shape.method.value
        byMethod.set(method, handler)
      },
    },
  } as unknown as McpServer
  __installUnifiedToolRegistryForTest(stub, tools, {
    remoteAgentId: REMOTE_AGENT_ID,
    conversationId: CONVERSATION_ID,
    turnCarriers,
  })
  const handler = byMethod.get("tools/call")
  assert.ok(handler, "CallTool handler must be registered")
  return handler as CallToolHandler
}

const OK_TOOL: RegisteredToolForSpanTest = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  zodSchema: z.object({ msg: z.string() }),
  handler: async (input) => ({
    content: [{ type: "text", text: String(input.msg) }],
  }),
}

const META_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const META_SPAN_ID = "b7ad6b7169203331"
const VALID_META = {
  traceparent: `00-${META_TRACE_ID}-${META_SPAN_ID}-01`,
  tracestate: "othervendor=xyz",
}

test("tools/call span: valid _meta carrier ⇒ ONE SERVER span remote-parented on it", async () => {
  exporter.reset()
  const handler = captureCallToolHandler([OK_TOOL])
  const result = await handler({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" }, _meta: VALID_META },
  })
  assert.equal(result.isError, undefined)

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1, "exactly one self-created tools/call span")
  const span = spans[0]!
  assert.equal(span.name, "tools/call echo")
  assert.equal(span.kind, SpanKind.SERVER, "_meta carrier ⇒ SERVER kind")
  assert.equal(span.spanContext().traceId, META_TRACE_ID)
  assert.equal(span.parentSpanContext?.spanId, META_SPAN_ID)
  assert.equal(span.parentSpanContext?.isRemote, true)
  assert.equal(span.attributes["mcp.method.name"], "tools/call")
  assert.equal(span.attributes["mcp.tool.name"], "echo")
  assert.equal(span.attributes["synapse.remote_agent.id"], REMOTE_AGENT_ID)
  assert.equal(span.attributes["synapse.conversation.id"], CONVERSATION_ID)
  assert.equal(span.status.code, SpanStatusCode.UNSET)
})

test("tools/call span: an invalid _meta.tracestate is dropped WHOLE while SERVER kind + the remote parent survive", async () => {
  exporter.reset()
  const handler = captureCallToolHandler([OK_TOOL])
  const result = await handler({
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { msg: "hi" },
      _meta: {
        traceparent: `00-${META_TRACE_ID}-${META_SPAN_ID}-01`,
        tracestate: "ok=1,ok=2", // duplicate key — gated out before extract
      },
    },
  })
  assert.equal(result.isError, undefined)
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.kind, SpanKind.SERVER, "carrier still ⇒ SERVER kind")
  assert.equal(span.spanContext().traceId, META_TRACE_ID, "remote parent kept")
  assert.equal(span.parentSpanContext?.spanId, META_SPAN_ID)
  assert.equal(span.parentSpanContext?.isRemote, true)
  assert.equal(
    span.spanContext().traceState?.serialize() || "",
    "",
    "the malformed tracestate degrades to absent"
  )
})

test("tools/call span: no _meta ⇒ INTERNAL child of the ambient request span", async () => {
  exporter.reset()
  const handler = captureCallToolHandler([OK_TOOL])
  await trace
    .getTracer("test-ambient")
    .startActiveSpan("ambient-request", async (ambient) => {
      const result = await handler({
        method: "tools/call",
        params: { name: "echo", arguments: { msg: "hi" } },
      })
      assert.equal(result.isError, undefined)
      ambient.end()
    })
  const span = exporter
    .getFinishedSpans()
    .find((s) => s.name === "tools/call echo")!
  assert.ok(span, "tools/call span must export")
  assert.equal(span.kind, SpanKind.INTERNAL, "ambient path ⇒ INTERNAL kind")
  const ambient = exporter
    .getFinishedSpans()
    .find((s) => s.name === "ambient-request")!
  assert.equal(span.spanContext().traceId, ambient.spanContext().traceId)
  assert.equal(span.parentSpanContext?.spanId, ambient.spanContext().spanId)
})

test("tools/call span: creation-time delivery-origin links — self-link and flags-00 excluded", async () => {
  exporter.reset()
  const cache = new TurnCarrierCache()
  cache.reconcile("epoch-1") // the daemon-confirmed running turn reads its bucket
  const linkedTrace = "1af7651916cd43dd8448eb211c80319d"
  cache.extend([
    // origin == the _meta parent's own trace ⇒ excluded (would be a self-link)
    `00-${META_TRACE_ID}-00000000000000aa-01`,
    // sampled foreign origin ⇒ linked
    `00-${linkedTrace}-00000000000000bb-01`,
    // unsampled origin ⇒ skipped (head-sampled backend never stores it)
    "00-2af7651916cd43dd8448eb211c80319e-00000000000000cc-00",
  ])
  const handler = captureCallToolHandler([OK_TOOL], cache)
  await handler({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" }, _meta: VALID_META },
  })
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.links.length, 1, "only the sampled foreign origin links")
  assert.equal(span.links[0]!.context.traceId, linkedTrace)
  assert.equal(
    span.links[0]!.attributes?.["synapse.link.kind"],
    "delivery_origin"
  )
})

test("tools/call span: links the daemon-confirmed RUNNING turn's origins, never a queued successor's (F3 + R3)", async () => {
  exporter.reset()
  const cache = new TurnCarrierCache()
  const turn1Trace = "1af7651916cd43dd8448eb211c80319d"
  const turn2Trace = "3af7651916cd43dd8448eb211c80331f"
  // Turn 1 dispatched AND confirmed running by the daemon; turn 2 dispatched but
  // only QUEUED behind it (its bucket exists, but the daemon has not fronted it).
  cache.beginTurn("epoch-1", [`00-${turn1Trace}-00000000000000bb-01`])
  cache.beginTurn("epoch-2", [`00-${turn2Trace}-00000000000000cc-01`])
  cache.reconcile("epoch-1")
  const handler1 = captureCallToolHandler([OK_TOOL], cache)
  await handler1({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "one" }, _meta: VALID_META },
  })
  const turn1Span = exporter.getFinishedSpans()[0]!
  assert.equal(
    turn1Span.links.length,
    1,
    "only the running turn 1's origin links"
  )
  assert.equal(turn1Span.links[0]!.context.traceId, turn1Trace)

  // Turn 1 completes; the daemon fronts turn 2. The now-running turn links turn
  // 2's origin ONLY — turn 1's origin must NOT leak forward either.
  exporter.reset()
  cache.reconcile("epoch-2")
  const handler2 = captureCallToolHandler([OK_TOOL], cache)
  await handler2({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "two" }, _meta: VALID_META },
  })
  const turn2Span = exporter.getFinishedSpans()[0]!
  assert.equal(
    turn2Span.links.length,
    1,
    "only the now-running turn 2's origin links"
  )
  assert.equal(turn2Span.links[0]!.context.traceId, turn2Trace)
})

test("tools/call span: unknown tool / zod-reject / handler-throw / isError ⇒ ERROR status, span always ended", async () => {
  // unknown tool
  exporter.reset()
  let handler = captureCallToolHandler([OK_TOOL])
  let result = await handler({
    method: "tools/call",
    params: { name: "nope", arguments: {} },
  })
  assert.equal(result.isError, true)
  let span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.match(span.status.message ?? "", /Unknown tool/)

  // zod-reject
  exporter.reset()
  handler = captureCallToolHandler([OK_TOOL])
  result = await handler({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: 42 } },
  })
  assert.equal(result.isError, true)
  span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.match(span.status.message ?? "", /Invalid arguments for echo/)

  // handler throw ⇒ recordException + ERROR + isError result (never a reject)
  exporter.reset()
  handler = captureCallToolHandler([
    {
      ...OK_TOOL,
      handler: async () => {
        throw new Error("tool exploded")
      },
    },
  ])
  result = await handler({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" } },
  })
  assert.equal(result.isError, true)
  span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  const exception = span.events.find((e) => e.name === "exception")
  assert.ok(exception, "recordException must attach an exception event")
  assert.equal(exception.attributes?.["exception.message"], "tool exploded")

  // tool-level isError result ⇒ ERROR status, result passed through
  exporter.reset()
  handler = captureCallToolHandler([
    {
      ...OK_TOOL,
      handler: async () => ({
        content: [{ type: "text", text: "denied" }],
        isError: true,
      }),
    },
  ])
  result = await handler({
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" } },
  })
  assert.equal(result.isError, true)
  span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)

  // every branch above exported exactly one (ended) span — the finally-end
  // invariant; a leaked un-ended span would never reach the exporter.
})

test("readMcpToolContentBlocks accepts only object content arrays", () => {
  const textContent = [{ type: "text", text: "ok" }]
  assert.equal(readMcpToolContentBlocks(undefined), null)
  assert.equal(readMcpToolContentBlocks({ type: "text", text: "bad" }), null)
  assert.equal(readMcpToolContentBlocks(["bad"]), null)
  assert.equal(readMcpToolContentBlocks([null]), null)
  assert.deepEqual(readMcpToolContentBlocks(textContent), textContent)
})
