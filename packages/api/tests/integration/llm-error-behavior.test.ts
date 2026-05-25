// Error-behavior tests for the four AI providers against a MockServer.
//
// Asserts the contract that the providers expose on the way out — the
// `Error.message` string when an upstream returns 4xx/5xx, and the
// non-throwing graceful degradation paths (empty content, unparseable
// tool_call arguments). The cross-cutting classifyModelError mapping is an
// internal helper inside ai/index.ts and out of scope here (see plan).
//
// Timeout cases are also out of scope: only Anthropic has its own
// AbortController (120s/300s), and the configurable-timeout path
// (withTimeout in actorThink) requires the full ResolvedModelConfig +
// actorThink wiring which is a separate test dimension.

import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import * as net from "node:net"
import type { AddressInfo } from "node:net"

import { AnthropicProvider } from "../../src/modules/ai/providers/anthropic.js"
import { BigModelChatCompletionsProvider } from "../../src/modules/ai/providers/bigmodel.js"
import { OpenAIChatCompletionsProvider } from "../../src/modules/ai/providers/openai.js"
import { OpenAIResponsesProvider } from "../../src/modules/ai/providers/openai-responses.js"
import { buildAdHocContextItems } from "../../src/modules/ai/context-builder.js"
import { buildAdHocProviderContextWindow } from "../../src/modules/context/service.js"
import { extractText, textBlock } from "@synapse/shared"

import { startMockLLM, type MockLLMHandle } from "./harness/mock-llm.js"

let mock: MockLLMHandle | undefined

before(async () => {
  mock = await startMockLLM()
})

after(async () => {
  await mock?.stop()
})

beforeEach(async () => {
  await mock!.reset()
})

function userWindow(text: string) {
  return buildAdHocProviderContextWindow(
    buildAdHocContextItems([{ role: "user", content: [textBlock(text)] }])
  )
}

function stringResponse(status: number, body: string) {
  return {
    statusCode: status,
    headers: { "Content-Type": ["text/plain"] },
    body: { type: "STRING", string: body },
  }
}

function jsonResponse(json: Record<string, unknown>, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": ["application/json"] },
    body: { type: "JSON", json },
  }
}

function makeAnthropic() {
  return new AnthropicProvider({
    apiKey: "dummy",
    baseUrl: mock!.baseUrl,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 256,
    engineKind: "anthropic.messages",
  })
}

function makeOpenAIChat() {
  return new OpenAIChatCompletionsProvider({
    apiKey: "dummy",
    baseUrl: mock!.baseUrl,
    model: "gpt-4.1",
    maxTokens: 256,
    engineKind: "openai.chat_completions",
  })
}

function makeOpenAIResponses() {
  return new OpenAIResponsesProvider({
    apiKey: "dummy",
    baseUrl: mock!.baseUrl,
    model: "gpt-5",
    maxTokens: 256,
    engineKind: "openai.responses",
  })
}

function makeBigModel() {
  return new BigModelChatCompletionsProvider({
    apiKey: "dummy",
    baseUrl: mock!.baseUrl,
    model: "glm-4.6",
    maxTokens: 256,
    engineKind: "bigmodel.chat_completions",
  })
}

describe("Anthropic upstream error → Error.message contract", () => {
  for (const [status, label] of [
    [429, "Too Many Requests"],
    [500, "Internal error"],
    [503, "Service unavailable"],
  ] as Array<[number, string]>) {
    test(`HTTP ${status} → /Anthropic API error \\(${status}\\)/`, async () => {
      await mock!.expect({
        httpRequest: { method: "POST", path: "/v1/messages" },
        httpResponse: stringResponse(status, label),
      })
      const provider = makeAnthropic()
      await assert.rejects(
        () => provider.chat({ system: "x", contextWindow: userWindow("hi") }),
        new RegExp(`Anthropic API error \\(${status}\\)`)
      )
    })
  }
})

describe("OpenAI Chat upstream error → Error.message contract", () => {
  for (const [status, label] of [
    [401, "invalid_api_key"],
    [400, "messages must be array"],
  ] as Array<[number, string]>) {
    test(`HTTP ${status} → /OpenAI API error \\(${status}\\)/`, async () => {
      await mock!.expect({
        httpRequest: { method: "POST", path: "/v1/chat/completions" },
        httpResponse: stringResponse(status, label),
      })
      const provider = makeOpenAIChat()
      await assert.rejects(
        () => provider.chat({ system: "x", contextWindow: userWindow("hi") }),
        new RegExp(`OpenAI API error \\(${status}\\)`)
      )
    })
  }
})

describe("OpenAI Responses upstream error → Error.message contract", () => {
  test("HTTP 502 → /OpenAI Responses API error \\(502\\)/", async () => {
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/responses" },
      httpResponse: stringResponse(502, "bad gateway"),
    })
    const provider = makeOpenAIResponses()
    await assert.rejects(
      () => provider.chat({ system: "x", contextWindow: userWindow("hi") }),
      /OpenAI Responses API error \(502\)/
    )
  })
})

describe("BigModel upstream error → Error.message contract", () => {
  test("HTTP 500 → /BigModel API error \\(500\\)/", async () => {
    await mock!.expect({
      httpRequest: { method: "POST", path: "/paas/v4/chat/completions" },
      httpResponse: stringResponse(500, "upstream error"),
    })
    const provider = makeBigModel()
    await assert.rejects(
      () => provider.chat({ system: "x", contextWindow: userWindow("hi") }),
      /BigModel API error \(500\)/
    )
  })
})

describe("Response parse failures", () => {
  test("Malformed JSON 200 rejects from response.json()", async () => {
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/messages" },
      httpResponse: {
        statusCode: 200,
        // Send a Content-Type of application/json but a non-JSON body so the
        // provider's `await response.json()` throws a SyntaxError. (If we
        // sent text/plain MockServer would still echo the bytes; the
        // provider doesn't inspect the response Content-Type before .json().)
        headers: { "Content-Type": ["application/json"] },
        body: { type: "STRING", string: "not json{" },
      },
    })
    const provider = makeAnthropic()
    await assert.rejects(() =>
      provider.chat({ system: "x", contextWindow: userWindow("hi") })
    )
  })

  test("Anthropic empty content[] does not throw and returns empty text", async () => {
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/messages" },
      httpResponse: jsonResponse({
        id: "msg_empty",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
    })
    const provider = makeAnthropic()
    const response = await provider.chat({
      system: "x",
      contextWindow: userWindow("hi"),
    })
    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.equal(extractText(assistant.content), "")
    assert.equal(assistant.toolCalls, undefined)
    assert.deepEqual(response.tokensUsed, { input: 5, output: 0 })
  })

  test("OpenAI Chat tool_calls.arguments non-JSON does not throw; toolCalls undefined", async () => {
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/chat/completions" },
      httpResponse: jsonResponse({
        id: "chatcmpl-bad",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4.1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "x",
                  type: "function",
                  function: { name: "foo", arguments: "{bad" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }),
    })
    const provider = makeOpenAIChat()
    const response = await provider.chat({
      system: "x",
      contextWindow: userWindow("hi"),
    })
    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    // The catch block in providers/openai.ts:181-185 swallows the parse
    // failure and never pushes into toolCalls — so the canonical
    // assistant message ends up with toolCalls === undefined (length===0
    // collapses to undefined per providers/openai.ts:196).
    assert.equal(assistant.toolCalls, undefined)
  })
})

describe("Network unreachable", () => {
  test("provider.chat rejects with fetch failed / ECONNREFUSED at a closed port", async () => {
    // Reserve a port by binding/closing, then point the provider at it.
    // This is more robust than hardcoding port 1 (which behaves
    // inconsistently inside some container/CI sandboxes).
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const addr = server.address() as AddressInfo
    const closedPort = addr.port
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })

    const provider = new AnthropicProvider({
      apiKey: "dummy",
      baseUrl: `http://127.0.0.1:${closedPort}`,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 256,
      engineKind: "anthropic.messages",
    })

    await assert.rejects(
      () => provider.chat({ system: "x", contextWindow: userWindow("hi") }),
      (err: unknown) => {
        const text = aggregateErrorText(err)
        return /fetch failed|ECONNREFUSED|ECONNRESET/i.test(text)
      }
    )
  })
})

// Walks Error.message + .cause chain and concatenates everything to a single
// string for substring matching. Node's undici puts ECONNREFUSED on the
// `.cause` AggregateError, not on the top-level message ("fetch failed").
function aggregateErrorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  while (cur) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      // Surface any nested AggregateError children.
      const agg = cur as Error & { errors?: unknown[]; cause?: unknown }
      if (Array.isArray(agg.errors)) {
        for (const e of agg.errors) {
          if (e instanceof Error) parts.push(e.message)
          else parts.push(String(e))
        }
      }
      cur = (cur as { cause?: unknown }).cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join(" | ")
}
