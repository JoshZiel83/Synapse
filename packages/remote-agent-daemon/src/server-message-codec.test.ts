import assert from "node:assert/strict"
import { test } from "node:test"
import { parseServerMessage } from "./server-message-codec.js"

test("parseServerMessage maps connected and start frames from snake_case wire", () => {
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({
        type: "connected",
        machine_id: "machine-1",
        session_id: "session-1",
        fencing_token: "fence-1",
      })
    ),
    {
      type: "connected",
      machineId: "machine-1",
      sessionId: "session-1",
      fencingToken: "fence-1",
    }
  )

  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({
        type: "agent:start",
        remote_agent_id: "agent-1",
        conversation_id: "conversation-1",
        runtime_kind: "codex",
        runtime_path: null,
        local_root_path: "/workspace",
        session_id: null,
        fencing_token: "fence-1",
        server_url: "https://api.example.test",
      })
    ),
    {
      type: "agent:start",
      remoteAgentId: "agent-1",
      conversationId: "conversation-1",
      runtimeKind: "codex",
      runtimePath: undefined,
      localRootPath: "/workspace",
      sessionId: null,
      fencingToken: "fence-1",
      serverUrl: "https://api.example.test",
    }
  )
})

test("parseServerMessage validates delivery and task-resolved frames", () => {
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({
        type: "agent:deliver",
        deliveries: [
          {
            remote_agent_id: "agent-1",
            delivery_id: "delivery-1",
            conversation_id: "conversation-1",
            item_id: "item-1",
          },
        ],
      })
    ),
    {
      type: "agent:deliver",
      deliveries: [
        {
          remoteAgentId: "agent-1",
          deliveryId: "delivery-1",
          conversationId: "conversation-1",
          itemId: "item-1",
        },
      ],
    }
  )

  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({
        type: "agent:task:resolved",
        remote_agent_id: "agent-1",
        task_id: "task-1",
        task: { status: "resolved" },
      })
    ),
    {
      type: "agent:task:resolved",
      remoteAgentId: "agent-1",
      taskId: "task-1",
      task: { status: "resolved" },
    }
  )
})

test("parseServerMessage rejects malformed, camelCase, and drifted frames", () => {
  assert.equal(parseServerMessage("{"), null)
  assert.equal(parseServerMessage("null"), null)
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:start",
        remoteAgentId: "agent-1",
        runtimeKind: "codex",
      })
    ),
    null
  )
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:start",
        remote_agent_id: "agent-1",
        runtime_kind: "unknown",
      })
    ),
    null
  )
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:deliver",
        deliveries: [
          {
            remote_agent_id: "agent-1",
            delivery_id: "delivery-1",
            conversation_id: "conversation-1",
          },
        ],
      })
    ),
    null
  )
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:task:resolved",
        remote_agent_id: "agent-1",
        task_id: "task-1",
        task: [],
      })
    ),
    null
  )
})
