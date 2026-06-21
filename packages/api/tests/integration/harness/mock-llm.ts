// MockServer wrapper for LLM-endpoint integration tests.
//
// Spawns a fresh mockserver/mockserver container per test file via
// testcontainers (dynamic port), exposes a typed expect/reset/recorded/verify
// surface, and bundles per-provider request matchers + response factories so
// tests stay short and isolated from MockServer's wire schema.
//
// Lifecycle pattern:
//   let mock: MockLLMHandle | undefined
//   before(async () => { mock = await startMockLLM() })
//   after(async () => { await mock?.stop() })
//   beforeEach(() => mock!.reset())
//
// stop() is idempotent via a cached promise so failing tests still clean up.

import { GenericContainer, Wait } from "testcontainers"
import { randomUUID } from "node:crypto"
import type {
  CanonicalContextScope,
  CanonicalContextSurface,
  CanonicalToolCall,
  CanonicalToolCallBatchContextItem,
  CanonicalToolResult,
  CanonicalToolResultBatchContextItem,
} from "@synapse/shared"

const MOCKSERVER_IMAGE = "mockserver/mockserver:5.15.0"
const MOCKSERVER_PORT = 1080
const STARTUP_TIMEOUT_MS = 60_000
const REST_PROBE_TIMEOUT_MS = 30_000

// ─── public types ────────────────────────────────────────────────────────────

export interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string[]>
  query: Record<string, string[]>
  bodyText: string
  bodyJson: unknown | null
  getHeader(name: string): string | undefined
}

export interface ExpectationInput {
  priority?: number
  httpRequest: Record<string, unknown>
  httpResponse: Record<string, unknown>
  times?: { remainingTimes?: number; unlimited?: boolean }
  timeToLive?: { unlimited?: boolean }
}

export interface VerifyMatcher {
  method?: string
  path?: string
  body?: Record<string, unknown>
}

export interface ProviderMatchers {
  /** Path-only matcher, low priority (acts as fallback for the first request). */
  round1: { method: string; path: string }
  /** JSONPath body matcher targeting the provider-native tool_result marker; HIGH priority. */
  round2: { method: string; path: string; body: Record<string, unknown> }
}

export interface MockLLMHandle {
  baseUrl: string
  expect(input: ExpectationInput): Promise<void>
  reset(): Promise<void>
  recorded(matcher: {
    method?: string
    path?: string
  }): Promise<RecordedRequest[]>
  verify(
    matcher: VerifyMatcher,
    times: { atLeast?: number; atMost?: number }
  ): Promise<void>
  stop(): Promise<void>
  matchers: typeof matchers
}

// ─── per-provider matcher fragments ──────────────────────────────────────────

/**
 * Round-1 matchers are path-only (no body constraint) and the caller
 * registers them with low priority. Round-2 matchers target the body marker
 * unique to each provider's native tool_result shape and the caller
 * registers them with HIGHER priority. MockServer chooses by priority desc
 * then insertion order; we MUST NOT rely on the implicit "more specific
 * matcher wins" rule (it doesn't exist).
 *
 * Body markers per provider (all matchers are wire-shape-specific, NOT
 * key-name recursive descent — the latter would false-match if a fixture
 * ever embedded the literal marker string inside user content):
 *   Anthropic           — user message content with a tool_result block
 *   OpenAI Chat/BigModel— messages array entry with role:"tool"
 *   OpenAI Responses    — input array entry with type:"function_call_output"
 */
export const matchers = {
  anthropic: {
    round1: { method: "POST", path: "/v1/messages" },
    round2: {
      method: "POST",
      path: "/v1/messages",
      body: {
        type: "JSON_PATH",
        jsonPath:
          "$.messages[?(@.role=='user')].content[?(@.type=='tool_result')]",
      },
    },
  },
  openaiChat: {
    round1: { method: "POST", path: "/v1/chat/completions" },
    round2: {
      method: "POST",
      path: "/v1/chat/completions",
      body: { type: "JSON_PATH", jsonPath: "$.messages[?(@.role=='tool')]" },
    },
  },
  openaiResponses: {
    round1: { method: "POST", path: "/v1/responses" },
    round2: {
      method: "POST",
      path: "/v1/responses",
      body: {
        type: "JSON_PATH",
        jsonPath: "$.input[?(@.type=='function_call_output')]",
      },
    },
  },
  bigmodel: {
    round1: { method: "POST", path: "/paas/v4/chat/completions" },
    round2: {
      method: "POST",
      path: "/paas/v4/chat/completions",
      body: { type: "JSON_PATH", jsonPath: "$.messages[?(@.role=='tool')]" },
    },
  },
} satisfies Record<string, ProviderMatchers>

// ─── response body factories ─────────────────────────────────────────────────

export function buildAnthropicTextResponse(opts: {
  text: string
  inputTokens?: number
  outputTokens?: number
  stopReason?: string
  model?: string
}): Record<string, unknown> {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-haiku-4-5-20251001",
    content: [{ type: "text", text: opts.text }],
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
    },
  }
}

export function buildAnthropicToolUseResponse(opts: {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  text?: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}): Record<string, unknown> {
  assertAnthropicSafeToolName(opts.toolName)
  const content: Array<Record<string, unknown>> = []
  if (opts.text) content.push({ type: "text", text: opts.text })
  content.push({
    type: "tool_use",
    id: opts.toolUseId,
    name: opts.toolName,
    input: opts.input,
  })
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-haiku-4-5-20251001",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
    },
  }
}

export function buildOpenAIChatTextResponse(opts: {
  text: string
  promptTokens?: number
  completionTokens?: number
  finishReason?: string
  model?: string
}): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-4.1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.text },
        finish_reason: opts.finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 0,
      completion_tokens: opts.completionTokens ?? 0,
      total_tokens: (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0),
    },
  }
}

export function buildOpenAIChatToolCallResponse(opts: {
  toolCallId: string
  toolName: string
  argumentsJson: string
  text?: string
  promptTokens?: number
  completionTokens?: number
  model?: string
}): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-4.1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.text ?? null,
          tool_calls: [
            {
              id: opts.toolCallId,
              type: "function",
              function: { name: opts.toolName, arguments: opts.argumentsJson },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 0,
      completion_tokens: opts.completionTokens ?? 0,
      total_tokens: (opts.promptTokens ?? 0) + (opts.completionTokens ?? 0),
    },
  }
}

export function buildOpenAIResponsesTextResponse(opts: {
  text: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}): Record<string, unknown> {
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-5",
    status: "completed",
    output: [
      {
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: opts.text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      total_tokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
    },
  }
}

export function buildOpenAIResponsesFunctionCallResponse(opts: {
  callId: string
  name: string
  argumentsJson: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}): Record<string, unknown> {
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-5",
    status: "completed",
    output: [
      {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: opts.callId,
        name: opts.name,
        arguments: opts.argumentsJson,
      },
    ],
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      total_tokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
    },
  }
}

// BigModel uses the OpenAI Chat Completions wire shape; the only difference at
// the body level is the default model name. The path-suffix difference
// (/paas/v4/chat/completions) is handled by the provider's URL builder.
export function buildBigModelTextResponse(opts: {
  text: string
  promptTokens?: number
  completionTokens?: number
  finishReason?: string
  model?: string
}): Record<string, unknown> {
  return buildOpenAIChatTextResponse({
    ...opts,
    model: opts.model ?? "glm-4.6",
  })
}

export function buildBigModelToolCallResponse(opts: {
  toolCallId: string
  toolName: string
  argumentsJson: string
  text?: string
  promptTokens?: number
  completionTokens?: number
  model?: string
}): Record<string, unknown> {
  return buildOpenAIChatToolCallResponse({
    ...opts,
    model: opts.model ?? "glm-4.6",
  })
}

// Anthropic's provider runs every canonical tool name through
// buildAnthropicToolAlias (providers/anthropic.ts:58-92). If the name has any
// character outside [a-zA-Z0-9_-] OR exceeds 128 chars, the provider mints an
// alias of the form `<normalized>_<sha8>` and sends THAT on the wire. Tests
// that want to assert the wire-level tool name without aliasing must stay in
// the safe set. Throw at fixture-build time rather than getting a confusing
// mismatch later.
export function assertAnthropicSafeToolName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
    throw new Error(
      `Tool name "${name}" is not Anthropic-alias-safe; use [a-zA-Z0-9_-]{1,128} ` +
        `(e.g. "weather_get") or assert against the aliased wire name explicitly.`
    )
  }
}

// ─── canonical context-item helpers (batch kinds; user/assistant use upstream buildAdHocContextItems) ──

const DEFAULT_BATCH_SCOPE: CanonicalContextScope = "private"
const DEFAULT_BATCH_SURFACE: CanonicalContextSurface = "internal"

export function toolCallBatchItem(
  toolCalls: CanonicalToolCall[],
  bundleId?: string
): CanonicalToolCallBatchContextItem {
  return {
    kind: "tool_call_batch",
    role: "assistant",
    bundleId,
    toolCalls,
    scope: DEFAULT_BATCH_SCOPE,
    surface: DEFAULT_BATCH_SURFACE,
  }
}

export function toolResultBatchItem(
  toolResults: CanonicalToolResult[],
  bundleId?: string
): CanonicalToolResultBatchContextItem {
  return {
    kind: "tool_result_batch",
    bundleId,
    toolResults,
    scope: DEFAULT_BATCH_SCOPE,
    surface: DEFAULT_BATCH_SURFACE,
  }
}

// ─── main entry point ────────────────────────────────────────────────────────

export async function startMockLLM(): Promise<MockLLMHandle> {
  const started = await new GenericContainer(MOCKSERVER_IMAGE)
    .withExposedPorts(MOCKSERVER_PORT)
    // forListeningPorts() doesn't work for this image — the slim base lacks
    // shell tools testcontainers needs to probe the in-container port. The
    // log line "INFO 1080 started on port: 1080" is stable across 5.x and
    // fires immediately before MockServer accepts traffic. The post-start
    // REST probe below confirms the control API is actually reachable.
    .withWaitStrategy(Wait.forLogMessage(/started on port: 1080/i))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start()

  const baseUrl = `http://${started.getHost()}:${started.getMappedPort(MOCKSERVER_PORT)}`

  // Post-start REST probe: hit PUT /mockserver/reset with retries until the
  // control API answers. A successful reset is a stronger signal than a TCP
  // bind because mockserver opens the listening port slightly before the
  // control endpoints are routable.
  //
  // If the probe fails, the container is already running but the caller will
  // never receive a MockLLMHandle to clean it up via stop(). Tear it down
  // here before rethrowing so we never leak a container on cold-start hiccups
  // / control-API issues / CI Docker flakes.
  try {
    await probeRestApi(baseUrl)
  } catch (probeErr) {
    await started.stop({ timeout: 10_000 }).catch((stopErr) => {
      // Surface both errors so the operator can see the real cause and the
      // cleanup failure. Don't let stop() failure mask the probe error.
      console.error(
        "[mock-llm] cleanup after probe failure also failed:",
        stopErr instanceof Error ? stopErr.message : stopErr
      )
    })
    throw probeErr
  }

  let stopPromise: Promise<void> | null = null

  const controlPut = async (
    path: string,
    body?: unknown
  ): Promise<Response> => {
    return fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  return {
    baseUrl,
    matchers,

    async expect(input) {
      const res = await controlPut("/mockserver/expectation", {
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        httpRequest: input.httpRequest,
        httpResponse: input.httpResponse,
        ...(input.times ? { times: input.times } : {}),
        ...(input.timeToLive ? { timeToLive: input.timeToLive } : {}),
      })
      if (!res.ok && res.status !== 201) {
        const text = await res.text()
        throw new Error(
          `MockServer expectation failed (${res.status}): ${text || "(empty body)"}`
        )
      }
      await res.arrayBuffer()
    },

    async reset() {
      const res = await controlPut("/mockserver/reset")
      if (!res.ok) {
        const text = await res.text()
        throw new Error(
          `MockServer reset failed (${res.status}): ${text || "(empty body)"}`
        )
      }
      await res.arrayBuffer()
    },

    async recorded(matcher) {
      const httpRequest: Record<string, unknown> = {}
      if (matcher.method) httpRequest.method = matcher.method
      if (matcher.path) httpRequest.path = matcher.path
      const res = await fetch(
        `${baseUrl}/mockserver/retrieve?type=REQUESTS&format=JSON`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(httpRequest),
        }
      )
      if (!res.ok) {
        const text = await res.text()
        throw new Error(
          `MockServer retrieve failed (${res.status}): ${text || "(empty body)"}`
        )
      }
      const raw = (await res.json()) as unknown
      if (!Array.isArray(raw)) {
        throw new Error(
          `Unexpected MockServer retrieve shape: ${JSON.stringify(raw).slice(0, 200)}`
        )
      }
      return raw.map(normalizeRecorded)
    },

    async verify(matcher, times) {
      // Reserved for future negative-path tests (e.g. "the second provider
      // round should NOT happen because the test errored out"). Currently
      // unused by the three default test files because `recorded()` +
      // .length assertions cover the positive path more directly.
      const httpRequest: Record<string, unknown> = {}
      if (matcher.method) httpRequest.method = matcher.method
      if (matcher.path) httpRequest.path = matcher.path
      if (matcher.body) httpRequest.body = matcher.body
      const res = await controlPut("/mockserver/verify", {
        httpRequest,
        times: {
          ...(times.atLeast !== undefined ? { atLeast: times.atLeast } : {}),
          ...(times.atMost !== undefined ? { atMost: times.atMost } : {}),
        },
      })
      if (res.status === 202) {
        await res.arrayBuffer()
        return
      }
      const text = await res.text()
      throw new Error(
        `MockServer verify failed (${res.status}): ${text || "(empty body)"}`
      )
    },

    async stop() {
      // Idempotent under single-caller semantics (which is what node:test
      // gives us — `after()` runs once per file). The cached stopPromise
      // collapses repeated calls to the same outcome. If the underlying
      // container.stop() throws, stopPromise is reset to null so a later
      // retry can attempt again — that path is rare and not expected
      // under normal test teardown.
      if (!stopPromise) {
        stopPromise = (async () => {
          try {
            await started.stop({ timeout: 10_000 })
          } catch (err) {
            // Reset so caller can retry if needed (e.g., transient docker glitch).
            stopPromise = null
            throw err
          }
        })()
      }
      return stopPromise
    },
  }
}

// ─── internal helpers ────────────────────────────────────────────────────────

async function probeRestApi(baseUrl: string): Promise<void> {
  const deadline = Date.now() + REST_PROBE_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/mockserver/reset`, { method: "PUT" })
      if (res.ok || res.status === 200) {
        await res.arrayBuffer()
        return
      }
      lastError = new Error(`status=${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `MockServer REST API did not respond within ${REST_PROBE_TIMEOUT_MS}ms at ${baseUrl}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  )
}

function normalizeRecorded(raw: unknown): RecordedRequest {
  const r = (raw ?? {}) as Record<string, unknown>
  const method = typeof r.method === "string" ? r.method : ""
  const path = typeof r.path === "string" ? r.path : ""
  const headers = normalizeHeaders(r.headers)
  const query = normalizeQuery(r.queryStringParameters)
  const { bodyText, bodyJson } = normalizeBody(r.body)

  return {
    method,
    path,
    headers,
    query,
    bodyText,
    bodyJson,
    getHeader(name) {
      const lower = name.toLowerCase()
      return headers[lower]?.[0]
    },
  }
}

function normalizeHeaders(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!raw) return out

  // Form A: array of { name, values: string[] } (older MockServer recorded shape).
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === "object") {
        const e = entry as { name?: unknown; values?: unknown }
        if (typeof e.name === "string" && Array.isArray(e.values)) {
          out[e.name.toLowerCase()] = e.values.filter(
            (v): v is string => typeof v === "string"
          )
        }
      }
    }
    return out
  }

  // Form B: { headerName: string[] | string } (newer shape).
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k.toLowerCase()] = v.filter(
          (x): x is string => typeof x === "string"
        )
      } else if (typeof v === "string") {
        out[k.toLowerCase()] = [v]
      }
    }
  }
  return out
}

function normalizeQuery(raw: unknown): Record<string, string[]> {
  // Same wire shapes as headers, so reuse.
  return normalizeHeaders(raw)
}

function normalizeBody(raw: unknown): {
  bodyText: string
  bodyJson: unknown | null
} {
  if (raw == null) return { bodyText: "", bodyJson: null }

  if (typeof raw === "string") {
    return { bodyText: raw, bodyJson: safeParse(raw) }
  }

  if (typeof raw !== "object") {
    const text = String(raw)
    return { bodyText: text, bodyJson: safeParse(text) }
  }

  // Discriminated body envelope from MockServer. Preference order:
  // rawBytes (most faithful) → string → json. Anything left over gets
  // stringified for diagnostic visibility.
  const obj = raw as Record<string, unknown>

  if (typeof obj.rawBytes === "string") {
    try {
      const decoded = Buffer.from(obj.rawBytes, "base64").toString("utf8")
      return { bodyText: decoded, bodyJson: safeParse(decoded) }
    } catch {
      // fall through to other shapes
    }
  }
  if (typeof obj.string === "string") {
    return { bodyText: obj.string, bodyJson: safeParse(obj.string) }
  }
  if (obj.json !== undefined) {
    return { bodyText: JSON.stringify(obj.json), bodyJson: obj.json }
  }

  const text = JSON.stringify(obj)
  return { bodyText: text, bodyJson: safeParse(text) }
}

function safeParse(s: string): unknown | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
