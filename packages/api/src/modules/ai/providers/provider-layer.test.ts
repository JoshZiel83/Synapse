// Unit tests for the Synapse-owned bits of the AI-SDK provider layer.
// (Provider WIRE serialization is now the AI SDK's job and is validated by the
// live migration spikes, not re-tested here — that would be testing the SDK.)
import test from "node:test"
import assert from "node:assert/strict"

import { bigModelChatBase } from "./get-language-model.js"
import { toLanguageModelSpec } from "./to-language-model-spec.js"
import { reconcileToolPairing } from "./reconcile-tool-pairing.js"
import { fromGenerateText } from "./from-generate-text.js"
import type { ConversationMessage, ResolvedModelConfig } from "@synapse/shared"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test("fromGenerateText mints a UUID callId and keeps the SDK id as providerCallId", () => {
  // Regression for the tool_calls.id PK: the SDK's native id (call_/toolu_) is
  // NOT a UUID and must never become the canonical callId / DB key.
  const adapted = fromGenerateText({
    text: "",
    toolCalls: [
      {
        toolCallId: "toolu_vrtx_abc123",
        toolName: "get_weather",
        input: { city: "X" },
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "tool-calls",
    files: [],
    sources: [],
    response: {},
    request: {},
  } as any)
  const a = adapted.context[0]
  const calls = a.role === "assistant" ? (a.toolCalls ?? []) : []
  assert.equal(calls.length, 1)
  assert.match(calls[0].callId, UUID_RE)
  assert.equal(calls[0].providerCallId, "toolu_vrtx_abc123")
  assert.notEqual(calls[0].callId, "toolu_vrtx_abc123")
})

test("fromGenerateText splits provider-executed server tools from Synapse tool calls", () => {
  // web_search is provider-executed (Anthropic runs it) → must NOT become a
  // Synapse tool call; it surfaces as a serverToolCall with its results. The
  // model-requested tool stays a normal Synapse call.
  const adapted = fromGenerateText({
    text: "Here is the weather.",
    toolCalls: [
      {
        toolCallId: "srv_1",
        toolName: "web_search",
        input: { query: "weather" },
        providerExecuted: true,
      },
      {
        toolCallId: "toolu_real",
        toolName: "get_weather",
        input: { city: "X" },
      },
    ],
    toolResults: [
      {
        toolCallId: "srv_1",
        toolName: "web_search",
        providerExecuted: true,
        output: [{ url: "https://e.com", title: "E", page_age: "1d" }],
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: "tool-calls",
    files: [],
    sources: [],
    response: {},
    request: {},
  } as any)
  const a = adapted.context[0]
  const calls = a.role === "assistant" ? (a.toolCalls ?? []) : []
  // only the model-requested tool is a Synapse tool call
  assert.equal(calls.length, 1)
  assert.equal(calls[0].toolName, "get_weather")
  assert.equal(calls[0].providerCallId, "toolu_real")
  // the server tool is reported separately, with its result
  assert.ok(adapted.serverToolCalls)
  assert.equal(adapted.serverToolCalls!.length, 1)
  assert.equal(adapted.serverToolCalls![0].type, "web_search")
  assert.equal(adapted.serverToolCalls![0].query, "weather")
  assert.equal(adapted.serverToolCalls![0].results?.[0].url, "https://e.com")
})

test("bigModelChatBase normalizes all three baseUrl shapes to /paas/v4", () => {
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
  // trailing slash tolerated
  assert.equal(
    bigModelChatBase("https://open.bigmodel.cn/api/paas/v4/"),
    "https://open.bigmodel.cn/api/paas/v4"
  )
})

function baseResolved(over: Partial<ResolvedModelConfig>): ResolvedModelConfig {
  return {
    groupId: "g",
    bindingId: "b",
    bindingVersionId: "v",
    providerKind: "anthropic",
    vendor: "anthropic",
    apiKey: "k",
    baseUrl: "http://x",
    modelName: "m",
    maxOutputTokens: 1024,
    ...over,
  } as ResolvedModelConfig
}

test("toLanguageModelSpec passes through providerKind/vendor/apiStyle", () => {
  assert.deepEqual(
    toLanguageModelSpec(
      baseResolved({
        providerKind: "anthropic",
        vendor: "anthropic",
        apiStyle: "chat",
      })
    ),
    {
      providerKind: "anthropic",
      vendor: "anthropic",
      apiStyle: "chat",
      baseUrl: "http://x",
      apiKey: "k",
      modelName: "m",
    }
  )
  assert.equal(
    toLanguageModelSpec(
      baseResolved({
        providerKind: "openai",
        vendor: "openai",
        apiStyle: "responses",
      })
    ).apiStyle,
    "responses"
  )
  const compat = toLanguageModelSpec(
    baseResolved({ providerKind: "openai_compatible", vendor: "bigmodel" })
  )
  assert.equal(compat.providerKind, "openai_compatible")
  assert.equal(compat.vendor, "bigmodel")
})

test("reconcileToolPairing synthesizes a result for an orphan tool-call", () => {
  const messages: ConversationMessage[] = [
    { role: "user", content: [] },
    {
      role: "assistant",
      content: [],
      toolCalls: [{ callId: "c1", toolName: "t", input: {} }],
    },
    // no tool_result follows → orphan
  ]
  const out = reconcileToolPairing(messages)
  assert.equal(out.length, 3)
  const last = out[2]
  assert.equal(last.role, "tool_result")
  if (last.role === "tool_result") {
    assert.equal(last.results.length, 1)
    assert.equal(last.results[0].toolCallId, "c1")
    assert.equal(last.results[0].isError, true)
  }
})

test("reconcileToolPairing is a no-op when every tool-call has a result", () => {
  const messages: ConversationMessage[] = [
    {
      role: "assistant",
      content: [],
      toolCalls: [{ callId: "c1", toolName: "t", input: {} }],
    },
    {
      role: "tool_result",
      results: [{ toolCallId: "c1", toolName: "t", content: [] }],
    },
  ]
  const out = reconcileToolPairing(messages)
  assert.equal(out.length, 2)
})
