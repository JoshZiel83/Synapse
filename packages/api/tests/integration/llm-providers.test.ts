// Provider conformance tests against a MockServer-backed LLM endpoint.
//
// For each of the four AI providers (Anthropic Messages, OpenAI Chat
// Completions, OpenAI Responses, BigModel Chat Completions) we verify:
//   1. Plain text request/response shape — headers, body fields, parsed
//      AIResponse + tokensUsed + stopReason.
//   2. Tool-definition request and tool_use/tool_call response parse —
//      tools[] envelope per provider, parsed ToolCall[] with providerCallId.
//
// Plus BigModel-specific guards:
//   - buildBigModelChatEndpoint URL normalization (3 baseUrl shapes all POST
//     to /paas/v4/chat/completions).
//   - getModelMaxTokensLimit cap (glm-4.5-flash limits max_tokens to 98304).
//
// And an Anthropic-specific guard:
//   - buildAnthropicToolAlias hash-suffix path: a tool name with a special
//     character is rewritten to <normalized>_<sha8> on the wire and parsed
//     back to the canonical name via aliasToCanonical.
//
// No DB query, no spawnApi. The test instantiates providers directly and
// only relies on MockServer + node fetch.

import { after, before, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"

import { AnthropicProvider } from "../../src/modules/ai/providers/anthropic.js"
import { OpenAIChatCompletionsProvider } from "../../src/modules/ai/providers/openai.js"
import { OpenAIResponsesProvider } from "../../src/modules/ai/providers/openai-responses.js"
import { BigModelChatCompletionsProvider } from "../../src/modules/ai/providers/bigmodel.js"
import { buildAdHocContextItems } from "../../src/modules/ai/context-builder.js"
import { buildAdHocProviderContextWindow } from "../../src/modules/context/service.js"
import { extractText, textBlock, type ToolDefinition } from "@synapse/shared"

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
  type MockLLMHandle,
} from "./harness/mock-llm.js"

const weatherTool: ToolDefinition = {
  name: "weather_get",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "The city to look up.",
      },
    },
    required: ["city"],
  },
}

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
    buildAdHocContextItems([
      { role: "user", content: [textBlock(text)] },
    ])
  )
}

function jsonResponse(json: Record<string, unknown>, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": ["application/json"] },
    body: { type: "JSON", json },
  }
}

describe("AnthropicProvider conformance", () => {
  test("plain text request and response", async () => {
    const responseBody = buildAnthropicTextResponse({
      text: "Hello world",
      inputTokens: 5,
      outputTokens: 3,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/messages" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new AnthropicProvider({
      apiKey: "dummy-anthropic-key",
      baseUrl: mock!.baseUrl,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      engineKind: "anthropic.messages",
    })

    const response = await provider.chat({
      system: "You are helpful.",
      contextWindow: userWindow("Hello."),
    })

    const assistant = response.context[0]
    assert.equal(assistant?.role, "assistant")
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.equal(extractText(assistant.content), "Hello world")
    assert.equal(assistant.toolCalls, undefined)
    assert.deepEqual(response.tokensUsed, { input: 5, output: 3 })
    assert.equal(response.stopReason, "end_turn")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/messages",
    })
    assert.equal(recorded.length, 1)
    const req = recorded[0]
    assert.equal(req.getHeader("x-api-key"), "dummy-anthropic-key")
    assert.equal(req.getHeader("anthropic-version"), "2023-06-01")
    assert.ok(
      req.getHeader("content-type")?.startsWith("application/json"),
      `unexpected content-type: ${req.getHeader("content-type")}`
    )
    // No Authorization header — Anthropic uses x-api-key only.
    assert.equal(req.getHeader("authorization"), undefined)

    const body = req.bodyJson as Record<string, unknown>
    assert.equal(body.model, "claude-haiku-4-5-20251001")
    assert.equal(body.max_tokens, 1024)
    assert.equal(body.system, "You are helpful.")
    assert.ok(Array.isArray(body.messages))
    const messages = body.messages as Array<{ role: string }>
    assert.ok(messages.length >= 1)
    for (const m of messages) {
      assert.ok(
        m.role === "user" || m.role === "assistant",
        `unexpected role ${m.role}`
      )
    }
    // Anthropic-padding invariant: the wire request must NOT end on an
    // assistant message (providers/anthropic.ts:551-559).
    assert.notEqual(messages[messages.length - 1].role, "assistant")
    assert.equal(body.tools, undefined)
  })

  test("tool definition and tool_use response", async () => {
    const responseBody = buildAnthropicToolUseResponse({
      toolUseId: "toolu_abc",
      toolName: "weather_get",
      input: { city: "Beijing" },
      inputTokens: 10,
      outputTokens: 8,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/messages" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new AnthropicProvider({
      apiKey: "dummy-anthropic-key",
      baseUrl: mock!.baseUrl,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      engineKind: "anthropic.messages",
    })

    const response = await provider.chat({
      system: "You are a weather assistant.",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.ok(assistant.toolCalls && assistant.toolCalls.length === 1)
    const call = assistant.toolCalls[0]
    assert.ok(call.callId.length > 0)
    assert.equal(call.providerCallId, "toolu_abc")
    assert.equal(call.toolName, "weather_get")
    assert.deepEqual(call.input, { city: "Beijing" })

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/messages",
    })
    assert.equal(recorded.length, 1)
    const body = recorded[0].bodyJson as Record<string, unknown>
    assert.ok(Array.isArray(body.tools))
    const tools = body.tools as Array<{
      name: string
      description: string
      input_schema: unknown
    }>
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, "weather_get")
    assert.equal(tools[0].description, weatherTool.description)
    assert.deepEqual(tools[0].input_schema, weatherTool.parameters)
    assert.deepEqual(body.tool_choice, { type: "auto" })
  })

  test("tool name with non-safe char is aliased + hashed on wire", async () => {
    // buildAnthropicToolAlias triggers when canonical !== normalized — a dot
    // gets normalized to underscore, but the rewritten name then doesn't
    // match the original, so a 9-char `_<sha8>` suffix is appended.
    // Round-trip: the provider's aliasToCanonical map reverses this on the
    // parsed response, so the toolName surfaces back as "weather.get".
    const aliasedTool: ToolDefinition = {
      name: "weather.get",
      description: weatherTool.description,
      parameters: weatherTool.parameters,
    }

    // The mock returns the rewritten alias in tool_use.name; that's what
    // would actually come back from Anthropic in production after the
    // provider sent the aliased tools[] up. We register *after* checking
    // what alias the provider mints so the mock echoes the same alias.
    //
    // We can't easily compute the sha8 here without depending on internal
    // helpers, so register a permissive expectation and read the actual
    // wire-side name from the recorded request to construct the expected
    // alias for the response parse step instead — but for THIS test we
    // care only that:
    //   (a) the wire name matches /^weather_ge_[0-9a-f]{8}$/
    //   (b) the parsed toolName surfaces back as "weather.get"
    // So we structure the test in two phases.

    // Phase 1: register a tool_use response that mirrors WHATEVER alias the
    // provider sends. The alias is constructed deterministically as
    // `<normalized>_<sha8(rawName)>` (providers/anthropic.ts:74-78). For
    // rawName="weather.get": normalized="weather_get", so the alias is
    // "weather_get_<sha8>".
    const { createHash } = await import("node:crypto")
    const hash = createHash("sha256").update("weather.get").digest("hex").slice(0, 8)
    const expectedAlias = `weather_get_${hash}`

    const responseBody = buildAnthropicToolUseResponse({
      toolUseId: "toolu_aliased",
      toolName: expectedAlias,
      input: { city: "Shanghai" },
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/messages" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new AnthropicProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 1024,
      engineKind: "anthropic.messages",
    })

    const response = await provider.chat({
      system: "x",
      contextWindow: userWindow("weather please"),
      tools: [aliasedTool],
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    // (b) provider reverses the alias back to canonical name.
    assert.equal(assistant.toolCalls?.[0].toolName, "weather.get")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/messages",
    })
    const body = recorded[0].bodyJson as { tools: Array<{ name: string }> }
    // (a) wire tools[0].name is the hashed alias, not the canonical name.
    assert.match(body.tools[0].name, /^weather_get_[0-9a-f]{8}$/)
    assert.equal(body.tools[0].name, expectedAlias)
  })
})

describe("OpenAIChatCompletionsProvider conformance", () => {
  test("plain text request and response", async () => {
    const responseBody = buildOpenAIChatTextResponse({
      text: "Hello world",
      promptTokens: 7,
      completionTokens: 4,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "dummy-openai-key",
      baseUrl: mock!.baseUrl,
      model: "gpt-4.1",
      maxTokens: 512,
      engineKind: "openai.chat_completions",
    })

    const response = await provider.chat({
      system: "You are helpful.",
      contextWindow: userWindow("Hi."),
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.equal(extractText(assistant.content), "Hello world")
    assert.deepEqual(response.tokensUsed, { input: 7, output: 4 })
    assert.equal(response.stopReason, "stop")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/chat/completions",
    })
    assert.equal(recorded.length, 1)
    const req = recorded[0]
    assert.equal(req.getHeader("authorization"), "Bearer dummy-openai-key")
    assert.ok(req.getHeader("content-type")?.startsWith("application/json"))
    // No x-api-key for OpenAI.
    assert.equal(req.getHeader("x-api-key"), undefined)

    const body = req.bodyJson as Record<string, unknown>
    assert.equal(body.model, "gpt-4.1")
    assert.equal(body.max_tokens, 512)
    assert.ok(Array.isArray(body.messages))
    const messages = body.messages as Array<{ role: string; content: unknown }>
    // OpenAI injects system as the FIRST message.
    assert.equal(messages[0].role, "system")
    assert.equal(messages[0].content, "You are helpful.")
    assert.equal(body.tools, undefined)
  })

  test("tool definition and tool_call response", async () => {
    const responseBody = buildOpenAIChatToolCallResponse({
      toolCallId: "call_abc",
      toolName: "weather_get",
      argumentsJson: JSON.stringify({ city: "Beijing" }),
      promptTokens: 12,
      completionTokens: 6,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new OpenAIChatCompletionsProvider({
      apiKey: "dummy-openai-key",
      baseUrl: mock!.baseUrl,
      model: "gpt-4.1",
      maxTokens: 512,
      engineKind: "openai.chat_completions",
    })

    const response = await provider.chat({
      system: "You are helpful.",
      contextWindow: userWindow("What's the weather in Beijing?"),
      tools: [weatherTool],
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    const call = assistant.toolCalls?.[0]
    assert.ok(call)
    assert.equal(call.providerCallId, "call_abc")
    assert.equal(call.toolName, "weather_get")
    assert.deepEqual(call.input, { city: "Beijing" })
    assert.equal(response.stopReason, "tool_calls")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/chat/completions",
    })
    const body = recorded[0].bodyJson as Record<string, unknown>
    assert.ok(Array.isArray(body.tools))
    const tools = body.tools as Array<{
      type: string
      function: { name: string; description: string; parameters: unknown }
    }>
    assert.equal(tools.length, 1)
    assert.equal(tools[0].type, "function")
    assert.equal(tools[0].function.name, "weather_get")
    assert.equal(tools[0].function.description, weatherTool.description)
    assert.deepEqual(tools[0].function.parameters, weatherTool.parameters)
    assert.equal(body.tool_choice, "auto")
  })
})

describe("OpenAIResponsesProvider conformance", () => {
  test("plain text request and response", async () => {
    const responseBody = buildOpenAIResponsesTextResponse({
      text: "Hello world",
      inputTokens: 9,
      outputTokens: 4,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/responses" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new OpenAIResponsesProvider({
      apiKey: "dummy-openai-key",
      baseUrl: mock!.baseUrl,
      model: "gpt-5",
      maxTokens: 512,
      engineKind: "openai.responses",
    })

    const response = await provider.chat({
      system: "You are helpful.",
      contextWindow: userWindow("Hi."),
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.equal(extractText(assistant.content), "Hello world")
    assert.deepEqual(response.tokensUsed, { input: 9, output: 4 })
    // No tool calls in this response — stopReason falls through to
    // data.status || "completed".
    assert.equal(response.stopReason, "completed")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/responses",
    })
    assert.equal(recorded.length, 1)
    const req = recorded[0]
    assert.equal(req.getHeader("authorization"), "Bearer dummy-openai-key")

    const body = req.bodyJson as Record<string, unknown>
    assert.equal(body.model, "gpt-5")
    assert.equal(body.max_output_tokens, 512)
    assert.equal(body.instructions, "You are helpful.")
    assert.ok(Array.isArray(body.input))
    assert.equal(body.tools, undefined)
  })

  test("tool definition and function_call response", async () => {
    const responseBody = buildOpenAIResponsesFunctionCallResponse({
      callId: "call_resp_abc",
      name: "weather_get",
      argumentsJson: JSON.stringify({ city: "Beijing" }),
      inputTokens: 11,
      outputTokens: 5,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/v1/responses" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new OpenAIResponsesProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "gpt-5",
      maxTokens: 512,
      engineKind: "openai.responses",
    })

    const response = await provider.chat({
      system: "x",
      contextWindow: userWindow("weather"),
      tools: [weatherTool],
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    const call = assistant.toolCalls?.[0]
    assert.ok(call)
    assert.equal(call.providerCallId, "call_resp_abc")
    assert.equal(call.toolName, "weather_get")
    assert.deepEqual(call.input, { city: "Beijing" })
    assert.equal(response.stopReason, "tool_calls")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/v1/responses",
    })
    const body = recorded[0].bodyJson as Record<string, unknown>
    assert.ok(Array.isArray(body.tools))
    const tools = body.tools as Array<{
      type: string
      name: string
      description: string
      parameters: unknown
    }>
    assert.equal(tools.length, 1)
    assert.equal(tools[0].type, "function")
    assert.equal(tools[0].name, "weather_get")
    assert.equal(tools[0].description, weatherTool.description)
    assert.deepEqual(tools[0].parameters, weatherTool.parameters)
    assert.equal(body.tool_choice, "auto")
  })
})

describe("BigModelChatCompletionsProvider conformance", () => {
  test("plain text request and response", async () => {
    const responseBody = buildBigModelTextResponse({
      text: "你好",
      promptTokens: 4,
      completionTokens: 2,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/paas/v4/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new BigModelChatCompletionsProvider({
      apiKey: "dummy-bigmodel-key",
      baseUrl: mock!.baseUrl,
      model: "glm-4.6",
      maxTokens: 1024,
      engineKind: "bigmodel.chat_completions",
    })

    const response = await provider.chat({
      system: "你是助手。",
      contextWindow: userWindow("你好"),
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    assert.equal(extractText(assistant.content), "你好")
    assert.deepEqual(response.tokensUsed, { input: 4, output: 2 })
    assert.equal(response.stopReason, "stop")

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/paas/v4/chat/completions",
    })
    assert.equal(recorded.length, 1)
    const req = recorded[0]
    assert.equal(req.getHeader("authorization"), "Bearer dummy-bigmodel-key")
    const body = req.bodyJson as Record<string, unknown>
    assert.equal(body.model, "glm-4.6")
    // First message must be the system prompt.
    const messages = body.messages as Array<{ role: string; content: unknown }>
    assert.equal(messages[0].role, "system")
    assert.equal(messages[0].content, "你是助手。")
  })

  test("tool definition and tool_call response", async () => {
    const responseBody = buildBigModelToolCallResponse({
      toolCallId: "call_bigmodel_abc",
      toolName: "weather_get",
      argumentsJson: JSON.stringify({ city: "Beijing" }),
      promptTokens: 12,
      completionTokens: 6,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/paas/v4/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new BigModelChatCompletionsProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "glm-4.6",
      maxTokens: 1024,
      engineKind: "bigmodel.chat_completions",
    })

    const response = await provider.chat({
      system: "x",
      contextWindow: userWindow("weather"),
      tools: [weatherTool],
    })

    const assistant = response.context[0]
    if (assistant?.role !== "assistant") throw new Error("unreachable")
    const call = assistant.toolCalls?.[0]
    assert.ok(call)
    assert.equal(call.providerCallId, "call_bigmodel_abc")
    assert.equal(call.toolName, "weather_get")
    assert.deepEqual(call.input, { city: "Beijing" })

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/paas/v4/chat/completions",
    })
    const body = recorded[0].bodyJson as Record<string, unknown>
    const tools = body.tools as Array<{
      type: string
      function: { name: string; parameters: unknown }
    }>
    assert.equal(tools[0].type, "function")
    assert.equal(tools[0].function.name, "weather_get")
    assert.deepEqual(tools[0].function.parameters, weatherTool.parameters)
    assert.equal(body.tool_choice, "auto")
  })

  test("buildBigModelChatEndpoint URL normalization", async () => {
    // All three baseUrl shapes must POST to /paas/v4/chat/completions
    // (providers/bigmodel.ts:68-73). Run the same minimal request three
    // times with different baseUrl suffixes and confirm the mock received
    // exactly three requests at the canonical path.
    const responseBody = buildBigModelTextResponse({
      text: "ok",
      promptTokens: 1,
      completionTokens: 1,
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/paas/v4/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const baseUrlVariants = [
      mock!.baseUrl,
      `${mock!.baseUrl}/`,
      `${mock!.baseUrl}/paas/v4`,
      `${mock!.baseUrl}/paas/v4/chat/completions`,
    ]
    for (const baseUrl of baseUrlVariants) {
      const provider = new BigModelChatCompletionsProvider({
        apiKey: "dummy",
        baseUrl,
        model: "glm-4.6",
        maxTokens: 16,
        engineKind: "bigmodel.chat_completions",
      })
      await provider.chat({ system: "x", contextWindow: userWindow("hi") })
    }

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/paas/v4/chat/completions",
    })
    assert.equal(recorded.length, baseUrlVariants.length)
    for (const req of recorded) {
      assert.equal(req.path, "/paas/v4/chat/completions")
    }
  })

  test("getModelMaxTokensLimit caps max_tokens for glm-4.5-flash", async () => {
    // glm-4.5-flash maxOutputTokens is 98304 per
    // packages/shared/src/constants/model-providers.ts:60; passing a higher
    // requested max_tokens must be capped on the wire
    // (providers/bigmodel.ts:148-152).
    const responseBody = buildBigModelTextResponse({
      text: "ok",
      promptTokens: 1,
      completionTokens: 1,
      model: "glm-4.5-flash",
    })
    await mock!.expect({
      httpRequest: { method: "POST", path: "/paas/v4/chat/completions" },
      httpResponse: jsonResponse(responseBody),
    })

    const provider = new BigModelChatCompletionsProvider({
      apiKey: "dummy",
      baseUrl: mock!.baseUrl,
      model: "glm-4.5-flash",
      maxTokens: 200_000,
      engineKind: "bigmodel.chat_completions",
    })

    await provider.chat({ system: "x", contextWindow: userWindow("hi") })

    const recorded = await mock!.recorded({
      method: "POST",
      path: "/paas/v4/chat/completions",
    })
    const body = recorded[0].bodyJson as Record<string, unknown>
    assert.equal(body.max_tokens, 98304)
  })
})
