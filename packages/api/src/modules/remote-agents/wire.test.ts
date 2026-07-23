import assert from "node:assert/strict"
import test from "node:test"
import {
  parseRemoteAgentMachineMessage,
  serializeRemoteAgentApiToDaemonMessage,
} from "./wire.js"

test("parseRemoteAgentMachineMessage maps snake_case ready catalog to internal camelCase", () => {
  const message = parseRemoteAgentMachineMessage(
    JSON.stringify({
      type: "ready",
      runtime_catalog: [
        {
          runtime_kind: "codex",
          executable_path: "/usr/bin/codex",
          status: "available",
          version: "1.2.3",
          metadata: { source: "probe" },
          last_error: "old error",
        },
      ],
    })
  )

  assert.deepEqual(message, {
    type: "ready",
    runtimeCatalog: [
      {
        runtimeKind: "codex",
        executablePath: "/usr/bin/codex",
        status: "available",
        version: "1.2.3",
        metadata: { source: "probe" },
        lastError: "old error",
      },
    ],
    traceparent: undefined,
    tracestate: undefined,
  })
})

test("parseRemoteAgentMachineMessage carries the daemon-stamped envelope trace fields", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const TS = "es=s:1.0"
  const message = parseRemoteAgentMachineMessage(
    JSON.stringify({
      type: "ready",
      runtime_catalog: [],
      traceparent: TP,
      tracestate: TS,
    })
  )
  assert.deepEqual(message, {
    type: "ready",
    runtimeCatalog: [],
    traceparent: TP,
    tracestate: TS,
  })

  // Degrade-not-reject (device-protocol wire fragment): malformed fields drop
  // to absent, the machine frame still parses.
  const degraded = parseRemoteAgentMachineMessage(
    JSON.stringify({
      type: "ready",
      runtime_catalog: [],
      traceparent: "garbage",
      tracestate: "x".repeat(2000),
    })
  )
  assert.deepEqual(degraded, {
    type: "ready",
    runtimeCatalog: [],
    traceparent: undefined,
    tracestate: undefined,
  })
})

test("parseRemoteAgentMachineMessage maps snake_case status capabilities", () => {
  const message = parseRemoteAgentMachineMessage(
    JSON.stringify({
      type: "agent:status",
      remote_agent_id: "agent-1",
      state: "running",
      status_text: "Running",
      conversation_id: "conversation-1",
      task_id: "task-1",
      session_id: "session-1",
      last_error: "",
      run_key: "run-1",
      capabilities: {
        supports_request_user_input: true,
        supports_plan_mode: true,
        supports_persistent_session: false,
        supports_codex_app_server: true,
        supports_structured_io: false,
      },
    })
  )

  assert.deepEqual(message, {
    type: "agent:status",
    remoteAgentId: "agent-1",
    state: "running",
    statusText: "Running",
    conversationId: "conversation-1",
    taskId: "task-1",
    sessionId: "session-1",
    lastError: "",
    runKey: "run-1",
    capabilities: {
      supportsRequestUserInput: true,
      supportsPlanMode: true,
      supportsPersistentSession: false,
      supportsCodexAppServer: true,
      supportsStructuredIo: false,
    },
    traceparent: undefined,
    tracestate: undefined,
  })
})

test("parseRemoteAgentMachineMessage rejects legacy camelCase machine messages", () => {
  const message = parseRemoteAgentMachineMessage(
    JSON.stringify({
      type: "agent:session",
      remoteAgentId: "agent-1",
      conversationId: "conversation-1",
      sessionId: "session-1",
    })
  )

  assert.equal(message, null)
})

test("parseRemoteAgentMachineMessage ignores invalid JSON", () => {
  assert.equal(parseRemoteAgentMachineMessage("{not-json"), null)
})

test("serializeRemoteAgentApiToDaemonMessage emits snake_case start frames", () => {
  const serialized = serializeRemoteAgentApiToDaemonMessage({
    type: "agent:start",
    remoteAgentId: "agent-1",
    conversationId: "conversation-1",
    runtimeKind: "codex",
    runtimePath: "/usr/bin/codex",
    localRootPath: "/repo",
    sessionId: "session-1",
    fencingToken: "fence-1",
    serverUrl: "https://synapse.example.com",
  })

  assert.deepEqual(JSON.parse(serialized), {
    type: "agent:start",
    remote_agent_id: "agent-1",
    conversation_id: "conversation-1",
    runtime_kind: "codex",
    runtime_path: "/usr/bin/codex",
    local_root_path: "/repo",
    session_id: "session-1",
    fencing_token: "fence-1",
    server_url: "https://synapse.example.com",
  })
})

test("serializeRemoteAgentApiToDaemonMessage emits snake_case connected frame", () => {
  const serialized = serializeRemoteAgentApiToDaemonMessage({
    type: "connected",
    machineId: "machine-1",
    sessionId: "session-1",
    fencingToken: "fence-1",
  })

  assert.deepEqual(JSON.parse(serialized), {
    type: "connected",
    machine_id: "machine-1",
    session_id: "session-1",
    fencing_token: "fence-1",
  })
})

test("serializeRemoteAgentApiToDaemonMessage emits snake_case deliveries", () => {
  const serialized = serializeRemoteAgentApiToDaemonMessage({
    type: "agent:deliver",
    deliveries: [
      {
        remoteAgentId: "agent-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        itemId: "item-1",
      },
    ],
  })

  assert.deepEqual(JSON.parse(serialized), {
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
})

test("serializeRemoteAgentApiToDaemonMessage emits a snake_case deliveries-completed frame", () => {
  // The serializer re-parses through the strict gated schema, so a well-formed
  // frame (delivery_ids non-empty, gated trace fields) round-trips.
  const serialized = serializeRemoteAgentApiToDaemonMessage({
    type: "agent:deliveries:completed",
    remoteAgentId: "agent-1",
    conversationId: "conversation-1",
    deliveryIds: ["delivery-1", "delivery-2"],
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    tracestate: "othervendor=xyz",
  })

  assert.deepEqual(JSON.parse(serialized), {
    type: "agent:deliveries:completed",
    remote_agent_id: "agent-1",
    conversation_id: "conversation-1",
    delivery_ids: ["delivery-1", "delivery-2"],
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    tracestate: "othervendor=xyz",
  })
})

test("serializeRemoteAgentApiToDaemonMessage emits snake_case resolved task frames", () => {
  const serialized = serializeRemoteAgentApiToDaemonMessage({
    type: "agent:task:resolved",
    remoteAgentId: "agent-1",
    taskId: "task-1",
    task: {
      id: "task-1",
      lifecycleStatus: "completed",
    },
  })

  assert.deepEqual(JSON.parse(serialized), {
    type: "agent:task:resolved",
    remote_agent_id: "agent-1",
    task_id: "task-1",
    task: {
      id: "task-1",
      lifecycleStatus: "completed",
    },
  })
})

test("serializeRemoteAgentApiToDaemonMessage carries the trace carrier pair on live frames", () => {
  const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
  const TS = "es=s:1.0"

  assert.deepEqual(
    JSON.parse(
      serializeRemoteAgentApiToDaemonMessage({
        type: "agent:start",
        remoteAgentId: "agent-1",
        runtimeKind: "codex",
        traceparent: TP,
        tracestate: TS,
      })
    ),
    {
      type: "agent:start",
      remote_agent_id: "agent-1",
      runtime_kind: "codex",
      traceparent: TP,
      tracestate: TS,
    }
  )

  assert.deepEqual(
    JSON.parse(
      serializeRemoteAgentApiToDaemonMessage({
        type: "agent:deliver",
        deliveries: [
          {
            remoteAgentId: "agent-1",
            deliveryId: "delivery-1",
            conversationId: "conversation-1",
            itemId: "item-1",
            traceparent: TP,
            tracestate: TS,
          },
        ],
      })
    ),
    {
      type: "agent:deliver",
      deliveries: [
        {
          remote_agent_id: "agent-1",
          delivery_id: "delivery-1",
          conversation_id: "conversation-1",
          item_id: "item-1",
          traceparent: TP,
          tracestate: TS,
        },
      ],
    }
  )

  assert.deepEqual(
    JSON.parse(
      serializeRemoteAgentApiToDaemonMessage({
        type: "agent:task:resolved",
        remoteAgentId: "agent-1",
        taskId: "task-1",
        task: {},
        traceparent: TP,
        tracestate: TS,
      })
    ),
    {
      type: "agent:task:resolved",
      remote_agent_id: "agent-1",
      task_id: "task-1",
      task: {},
      traceparent: TP,
      tracestate: TS,
    }
  )
})
