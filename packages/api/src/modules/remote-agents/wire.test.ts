import assert from "node:assert/strict"
import test from "node:test"
import { parseRemoteAgentMachineMessage } from "./wire.js"

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
