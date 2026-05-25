// Tool result wire-level serialization tests.
//
// For each of the 4 providers, drives two back-to-back provider.chat() calls:
//   round 1 — a user-only context window; MockServer returns a tool_use /
//             tool_call / function_call response. Parsed ToolCall is reused
//             in round 2.
//   round 2 — context window includes tool_call_batch + tool_result_batch
//             items (the same bundleId). MockServer is configured with two
//             expectations distinguished by body matcher + priority:
//               round-1 expectation: path-only, priority 0
//               round-2 expectation: JSONPath body match for the provider-
//                                    native tool_result marker, priority 10
//             so the round-2 LLM call goes to the text-returning expectation.
//
// The critical assertion is on the SECOND recorded request body — it must
// carry the provider-native tool_result envelope (tool_result block for
// Anthropic, role:"tool" message for OpenAI Chat / BigModel,
// function_call_output for OpenAI Responses).
//
// This file deliberately does NOT exercise actorThink's orchestration loop
// (dispatcher, mcpExecutor, sleep semantics) — that's a separate test
// dimension; see plan §"不在范围" for why.

import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

import { AnthropicProvider } from "../../src/modules/ai/providers/anthropic.js"
import { BigModelChatCompletionsProvider } from "../../src/modules/ai/providers/bigmodel.js"
import { OpenAIChatCompletionsProvider } from "../../src/modules/ai/providers/openai.js"
import { OpenAIResponsesProvider } from "../../src/modules/ai/providers/openai-responses.js"
import { buildAdHocContextItems } from "../../src/modules/ai/context-builder.js"
import { buildAdHocProviderContextWindow } from "../../src/modules/context/service.js"
import {
  textBlock,
  type CanonicalContextItem,
  type CanonicalToolResult,
  type ToolDefinition,
} from "@synapse/shared"

import {
  buildAnthropicTextResponse,
  buildAnthropicToolUseResponse,
  buildBigModelTextResponse,
  buildBigModelToolCallResponse,
  buildOpenAIChatTextResponse,
  buildOpenAIChatToolCallResponse,
  buildOpenAIResponsesFunctionCallResponse,
  buildOpenAIResponsesTextResponse,
  startMockLLM,
  toolCallBatchItem,
  toolResultBatchItem,
  type MockLLMHandle,
} from "./harness/mock-llm.js"

const weatherTool: ToolDefinition = {
  name: "weather_get",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "The city to look up." },
    },
    required: ["city"],
  },
}

const WEATHER_PAYLOAD = { tempC: 22, condition: "sunny" }
const WEATHER_PAYLOAD_TEXT = JSON.stringify(WEATHER_PAYLOAD)
const FINAL_TEXT = "Beijing is 22°C and sunny."

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

function jsonResponse(json: Record<string, unknown>, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": ["application/json"] },
    body: { type: "JSON", json },
  }
}

// Extracts (callId, providerCallId) from a round-1 AIResponse and asserts
// the provider-id was actually parsed out of the mock response. We then
// thread BOTH ids back into roundTwoWindow(), which means the round-2
// request-body assertion later in the test verifies the complete
// "provider response parse → tool result → next request carries provider
// id" path — not just the wire shape with a hardcoded id.
function extractParsedCall(
  r1: {
    context: Array<{
      role?: string
      toolCalls?: Array<{ callId: string; providerCallId?: string }>
    }>
  },
  expectedProviderCallId: string
): { callId: string; providerCallId: string } {
  const m = r1.context[0]
  if (m?.role !== "assistant" || !m.toolCalls?.[0]) {
    throw new Error("round 1 did not return a tool call")
  }
  const call = m.toolCalls[0]
  assert.equal(
    call.providerCallId,
    expectedProviderCallId,
    `round-1 parsed providerCallId mismatch; expected ${expectedProviderCallId}, got ${call.providerCallId}`
  )
  return { callId: call.callId, providerCallId: call.providerCallId! }
}

function buildToolResult(opts: {
  callId: string
  providerCallId: string
}): CanonicalToolResult {
  return {
    toolCallId: opts.callId,
    providerCallId: opts.providerCallId,
    toolName: weatherTool.name,
    content: [textBlock(WEATHER_PAYLOAD_TEXT)],
    isError: false,
    origin: { kind: "mcp_remote", serverKey: "weather/v1" },
  }
}

function roundTwoWindow(opts: {
  userText: string
  callId: string
  providerCallId: string
}) {
  const bundleId = randomUUID()
  const items: CanonicalContextItem[] = [
    ...buildAdHocContextItems([
      { role: "user", content: [textBlock(opts.userText)] },
    ]),
    toolCallBatchItem(
      [
        {
          callId: opts.callId,
          providerCallId: opts.providerCallId,
          toolName: weatherTool.name,
          input: { city: "Beijing" },
        },
      ],
      bundleId
    ),
    toolResultBatchItem(
      [
        buildToolResult({
          callId: opts.callId,
          providerCallId: opts.providerCallId,
        }),
      ],
      bundleId
    ),
  ]
  return buildAdHocProviderContextWindow(items)
}

describe("Anthropic tool_result wire-level serialization", () => {
  test("round 2 request carries native tool_result block", async () => {
    // Round 1 — low priority, path only.
    await mock!.expect({
      priority: 0,
      httpRequest: mock!.matchers.anthropic.round1,
      httpResponse: jsonResponse(
        buildAnthropicToolUseResponse({
          toolUseId: "toolu_abc",
          toolName: weatherTool.name,
          input: { city: "Beijing" },
          inputTokens: 10,
          outputTokens: 8,
        })
      ),
    })
    // Round 2 — high priority, matches body with tool_use_id JSON path.
    await mock!.expect({
      priority: 10,
      httpRequest: mock!.matchers.anthropic.round2,
      httpResponse: jsonResponse(
        buildAnthropicTextResponse({
          text: FINAL_TEXT,
          inputTokens: 25,
          outputTokens: 12,
        })
      ),
    })

    const provider = new AnthropicProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      engineKind: "anthropic.messages",
    })

    const r1 = await provider.chat({
      system: "x",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })
    const { callId, providerCallId } = extractParsedCall(r1, "toolu_abc")

    const r2 = await provider.chat({
      system: "x",
      contextWindow: roundTwoWindow({
        userText: "What's the weather in Beijing?",
        callId,
        providerCallId,
      }),
      tools: [weatherTool],
    })
    const r2Msg = r2.context[0]
    if (r2Msg?.role !== "assistant") throw new Error("unreachable")
    // Final assistant text contains the result content.
    assert.equal(r2.stopReason, "end_turn")
    // text content includes 22 (from the canned response).
    const final = r2Msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    assert.match(final, /22/)

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/messages",
    })
    assert.equal(recorded.length, 2)
    const r2Body = recorded[1].bodyJson as {
      messages: Array<{
        role: string
        content: Array<Record<string, unknown>>
      }>
    }
    // Anthropic appends a synthetic "Please continue." user turn when the
    // last message would otherwise be assistant (providers/anthropic.ts:
    // 551-559). So the LAST user message we care about is the one whose
    // content carries the tool_result block — not necessarily messages[-1].
    const userWithToolResult = r2Body.messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result")
    )
    assert.ok(
      userWithToolResult,
      `no user message contained a tool_result; messages=${JSON.stringify(r2Body.messages).slice(0, 400)}`
    )
    const toolResultBlock = userWithToolResult.content.find(
      (b) => b.type === "tool_result"
    ) as Record<string, unknown>
    assert.equal(toolResultBlock.tool_use_id, "toolu_abc")
    assert.equal(toolResultBlock.is_error, false)
    const trContent = toolResultBlock.content as Array<{
      type: string
      text?: string
    }>
    assert.ok(Array.isArray(trContent))
    const trText = trContent
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
    assert.match(trText, /22/)
  })
})

describe("OpenAI Chat tool_call_id wire-level serialization", () => {
  test("round 2 request carries native role:tool message", async () => {
    await mock!.expect({
      priority: 0,
      httpRequest: mock!.matchers.openaiChat.round1,
      httpResponse: jsonResponse(
        buildOpenAIChatToolCallResponse({
          toolCallId: "call_abc",
          toolName: weatherTool.name,
          argumentsJson: JSON.stringify({ city: "Beijing" }),
          promptTokens: 10,
          completionTokens: 8,
        })
      ),
    })
    await mock!.expect({
      priority: 10,
      httpRequest: mock!.matchers.openaiChat.round2,
      httpResponse: jsonResponse(
        buildOpenAIChatTextResponse({
          text: FINAL_TEXT,
          promptTokens: 25,
          completionTokens: 12,
        })
      ),
    })

    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "gpt-4.1",
      maxTokens: 512,
      engineKind: "openai.chat_completions",
    })

    const r1 = await provider.chat({
      system: "x",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })
    const { callId, providerCallId } = extractParsedCall(r1, "call_abc")

    const r2 = await provider.chat({
      system: "x",
      contextWindow: roundTwoWindow({
        userText: "What's the weather in Beijing?",
        callId,
        providerCallId,
      }),
      tools: [weatherTool],
    })
    const r2Msg = r2.context[0]
    if (r2Msg?.role !== "assistant") throw new Error("unreachable")
    const final = r2Msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    assert.match(final, /22/)

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/chat/completions",
    })
    assert.equal(recorded.length, 2)
    const r2Body = recorded[1].bodyJson as {
      messages: Array<{
        role: string
        tool_call_id?: string
        content?: unknown
      }>
    }
    const toolMsg = r2Body.messages.find((m) => m.role === "tool")
    assert.ok(
      toolMsg,
      `no role:tool message found; messages=${JSON.stringify(r2Body.messages).slice(0, 400)}`
    )
    assert.equal(toolMsg.tool_call_id, "call_abc")
    assert.match(String(toolMsg.content), /22/)
  })
})

describe("OpenAI Responses function_call_output wire-level serialization", () => {
  test("round 2 request carries native function_call_output input entry", async () => {
    await mock!.expect({
      priority: 0,
      httpRequest: mock!.matchers.openaiResponses.round1,
      httpResponse: jsonResponse(
        buildOpenAIResponsesFunctionCallResponse({
          callId: "call_resp_abc",
          name: weatherTool.name,
          argumentsJson: JSON.stringify({ city: "Beijing" }),
          inputTokens: 10,
          outputTokens: 8,
        })
      ),
    })
    await mock!.expect({
      priority: 10,
      httpRequest: mock!.matchers.openaiResponses.round2,
      httpResponse: jsonResponse(
        buildOpenAIResponsesTextResponse({
          text: FINAL_TEXT,
          inputTokens: 25,
          outputTokens: 12,
        })
      ),
    })

    const provider = new OpenAIResponsesProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "gpt-5",
      maxTokens: 512,
      engineKind: "openai.responses",
    })

    const r1 = await provider.chat({
      system: "x",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })
    const { callId, providerCallId } = extractParsedCall(r1, "call_resp_abc")

    const r2 = await provider.chat({
      system: "x",
      contextWindow: roundTwoWindow({
        userText: "What's the weather in Beijing?",
        callId,
        providerCallId,
      }),
      tools: [weatherTool],
    })
    const r2Msg = r2.context[0]
    if (r2Msg?.role !== "assistant") throw new Error("unreachable")
    const final = r2Msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    assert.match(final, /22/)

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/responses",
    })
    assert.equal(recorded.length, 2)
    const r2Body = recorded[1].bodyJson as {
      input: Array<{ type?: string; call_id?: string; output?: unknown }>
    }
    const fco = r2Body.input.find((i) => i.type === "function_call_output")
    assert.ok(
      fco,
      `no function_call_output found; input=${JSON.stringify(r2Body.input).slice(0, 400)}`
    )
    assert.equal(fco.call_id, "call_resp_abc")
    assert.match(String(fco.output), /22/)
  })
})

describe("BigModel tool_call_id wire-level serialization", () => {
  test("round 2 request carries native role:tool message", async () => {
    await mock!.expect({
      priority: 0,
      httpRequest: mock!.matchers.bigmodel.round1,
      httpResponse: jsonResponse(
        buildBigModelToolCallResponse({
          toolCallId: "call_bm_abc",
          toolName: weatherTool.name,
          argumentsJson: JSON.stringify({ city: "Beijing" }),
          promptTokens: 10,
          completionTokens: 8,
        })
      ),
    })
    await mock!.expect({
      priority: 10,
      httpRequest: mock!.matchers.bigmodel.round2,
      httpResponse: jsonResponse(
        buildBigModelTextResponse({
          text: FINAL_TEXT,
          promptTokens: 25,
          completionTokens: 12,
        })
      ),
    })

    const provider = new BigModelChatCompletionsProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "glm-4.6",
      maxTokens: 1024,
      engineKind: "bigmodel.chat_completions",
    })

    const r1 = await provider.chat({
      system: "x",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })
    const { callId, providerCallId } = extractParsedCall(r1, "call_bm_abc")

    const r2 = await provider.chat({
      system: "x",
      contextWindow: roundTwoWindow({
        userText: "What's the weather in Beijing?",
        callId,
        providerCallId,
      }),
      tools: [weatherTool],
    })
    const r2Msg = r2.context[0]
    if (r2Msg?.role !== "assistant") throw new Error("unreachable")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/paas/v4/chat/completions",
    })
    assert.equal(recorded.length, 2)
    const r2Body = recorded[1].bodyJson as {
      messages: Array<{
        role: string
        tool_call_id?: string
        content?: unknown
      }>
    }
    const toolMsg = r2Body.messages.find((m) => m.role === "tool")
    assert.ok(
      toolMsg,
      `no role:tool message found; messages=${JSON.stringify(r2Body.messages).slice(0, 400)}`
    )
    assert.equal(toolMsg.tool_call_id, "call_bm_abc")
    assert.match(String(toolMsg.content), /22/)
  })
})
