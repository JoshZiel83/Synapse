// Wire trace-context fields (§4.D change 4): the zod-only fragment duplicate,
// the RuntimeTask* dispatch-echo fields, the four daemon→api machine-message
// envelopes, the api→daemon tracestate pairs, and origin_carriers — all under
// the degrade-not-reject receiver rule (a malformed trace field becomes
// ABSENT; the business frame/body is never rejected).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import {
  RemoteAgentApiDeliveryWireSchema,
  RemoteAgentApiStartMessageSchema,
  RemoteAgentApiTaskResolvedMessageSchema,
  RemoteAgentMachineHeartbeatMessageSchema,
  RemoteAgentMachineReadyMessageSchema,
  RemoteAgentRuntimeCatalogMessageSchema,
  RemoteAgentSessionMessageSchema,
  RemoteAgentStatusMessageSchema,
  RemoteAgentUserInputTaskBodySchema,
  RemoteAgentPlanApprovalTaskBodySchema,
  RuntimeTaskRefParamsSchema,
  RuntimeTaskResultParamsSchema,
} from "./schemas.js"

const OPERATION_ID = "00000000-0000-4000-8000-000000000033"
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000034"
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000035"
const VALID_TRACEPARENT =
  "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
const VALID_TRACESTATE = "vendor=abc"

test("RuntimeTaskRefParamsSchema: echoes the dispatch trace context", () => {
  const parsed = RuntimeTaskRefParamsSchema.parse({
    operation_id: OPERATION_ID,
    attempt_id: ATTEMPT_ID,
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(parsed.traceparent, VALID_TRACEPARENT)
  assert.equal(parsed.tracestate, VALID_TRACESTATE)
})

test("RuntimeTaskResultParamsSchema (via .extend): malformed trace fields degrade, frame still parses", () => {
  const parsed = RuntimeTaskResultParamsSchema.parse({
    operation_id: OPERATION_ID,
    ok: true,
    traceparent: "not-a-traceparent",
    tracestate: "x".repeat(1025),
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.traceparent, undefined)
  assert.equal(parsed.tracestate, undefined)

  // A hostile numeric / object value degrades the same way (never a reject —
  // rejecting device.task.result would strand a terminal task).
  const hostile = RuntimeTaskResultParamsSchema.parse({
    operation_id: OPERATION_ID,
    ok: false,
    traceparent: 5000,
  })
  assert.equal(hostile.ok, false)
  assert.equal(hostile.traceparent, undefined)
})

test("the four daemon→api machine messages carry the fragment inside strictObject", () => {
  const ready = RemoteAgentMachineReadyMessageSchema.parse({
    type: "ready",
    runtime_catalog: [],
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(ready.traceparent, VALID_TRACEPARENT)
  assert.equal(ready.tracestate, VALID_TRACESTATE)

  const catalog = RemoteAgentRuntimeCatalogMessageSchema.parse({
    type: "runtime:catalog",
    runtime_catalog: [],
    traceparent: VALID_TRACEPARENT,
  })
  assert.equal(catalog.traceparent, VALID_TRACEPARENT)

  const session = RemoteAgentSessionMessageSchema.parse({
    type: "agent:session",
    remote_agent_id: "ra-1",
    conversation_id: CONVERSATION_ID,
    traceparent: VALID_TRACEPARENT,
  })
  assert.equal(session.traceparent, VALID_TRACEPARENT)

  const status = RemoteAgentStatusMessageSchema.parse({
    type: "agent:status",
    remote_agent_id: "ra-1",
    state: "idle",
    traceparent: VALID_TRACEPARENT,
  })
  assert.equal(status.traceparent, VALID_TRACEPARENT)
})

test("strictObject + .catch(undefined): malformed trace field is DROPPED from output, frame not rejected", () => {
  const parsed = RemoteAgentStatusMessageSchema.parse({
    type: "agent:status",
    remote_agent_id: "ra-1",
    state: "idle",
    traceparent: "garbage",
  })
  assert.equal(parsed.traceparent, undefined)

  // strictObject still rejects genuinely unknown keys — the fragment did not
  // loosen the envelope.
  assert.throws(() =>
    RemoteAgentStatusMessageSchema.parse({
      type: "agent:status",
      remote_agent_id: "ra-1",
      state: "idle",
      unknown_key: 1,
    })
  )
})

test("heartbeat deliberately carries NO trace fields", () => {
  assert.throws(() =>
    RemoteAgentMachineHeartbeatMessageSchema.parse({
      type: "heartbeat",
      traceparent: VALID_TRACEPARENT,
    })
  )
})

test("api→daemon messages pair tracestate with every traceparent (adjudication 17)", () => {
  const start = RemoteAgentApiStartMessageSchema.parse({
    type: "agent:start",
    remote_agent_id: "ra-1",
    runtime_kind: "claude_code",
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(start.tracestate, VALID_TRACESTATE)

  const delivery = RemoteAgentApiDeliveryWireSchema.parse({
    remote_agent_id: "ra-1",
    delivery_id: "d-1",
    conversation_id: CONVERSATION_ID,
    item_id: "i-1",
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(delivery.tracestate, VALID_TRACESTATE)

  const resolved = RemoteAgentApiTaskResolvedMessageSchema.parse({
    type: "agent:task:resolved",
    remote_agent_id: "ra-1",
    task_id: "t-1",
    task: {},
    traceparent: VALID_TRACEPARENT,
    tracestate: VALID_TRACESTATE,
  })
  assert.equal(resolved.tracestate, VALID_TRACESTATE)
})

// The SAME cross-language golden vectors the shared/Go/Rust tests read (test-
// only, monorepo-relative). The local zod-only gate is not exported, so it is
// driven through the wire fragment (`RemoteAgentMachineReadyMessageSchema` spreads
// `...wireTraceContextFields`): a surviving field ⇔ the gate accepted.
type CarrierVectors = {
  traceparent: Array<{ v: string; accept: boolean; note: string }>
  tracestate: Array<{
    v: string
    gate: boolean
    capOnly: boolean
    note: string
  }>
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../shared/src/utils/traceparent-vectors.json", import.meta.url),
    "utf8"
  )
) as CarrierVectors

test("golden vectors: the device-protocol carrier gate matches the canonical gate", () => {
  for (const { v, accept, note } of vectors.traceparent) {
    const parsed = RemoteAgentMachineReadyMessageSchema.parse({
      type: "ready",
      runtime_catalog: [],
      traceparent: v,
    })
    assert.equal(
      parsed.traceparent !== undefined,
      accept,
      `traceparent ${note}: ${JSON.stringify(v)}`
    )
  }
  for (const { v, gate, note } of vectors.tracestate) {
    const parsed = RemoteAgentMachineReadyMessageSchema.parse({
      type: "ready",
      runtime_catalog: [],
      traceparent: VALID_TRACEPARENT,
      tracestate: v,
    })
    assert.equal(
      parsed.tracestate !== undefined,
      gate,
      `tracestate ${note}: ${JSON.stringify(v)}`
    )
  }
})

test("api→daemon start/delivery schemas now GATE a malformed tracestate to absent, traceparent survives", () => {
  for (const bad of ["ok=1,ok=2", "Foo=bar", "a=b=c"]) {
    const start = RemoteAgentApiStartMessageSchema.parse({
      type: "agent:start",
      remote_agent_id: "ra-1",
      runtime_kind: "claude_code",
      traceparent: VALID_TRACEPARENT,
      tracestate: bad,
    })
    assert.equal(start.traceparent, VALID_TRACEPARENT, bad)
    assert.equal(start.tracestate, undefined, bad)

    const delivery = RemoteAgentApiDeliveryWireSchema.parse({
      remote_agent_id: "ra-1",
      delivery_id: "d-1",
      conversation_id: CONVERSATION_ID,
      item_id: "i-1",
      traceparent: VALID_TRACEPARENT,
      tracestate: bad,
    })
    assert.equal(delivery.tracestate, undefined, bad)
  }
})

const userInputBase = {
  conversation_id: CONVERSATION_ID,
  run_key: "run-1",
  title: "Need input",
  questions: [{ q: "?" }],
}

test("origin_carriers: valid carriers (≤20) pass; per-entry salvage keeps valid siblings; the task body never rejects", () => {
  const ok = RemoteAgentUserInputTaskBodySchema.parse({
    ...userInputBase,
    origin_carriers: [
      { traceparent: VALID_TRACEPARENT, tracestate: VALID_TRACESTATE },
      { traceparent: VALID_TRACEPARENT },
    ],
  })
  assert.equal(ok.origin_carriers?.length, 2)

  // Per-entry salvage: a malformed entry is dropped, the valid sibling
  // survives (entries are independent carriers — not the tracestate
  // partial-salvage corruption vector).
  const badEntry = RemoteAgentUserInputTaskBodySchema.parse({
    ...userInputBase,
    origin_carriers: [
      { traceparent: "garbage" },
      { traceparent: VALID_TRACEPARENT },
    ],
  })
  assert.equal(badEntry.origin_carriers?.length, 1)
  assert.equal(badEntry.origin_carriers?.[0]?.traceparent, VALID_TRACEPARENT)
  assert.equal(badEntry.title, "Need input")

  // ALL entries malformed ⇒ nothing to salvage ⇒ absent.
  const allBad = RemoteAgentUserInputTaskBodySchema.parse({
    ...userInputBase,
    origin_carriers: [{ traceparent: "garbage" }],
  })
  assert.equal(allBad.origin_carriers, undefined)

  // 21 entries ⇒ over the cap ⇒ whole-field drop, body still parses.
  const overCap = RemoteAgentUserInputTaskBodySchema.parse({
    ...userInputBase,
    origin_carriers: Array.from({ length: 21 }, () => ({
      traceparent: VALID_TRACEPARENT,
    })),
  })
  assert.equal(overCap.origin_carriers, undefined)

  // Non-array ⇒ absent, never a rejection.
  const nonArray = RemoteAgentUserInputTaskBodySchema.parse({
    ...userInputBase,
    origin_carriers: "not-a-list",
  })
  assert.equal(nonArray.origin_carriers, undefined)

  const plan = RemoteAgentPlanApprovalTaskBodySchema.parse({
    conversation_id: CONVERSATION_ID,
    run_key: "run-2",
    title: "Approve plan",
    plan_markdown: "# plan",
    origin_carriers: [{ traceparent: VALID_TRACEPARENT }],
  })
  assert.equal(plan.origin_carriers?.length, 1)
})
