import assert from "node:assert/strict"
import test from "node:test"
import {
  RemoteAgentDaemonToApiWsMessageSchema,
  RemoteAgentMachineReadyMessageSchema,
  RemoteAgentStatusMessageSchema,
} from "./schemas.js"

test("RemoteAgentMachineReadyMessageSchema accepts snake_case runtime catalog", () => {
  const parsed = RemoteAgentMachineReadyMessageSchema.parse({
    type: "ready",
    runtime_catalog: [
      {
        runtime_kind: "claude_code",
        executable_path: "/usr/bin/claude",
        status: "available",
        version: "1.0.0",
        metadata: { arch: "arm64" },
        last_error: "previous probe failed",
      },
    ],
  })

  assert.equal(parsed.runtime_catalog[0]?.runtime_kind, "claude_code")
})

test("RemoteAgentMachineReadyMessageSchema rejects camelCase machine fields", () => {
  assert.throws(() =>
    RemoteAgentMachineReadyMessageSchema.parse({
      type: "ready",
      runtimeCatalog: [
        {
          runtimeKind: "claude_code",
          executablePath: "/usr/bin/claude",
          status: "available",
        },
      ],
    })
  )
})

test("RemoteAgentStatusMessageSchema accepts snake_case lifecycle status", () => {
  const parsed = RemoteAgentStatusMessageSchema.parse({
    type: "agent:status",
    remote_agent_id: "agent-1",
    state: "waiting_user_input",
    status_text: "Waiting",
    conversation_id: "conversation-1",
    task_id: "task-1",
    session_id: "session-1",
    last_error: "",
    run_key: "run-1",
    capabilities: {
      supports_request_user_input: true,
      supports_plan_mode: true,
      supports_persistent_session: true,
      supports_codex_app_server: false,
      supports_structured_io: true,
    },
  })

  assert.equal(parsed.status_text, "Waiting")
  assert.equal(parsed.capabilities?.supports_structured_io, true)
})

test("RemoteAgentDaemonToApiWsMessageSchema dispatches heartbeat", () => {
  const parsed = RemoteAgentDaemonToApiWsMessageSchema.parse({
    type: "heartbeat",
  })

  assert.equal(parsed.type, "heartbeat")
})
