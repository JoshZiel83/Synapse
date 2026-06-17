import assert from "node:assert/strict"
import { test } from "node:test"
import {
  RemoteAgentFailDeliveriesResponseSchema,
  RemoteAgentTaskCreateResponseSchema,
  requestJson,
} from "./api-client.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  })
}

test("requestJson validates task-create responses and attaches machine auth", async () => {
  let observedUrl = ""
  let observedAuth = ""
  let observedContentType = ""
  const fetchImpl: typeof fetch = (async (input, init) => {
    observedUrl = String(input)
    const headers = new Headers(init?.headers)
    observedAuth = headers.get("authorization") ?? ""
    observedContentType = headers.get("content-type") ?? ""
    return jsonResponse({ task: { id: "task-1" } })
  }) as typeof fetch

  const result = await requestJson(
    "https://api.example.test/base",
    "machine-key",
    "/api/v1/internal/remote-agents/agent-1/tasks/user-input",
    {
      method: "POST",
      body: JSON.stringify({ conversation_id: "conversation-1" }),
    },
    RemoteAgentTaskCreateResponseSchema,
    fetchImpl
  )

  assert.equal(
    observedUrl,
    "https://api.example.test/api/v1/internal/remote-agents/agent-1/tasks/user-input"
  )
  assert.equal(observedAuth, "Bearer machine-key")
  assert.equal(observedContentType, "application/json")
  assert.deepEqual(result, { task: { id: "task-1" } })
})

test("requestJson validates fail-deliveries responses", async () => {
  const fetchImpl: typeof fetch = (async () =>
    jsonResponse({ rescheduled: 2 })) as typeof fetch

  const result = await requestJson(
    "https://api.example.test",
    "machine-key",
    "/fail-deliveries",
    { method: "POST", body: "{}" },
    RemoteAgentFailDeliveriesResponseSchema,
    fetchImpl
  )

  assert.deepEqual(result, { rescheduled: 2 })
})

test("requestJson rejects malformed or drifted response payloads", async () => {
  await assert.rejects(
    requestJson(
      "https://api.example.test",
      "machine-key",
      "/tasks/user-input",
      { method: "POST", body: "{}" },
      RemoteAgentTaskCreateResponseSchema,
      (async () => new Response("{")) as typeof fetch
    ),
    /Remote-agent response returned malformed JSON/
  )

  await assert.rejects(
    requestJson(
      "https://api.example.test",
      "machine-key",
      "/tasks/user-input",
      { method: "POST", body: "{}" },
      RemoteAgentTaskCreateResponseSchema,
      (async () => jsonResponse({ task: { id: "" } })) as typeof fetch
    ),
    /Remote-agent response shape invalid/
  )
})

test("requestJson includes HTTP error response text", async () => {
  await assert.rejects(
    requestJson(
      "https://api.example.test",
      "machine-key",
      "/tasks/user-input",
      { method: "POST", body: "{}" },
      RemoteAgentTaskCreateResponseSchema,
      (async () =>
        new Response("denied", {
          status: 403,
          statusText: "Forbidden",
        })) as typeof fetch
    ),
    /Remote-agent request failed \(403 Forbidden\): denied/
  )
})
