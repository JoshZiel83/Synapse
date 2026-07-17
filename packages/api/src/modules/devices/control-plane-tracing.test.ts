// runTaskFrameSpan (§4.D change 6) + the Phase-2 gate's device-task leg at the
// UNIT level: a simulated device.task.result frame carrying the dispatch's
// {traceparent, tracestate} ⇒ the SERVER span is remote-parented on it, and a
// session-wakeup row inserted inside the persist chain captures the dispatch
// trace in origin_traceparent (the live leg stays dormant until the backlogged
// device.task.* producer exists — amendment A7).
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { test } from "node:test"
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { SUBJECT_KIND, TRACEPARENT_RE } from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { insertSessionWakeupRow } from "../session/runtime.js"
import { runTaskFrameSpan } from "./control-plane-tracing.js"
import type { PersistResult } from "./control-plane-events.js"

// Real provider + in-memory exporter so the frame spans record and export;
// mirrors instrumentation.ts's register() shape (context manager + W3C
// propagator) at unit scale.
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const DISPATCH_TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`

const OPERATION_ID = "00000000-0000-4000-8000-000000000041"
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000042"

const state = {
  authenticatedRuntimeId: "00000000-0000-4000-8000-000000000001",
  authenticatedServiceId: "00000000-0000-4000-8000-000000000002",
}

function resultFrameParams(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    attempt_id: ATTEMPT_ID,
    ok: true,
    traceparent: DISPATCH_TRACEPARENT,
    tracestate: "vendor=abc",
    ...overrides,
  }
}

test("SERVER span named exactly the JSON-RPC method, remote-parented on the frame's dispatch trace", async () => {
  exporter.reset()
  let insideTraceparent: string | undefined
  const result = await runTaskFrameSpan(
    "device.task.result",
    state,
    resultFrameParams(),
    async () => {
      insideTraceparent = activeTraceparent()
      return { ok: true } satisfies PersistResult
    }
  )
  assert.deepEqual(result, { ok: true })

  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.name, "device.task.result")
  assert.equal(span.kind, SpanKind.SERVER)
  assert.equal(span.spanContext().traceId, TRACE_ID)
  assert.equal(span.parentSpanContext?.spanId, SPAN_ID)
  assert.equal(span.parentSpanContext?.isRemote, true)
  assert.equal(span.attributes["synapse.cp.method"], "device.task.result")
  assert.equal(
    span.attributes["synapse.runtime_id"],
    state.authenticatedRuntimeId
  )
  assert.equal(
    span.attributes["synapse.runtime_service_id"],
    state.authenticatedServiceId
  )
  assert.equal(span.attributes["synapse.operation_id"], OPERATION_ID)
  assert.equal(span.attributes["synapse.attempt_id"], ATTEMPT_ID)
  assert.equal(span.status.code, SpanStatusCode.UNSET)

  // The reconnection mechanism itself: the persist chain sees the dispatch
  // trace as ACTIVE, so activeTraceparent() (wakeup insert) resolves to it.
  assert.ok(insideTraceparent)
  assert.ok(insideTraceparent.includes(TRACE_ID))
})

test("malformed / absent traceparent ⇒ fresh root; the frame is still handled (degrade path)", async () => {
  exporter.reset()
  const result = await runTaskFrameSpan(
    "device.task.received",
    state,
    resultFrameParams({ traceparent: "z".repeat(5120), tracestate: undefined }),
    async () => ({ ok: true }) satisfies Promise<PersistResult> | PersistResult
  )
  assert.deepEqual(result, { ok: true })
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.parentSpanContext, undefined)
  assert.notEqual(span.spanContext().traceId, TRACE_ID)
})

test("PersistResult ok:false ⇒ ERROR status, result still returned; span always ends", async () => {
  exporter.reset()
  const result = await runTaskFrameSpan(
    "device.task.result",
    state,
    resultFrameParams(),
    async () => ({ ok: false, code: -32004, message: "operation not found" })
  )
  assert.equal(result.ok, false)
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.status.message, "operation not found")
})

test("a throw is recorded + rethrown; the span still ends (finally)", async () => {
  exporter.reset()
  await assert.rejects(
    runTaskFrameSpan("device.task.status", state, resultFrameParams(), () => {
      throw new Error("db down")
    }),
    /db down/
  )
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(
    span.events.some((e) => e.name === "exception"),
    true
  )
})

test("poisoned ambient context: no envelope trace ⇒ fresh root (never the poison's child); the stamped traceparent is minted, not echoed", async () => {
  exporter.reset()
  const poison = trace.getTracer("poison").startSpan("poison-connection")
  const poisonTraceId = poison.spanContext().traceId
  let stamped: string | undefined
  await context.with(trace.setSpan(context.active(), poison), () =>
    runTaskFrameSpan(
      "device.task.result",
      state,
      { operation_id: "not-even-a-uuid", traceparent: "A".repeat(5000) },
      async () => {
        stamped = activeTraceparent() ?? undefined
        return { ok: true }
      }
    )
  )
  poison.end()
  const frame = exporter
    .getFinishedSpans()
    .find((s) => s.name === "device.task.result")
  assert.ok(frame)
  assert.equal(frame.parentSpanContext, undefined, "must be a ROOT span")
  assert.notEqual(frame.spanContext().traceId, poisonTraceId)
  // what the wakeup row would receive: a minted, regex-valid traceparent
  assert.ok(stamped)
  assert.match(stamped, TRACEPARENT_RE)
  assert.equal(stamped.includes("AAAA"), false)
  // the hostile 5KB traceparent must not have become a span attribute either
  assert.equal(JSON.stringify(frame.attributes).includes("AAAA"), false)
})

test("poisoned ambient context: a valid envelope trace parents to the ENVELOPE, not the poison", async () => {
  exporter.reset()
  const poison = trace.getTracer("poison").startSpan("poison-connection")
  await context.with(trace.setSpan(context.active(), poison), () =>
    runTaskFrameSpan(
      "device.task.status",
      state,
      { traceparent: DISPATCH_TRACEPARENT },
      async () => ({ ok: true })
    )
  )
  poison.end()
  const frame = exporter
    .getFinishedSpans()
    .find((s) => s.name === "device.task.status")
  assert.ok(frame)
  assert.equal(frame.spanContext().traceId, TRACE_ID)
  assert.equal(frame.parentSpanContext?.spanId, SPAN_ID)
  assert.notEqual(frame.spanContext().traceId, poison.spanContext().traceId)
})

test("hostile ref fields never become attributes (raw pre-zod params)", async () => {
  exporter.reset()
  await runTaskFrameSpan(
    "device.task.result",
    state,
    { operation_id: "x".repeat(65), attempt_id: 42, ok: true },
    async () => ({ ok: true }) as PersistResult
  )
  const span = exporter.getFinishedSpans()[0]!
  assert.equal(span.attributes["synapse.operation_id"], undefined)
  assert.equal(span.attributes["synapse.attempt_id"], undefined)
})

// ─── the device-task leg, unit level (Phase-2 gate) ─────────────────────────
// A simulated device.task.result frame drives a persist chain that inserts a
// session wakeup — exactly what persistTaskResult → completeToolCallTask →
// deliverTaskNotice does — and the wakeup row must carry the DISPATCH trace.

const NS = "cp-task-leg-test"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function buildSessionFixture(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "owner" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ kind: "group", workspaceId: ws.id as string, title: `${NS} c` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: ws.id as string,
      kind: "actor",
      displayName: `${NS} actor`,
      createdBySubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: `${NS} actor`,
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspaceId: ws.id as string,
      actorId: actor.id as string,
      conversationId: conv.id as string,
      status: "idle",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("conversationItems")
    .values({
      conversationId: conv.id as string,
      sessionId: session.id as string,
      scope: "shared",
      surface: "internal",
      itemType: "event",
      subtype: "task_notice",
      role: "system",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: ws.id as string,
    actorId: actor.id as string,
    sessionId: session.id as string,
    sourceItemId: item.id as string,
  }
}

test(
  "device-task leg: a simulated device.task.result frame ⇒ the wakeup row carries the dispatch trace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildSessionFixture(db)

      const result = await runTaskFrameSpan(
        "device.task.result",
        state,
        resultFrameParams(),
        async () => {
          // Stand-in for persistTaskResult's terminal chain, which awaits the
          // durable wakeup INSERT synchronously — the insert reads
          // activeTraceparent() itself, with ZERO changes to session/repo.
          await insertSessionWakeupRow(db, {
            sessionId: fx.sessionId,
            actorId: fx.actorId,
            workspaceId: fx.workspaceId,
            sourceItemId: fx.sourceItemId,
            sourceType: "system_interrupt" as const,
            sourceParticipantType: "system" as const,
            sourceName: `${NS}.device-tool`,
            summary: "Device tool completed.",
            reasonText: "Device tool completed.",
            trigger: "system_interrupt" as const,
          })
          return { ok: true } satisfies PersistResult
        }
      )
      assert.deepEqual(result, { ok: true })

      const row = await db
        .selectFrom("sessionWakeups")
        .select("originTraceparent")
        .where("sessionId", "=", fx.sessionId)
        .where("sourceItemId", "=", fx.sourceItemId)
        .executeTakeFirstOrThrow()
      // Same TRACE as the dispatch; the span id is the frame span's (the
      // wakeup's origin is the device.task.result handling itself).
      assert.ok(row.originTraceparent, "origin_traceparent must be stamped")
      assert.ok(
        (row.originTraceparent as string).includes(TRACE_ID),
        `expected dispatch trace ${TRACE_ID} in ${row.originTraceparent}`
      )
    })
  }
)
