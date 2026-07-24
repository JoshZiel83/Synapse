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
      traceparent: undefined,
      tracestate: undefined,
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
            turn_epoch: "epoch-1",
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
          turnEpoch: "epoch-1",
          traceparent: undefined,
          tracestate: undefined,
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
      traceparent: undefined,
      tracestate: undefined,
    }
  )
})

test("parseServerMessage carries W3C traceparent through start/deliver/task frames", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

  const start = parseServerMessage(
    JSON.stringify({
      type: "agent:start",
      remote_agent_id: "agent-1",
      runtime_kind: "codex",
      traceparent: TP,
    })
  )
  assert.equal(start?.type === "agent:start" ? start.traceparent : null, TP)

  const deliver = parseServerMessage(
    JSON.stringify({
      type: "agent:deliver",
      deliveries: [
        {
          remote_agent_id: "agent-1",
          delivery_id: "delivery-1",
          conversation_id: "conversation-1",
          item_id: "item-1",
          turn_epoch: "epoch-1",
          traceparent: TP,
        },
      ],
    })
  )
  assert.equal(
    deliver?.type === "agent:deliver"
      ? deliver.deliveries[0].traceparent
      : null,
    TP
  )

  const resolved = parseServerMessage(
    JSON.stringify({
      type: "agent:task:resolved",
      remote_agent_id: "agent-1",
      task_id: "task-1",
      task: { status: "resolved" },
      traceparent: TP,
    })
  )
  assert.equal(
    resolved?.type === "agent:task:resolved" ? resolved.traceparent : null,
    TP
  )
})

test("parseServerMessage carries tracestate next to traceparent", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const TS = "es=s:1.0,congo=t61rcWkgMzE"

  const deliver = parseServerMessage(
    JSON.stringify({
      type: "agent:deliver",
      deliveries: [
        {
          remote_agent_id: "agent-1",
          delivery_id: "delivery-1",
          conversation_id: "conversation-1",
          item_id: "item-1",
          turn_epoch: "epoch-1",
          traceparent: TP,
          tracestate: TS,
        },
      ],
    })
  )
  assert.equal(
    deliver?.type === "agent:deliver" ? deliver.deliveries[0].tracestate : null,
    TS
  )

  const resolved = parseServerMessage(
    JSON.stringify({
      type: "agent:task:resolved",
      remote_agent_id: "agent-1",
      task_id: "task-1",
      task: {},
      traceparent: TP,
      tracestate: TS,
    })
  )
  assert.equal(
    resolved?.type === "agent:task:resolved" ? resolved.tracestate : null,
    TS
  )
})

test("parseServerMessage degrades malformed/oversized trace fields without dropping the frame", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"

  // Malformed traceparent (and the old accepts-empty-string weakness): the
  // FIELD degrades to undefined; the business frame still parses.
  for (const bad of [
    "not-a-traceparent",
    "",
    "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", // wrong version
    `00-${"0".repeat(32)}-b7ad6b7169203331-01`, // all-zero trace id
    `00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`, // all-zero span id
  ]) {
    const start = parseServerMessage(
      JSON.stringify({
        type: "agent:start",
        remote_agent_id: "agent-1",
        runtime_kind: "codex",
        traceparent: bad,
      })
    )
    assert.equal(start?.type, "agent:start", `frame parses for ${bad}`)
    assert.equal(
      start?.type === "agent:start" ? start.traceparent : "unset",
      undefined
    )
  }

  // Over-512 / duplicate-key / grammar-invalid tracestate degrades the FIELD;
  // the valid traceparent survives and the frame is never dropped.
  for (const badTracestate of [
    `v=${"x".repeat(512)}`, // 514 chars, over the 512 cap
    "ok=1,ok=2", // duplicate key (Level 2 MUST)
    "Foo=bar", // uppercase key (grammar-invalid)
  ]) {
    const deliver = parseServerMessage(
      JSON.stringify({
        type: "agent:deliver",
        deliveries: [
          {
            remote_agent_id: "agent-1",
            delivery_id: "delivery-1",
            conversation_id: "conversation-1",
            item_id: "item-1",
            turn_epoch: "epoch-1",
            traceparent: TP,
            tracestate: badTracestate,
          },
        ],
      })
    )
    assert.equal(deliver?.type, "agent:deliver", badTracestate)
    if (deliver?.type === "agent:deliver") {
      assert.equal(deliver.deliveries[0].traceparent, TP, badTracestate)
      assert.equal(deliver.deliveries[0].tracestate, undefined, badTracestate)
    }
  }
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

test("parseServerMessage maps agent:deliveries:completed frames to camelCase", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const completed = parseServerMessage(
    JSON.stringify({
      type: "agent:deliveries:completed",
      remote_agent_id: "agent-1",
      conversation_id: "conv-1",
      delivery_ids: ["d1", "d2"],
      traceparent: TP,
    })
  )
  assert.deepEqual(completed, {
    type: "agent:deliveries:completed",
    remoteAgentId: "agent-1",
    conversationId: "conv-1",
    deliveryIds: ["d1", "d2"],
    traceparent: TP,
    tracestate: undefined,
  })
})

test("parseServerMessage rejects malformed agent:deliveries:completed frames but degrades a bad carrier", () => {
  // Empty delivery_ids ⇒ frame dropped.
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:deliveries:completed",
        remote_agent_id: "agent-1",
        conversation_id: "conv-1",
        delivery_ids: [],
      })
    ),
    null
  )
  // Missing conversation_id ⇒ frame dropped.
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:deliveries:completed",
        remote_agent_id: "agent-1",
        delivery_ids: ["d1"],
      })
    ),
    null
  )
  // Unknown extra key ⇒ frame dropped (strictObject).
  assert.equal(
    parseServerMessage(
      JSON.stringify({
        type: "agent:deliveries:completed",
        remote_agent_id: "agent-1",
        conversation_id: "conv-1",
        delivery_ids: ["d1"],
        extra: true,
      })
    ),
    null
  )
  // A malformed traceparent degrades the FIELD, not the frame.
  const completed = parseServerMessage(
    JSON.stringify({
      type: "agent:deliveries:completed",
      remote_agent_id: "agent-1",
      conversation_id: "conv-1",
      delivery_ids: ["d1"],
      traceparent: "not-a-traceparent",
    })
  )
  assert.equal(
    completed?.type === "agent:deliveries:completed"
      ? completed.traceparent
      : "unset",
    undefined
  )
})
