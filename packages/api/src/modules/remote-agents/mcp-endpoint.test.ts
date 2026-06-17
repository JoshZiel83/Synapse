import assert from "node:assert/strict"
import { test } from "node:test"

import {
  __buildImToolsForTest,
  readMcpToolContentBlocks,
} from "./mcp-endpoint.js"

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

test("readMcpToolContentBlocks accepts only object content arrays", () => {
  const textContent = [{ type: "text", text: "ok" }]
  assert.equal(readMcpToolContentBlocks(undefined), null)
  assert.equal(readMcpToolContentBlocks({ type: "text", text: "bad" }), null)
  assert.equal(readMcpToolContentBlocks(["bad"]), null)
  assert.equal(readMcpToolContentBlocks([null]), null)
  assert.deepEqual(readMcpToolContentBlocks(textContent), textContent)
})
