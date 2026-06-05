// Verifies the canonical→ModelMessage mapper folds
// CanonicalToolResult.structuredContent into the neutral tool-result output
// (the AI SDK has no native structuredContent field, so it must reach the model
// inline). After the AI-SDK migration there is ONE mapper (toModelMessages)
// instead of four per-provider convertMessages, so this is the single place the
// behavior is exercised.
import test from "node:test"
import assert from "node:assert/strict"

import { formatStructuredContentForProvider, textBlocks } from "@synapse/shared"
import type { CanonicalToolResult, ConversationMessage } from "@synapse/shared"

import { toModelMessages } from "./providers/to-model-messages.js"

const STRUCT_PAYLOAD = { hit: true, score: 0.91, label: "match" }

function toolResultMessage(
  structuredContent?: Record<string, unknown>,
  opts: { withText?: boolean } = { withText: true }
): ConversationMessage {
  const tr: CanonicalToolResult = {
    toolCallId: "call-1",
    providerCallId: "prov-call-1",
    toolName: "lookup",
    content: opts.withText ? textBlocks("primary tool output") : [],
    isError: false,
    origin: { kind: "mcp_remote", serverKey: "github" },
  }
  if (structuredContent) tr.structuredContent = structuredContent
  return { role: "tool_result", results: [tr] }
}

function toolOutput(messages: Awaited<ReturnType<typeof toModelMessages>>) {
  const last = messages[messages.length - 1]
  assert.equal(last.role, "tool")
  const part = (last.content as any[])[0]
  assert.equal(part.type, "tool-result")
  return part.output as { type: string; value: unknown }
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

test("tool result with text + structuredContent → text output carrying the structured suffix", async () => {
  const messages = await toModelMessages([toolResultMessage(STRUCT_PAYLOAD)])
  const output = toolOutput(messages)
  assert.equal(output.type, "text")
  assert.match(String(output.value), /primary tool output/)
  assert.match(String(output.value), /<structured_content>/)
  assert.match(String(output.value), /"score": 0\.91/)
})

test("tool result without structuredContent → no structured_content marker", async () => {
  const messages = await toModelMessages([toolResultMessage()])
  const output = toolOutput(messages)
  assert.equal(output.type, "text")
  assert.doesNotMatch(String(output.value), /<structured_content>/)
})

test("tool result with ONLY structuredContent (no text) → json output", async () => {
  const messages = await toModelMessages([
    toolResultMessage(STRUCT_PAYLOAD, { withText: false }),
  ])
  const output = toolOutput(messages)
  assert.equal(output.type, "json")
  assert.deepEqual(output.value, STRUCT_PAYLOAD)
})

test("error tool result → error-text output", async () => {
  const tr: CanonicalToolResult = {
    toolCallId: "call-err",
    toolName: "lookup",
    content: textBlocks("boom"),
    isError: true,
  }
  const messages = await toModelMessages([
    { role: "tool_result", results: [tr] },
  ])
  const output = toolOutput(messages)
  assert.equal(output.type, "error-text")
  assert.match(String(output.value), /boom/)
})
