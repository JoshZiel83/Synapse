import test from "node:test"
import assert from "node:assert/strict"

import {
  normalizeMcpTask,
  projectMcpStatusToLifecycle,
  isMcpTaskTerminal,
  type McpTaskClient,
  type NormalizedMcpTask,
} from "./external-mcp-task-adapter.js"

test("normalizeMcpTask: RC shape uses ttlMs/pollIntervalMs", () => {
  const t = normalizeMcpTask(
    {
      taskId: "abc",
      status: "working",
      statusMessage: "go",
      ttlMs: 60000,
      pollIntervalMs: 5000,
    },
    "2026-07-28"
  )
  assert.equal(t.taskId, "abc")
  assert.equal(t.status, "working")
  assert.equal(t.ttlMs, 60000)
  assert.equal(t.pollIntervalMs, 5000)
})

test("normalizeMcpTask: 2025-11-25 shape uses ttl/pollInterval (and null ttl)", () => {
  const t = normalizeMcpTask(
    { taskId: "x", status: "completed", ttl: null, pollInterval: 3000 },
    "2025-11-25"
  )
  assert.equal(t.ttlMs, null)
  assert.equal(t.pollIntervalMs, 3000)
})

test("projectMcpStatusToLifecycle: working/input_required/cancelled pass through", () => {
  assert.deepEqual(projectMcpStatusToLifecycle("working"), {
    lifecycleStatus: "working",
    outcome: null,
  })
  assert.deepEqual(projectMcpStatusToLifecycle("input_required"), {
    lifecycleStatus: "input_required",
    outcome: null,
  })
  assert.deepEqual(projectMcpStatusToLifecycle("cancelled"), {
    lifecycleStatus: "cancelled",
    outcome: null,
  })
})

test("projectMcpStatusToLifecycle: failed → completed/tool_error (tool isError, concluded)", () => {
  assert.deepEqual(projectMcpStatusToLifecycle("failed"), {
    lifecycleStatus: "completed",
    outcome: "tool_error",
  })
  // explicit tool-error (not protocol) → still completed/tool_error
  assert.deepEqual(
    projectMcpStatusToLifecycle("failed", { isJsonRpcError: false }),
    { lifecycleStatus: "completed", outcome: "tool_error" }
  )
})

test("projectMcpStatusToLifecycle: failed + JSON-RPC error → failed (machinery breakdown)", () => {
  assert.deepEqual(
    projectMcpStatusToLifecycle("failed", { isJsonRpcError: true }),
    { lifecycleStatus: "failed", outcome: null }
  )
})

test("projectMcpStatusToLifecycle: completed maps ok vs tool_error by result isError", () => {
  assert.deepEqual(projectMcpStatusToLifecycle("completed", false), {
    lifecycleStatus: "completed",
    outcome: "ok",
  })
  assert.deepEqual(projectMcpStatusToLifecycle("completed", true), {
    lifecycleStatus: "completed",
    outcome: "tool_error",
  })
})

test("isMcpTaskTerminal: terminals are completed/failed/cancelled", () => {
  assert.equal(isMcpTaskTerminal("completed"), true)
  assert.equal(isMcpTaskTerminal("failed"), true)
  assert.equal(isMcpTaskTerminal("cancelled"), true)
  assert.equal(isMcpTaskTerminal("working"), false)
  assert.equal(isMcpTaskTerminal("input_required"), false)
})

test("McpTaskClient contract: a fake poll-to-terminal drive shape", async () => {
  // Documents how the executor would poll the adapter to terminal. A real
  // client wraps @modelcontextprotocol/sdk; here a fake proves the contract.
  const states: NormalizedMcpTask[] = [
    { taskId: "t1", status: "working", ttlMs: 60000 },
    { taskId: "t1", status: "completed", ttlMs: 60000 },
  ]
  let i = 0
  const client: McpTaskClient = {
    wireVersion: "2026-07-28",
    async getTask() {
      return states[Math.min(i++, states.length - 1)]
    },
    async getResult() {
      return { content: "done", isError: false }
    },
    async cancel() {},
  }

  let task = await client.getTask("t1")
  assert.equal(task.status, "working")
  task = await client.getTask("t1")
  assert.equal(isMcpTaskTerminal(task.status), true)
  const projected = projectMcpStatusToLifecycle(task.status, false)
  assert.equal(projected.lifecycleStatus, "completed")
  assert.equal(projected.outcome, "ok")
  const result = await client.getResult("t1")
  assert.equal(result.isError, false)
})
