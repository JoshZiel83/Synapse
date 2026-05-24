// Verifies all 4 LLM providers fold CanonicalToolResult.structuredContent
// into their tool_result wire payload (since none of them have a native
// structuredContent field). Without this, the model never sees the MCP
// protocol's structured sidecar JSON — the Phase 1 first-class field is
// useless on the way out.
import test from "node:test"
import assert from "node:assert/strict"

import { formatStructuredContentForProvider, textBlocks } from "@synapse/shared"
import type { CanonicalToolResult, ConversationMessage } from "@synapse/shared"

import { AnthropicProvider } from "./providers/anthropic.js"
import { OpenAIChatCompletionsProvider } from "./providers/openai.js"
import { OpenAIResponsesProvider } from "./providers/openai-responses.js"
import { BigModelChatCompletionsProvider } from "./providers/bigmodel.js"

const STRUCT_PAYLOAD = { hit: true, score: 0.91, label: "match" }

function toolResultMessage(
  structuredContent?: Record<string, unknown>
): ConversationMessage {
  const tr: CanonicalToolResult = {
    toolCallId: "call-1",
    providerCallId: "prov-call-1",
    toolName: "lookup",
    content: textBlocks("primary tool output"),
    isError: false,
    origin: { kind: "mcp_remote", serverKey: "github" },
  }
  if (structuredContent) tr.structuredContent = structuredContent
  return { role: "tool_result", results: [tr] }
}

test("formatStructuredContentForProvider wraps non-empty objects, skips empty/null", () => {
  const wrapped = formatStructuredContentForProvider(STRUCT_PAYLOAD)
  assert.match(wrapped, /<structured_content>/)
  assert.match(wrapped, /"hit": true/)
  assert.equal(formatStructuredContentForProvider(undefined), "")
  assert.equal(formatStructuredContentForProvider(null), "")
  assert.equal(formatStructuredContentForProvider({}), "")
  assert.equal(formatStructuredContentForProvider("not an object"), "")
})

test("Anthropic provider appends structured_content as extra tool_result content block", async () => {
  const provider = new AnthropicProvider({
    apiKey: "stub",
    model: "stub",
  } as any)
  const messages = await (provider as any).convertMessages(
    [toolResultMessage(STRUCT_PAYLOAD)],
    {
      image: false,
      document: false,
      audio: false,
    }
  )
  // Anthropic's user-role message with tool_result block
  const last = messages[messages.length - 1]
  assert.equal(last.role, "user")
  const toolResult = (last.content as any[]).find(
    (b) => b.type === "tool_result"
  )
  assert.ok(toolResult, "expected a tool_result block")
  const contentArr = toolResult.content as any[]
  // First block is the primary text (resolved from textBlocks), then the
  // structured_content suffix as a separate text block.
  const structuredBlock = contentArr.find(
    (b) => b.type === "text" && /<structured_content>/.test(String(b.text))
  )
  assert.ok(
    structuredBlock,
    `expected structured_content text block in: ${JSON.stringify(contentArr)}`
  )
  assert.match(String(structuredBlock.text), /"score": 0\.91/)
})

test("Anthropic provider omits structured_content when not set", async () => {
  const provider = new AnthropicProvider({
    apiKey: "stub",
    model: "stub",
  } as any)
  const messages = await (provider as any).convertMessages(
    [toolResultMessage()],
    {
      image: false,
      document: false,
      audio: false,
    }
  )
  const last = messages[messages.length - 1]
  const toolResult = (last.content as any[]).find(
    (b) => b.type === "tool_result"
  )
  const contentArr = toolResult.content
  const dump = JSON.stringify(contentArr)
  assert.doesNotMatch(dump, /<structured_content>/)
})

test("OpenAI provider suffixes tool message content with structured_content", async () => {
  const provider = new OpenAIChatCompletionsProvider({
    apiKey: "stub",
    model: "stub",
  } as any)
  const messages = await (provider as any).convertMessages(
    [toolResultMessage(STRUCT_PAYLOAD)],
    {
      image: false,
      document: false,
      audio: false,
    }
  )
  const last = messages[messages.length - 1]
  assert.equal(last.role, "tool")
  assert.match(String(last.content), /<structured_content>/)
  assert.match(String(last.content), /"label": "match"/)
})

test("OpenAI Responses provider suffixes function_call_output", async () => {
  const provider = new OpenAIResponsesProvider({
    apiKey: "stub",
    model: "stub",
  } as any)
  const messages = await (provider as any).convertMessages(
    [toolResultMessage(STRUCT_PAYLOAD)],
    {
      image: false,
      document: false,
      audio: false,
    }
  )
  const last = messages[messages.length - 1]
  assert.equal(last.type, "function_call_output")
  assert.match(String(last.output), /<structured_content>/)
})

test("BigModel provider suffixes tool message content with structured_content", async () => {
  const provider = new BigModelChatCompletionsProvider({
    apiKey: "stub",
    model: "stub",
  } as any)
  const messages = await (provider as any).convertMessages(
    [toolResultMessage(STRUCT_PAYLOAD)],
    {
      image: false,
      document: false,
      audio: false,
    }
  )
  const last = messages[messages.length - 1]
  assert.equal(last.role, "tool")
  assert.match(String(last.content), /<structured_content>/)
  assert.match(String(last.content), /"hit": true/)
})
