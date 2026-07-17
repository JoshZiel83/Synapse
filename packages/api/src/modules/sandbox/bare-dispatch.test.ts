// [D2] `sandbox.dispatch ${toolName}` INTERNAL parity span (trace plan §4.G
// change 4, §9 D2 — REQUIRED): the Mode-B bare fork's analogue of the resident
// path's `tools/call` CLIENT edge. Pins:
//   - a successful dispatch through a (fake) plane exports exactly ONE
//     INTERNAL span named `sandbox.dispatch <tool>` with the runtime/adapter
//     attributes;
//   - a deny branch (sandboxProvider:'none') exports the SAME span with
//     status ERROR + error.type='runtime_constraint' (TOTAL function ⇒ error
//     recording is a status mapping, not recordException);
//   - undici auto-CLIENT spans from a fetch-backed plane (the cubesandbox
//     envd/control shape) parent UNDER the parity span — the startActiveSpan
//     active-context parenting, with NO suppressTracing (the children are
//     wanted, unlike devices/dispatch.ts).

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import type { Kysely } from "kysely"
import type { OperationEnvelope } from "@synapse/device-protocol"
import { withTestDb } from "../../test/helpers/db.js"
import { mintBareSandboxRuntimeTx } from "../devices/repo.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import type { SandboxDataPlane } from "./data-plane.js"
import {
  dispatchBareRuntimeTool,
  registerBareDataPlane,
  __clearBareDataPlanes,
} from "./bare-dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"

// Real provider + in-memory exporter, plus UndiciInstrumentation so the
// fetch-backed fake plane produces the same auto CLIENT spans the cubesandbox
// envd/control clients do in production.
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
context.setGlobalContextManager(new AsyncLocalStorageContextManager())
trace.setGlobalTracerProvider(provider)
propagation.setGlobalPropagator(new W3CTraceContextPropagator())
registerInstrumentations({
  instrumentations: [new UndiciInstrumentation()],
  tracerProvider: provider,
})

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`
}

async function seedSession(
  db: Kysely<any>
): Promise<{ workspaceId: string; sessionId: string }> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@d2`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "d2 ws" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = (
    await db
      .insertInto("accessSubjects")
      .values({ kind: "workspace", workspaceId: ws.id } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: uniq("a"),
      status: "active",
      createdBySubjectId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ workspaceId: ws.id, kind: "direct", title: "t" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspaceId: ws.id,
      conversationId: conv.id,
      actorId: actor.id,
      status: "running",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return { workspaceId: ws.id as string, sessionId: session.id as string }
}

function fsReadGrant(): RuntimeAuthorizationGrantRecord {
  return {
    capability: "filesystem",
    filesystem: { access: "read", pathPrefixes: ["/conversation"] },
  } as unknown as RuntimeAuthorizationGrantRecord
}

function envelopeFor(args: {
  exposureId: string
  toolId: string
  toolRevisionId: string
  expiresAt: string
}): OperationEnvelope {
  return {
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    runtime_session_id: randomUUID(),
    runtime_capability_id: randomUUID(),
    runtime_exposure_id: args.exposureId,
    runtime_tool_id: args.toolId,
    runtime_tool_revision_id: args.toolRevisionId,
    input_hash: "sha256:deadbeef",
    task_mode: "sync",
    runtime_authorization: {
      grant_ids: [],
      grant_scope: "actor",
      grant_specs: [],
    },
    issued_at: new Date().toISOString(),
    expires_at: args.expiresAt,
  } as unknown as OperationEnvelope
}

/** A fetch-backed fake plane: read() GETs a local echo server (the off-box
 *  envd shape) and returns the body bytes. Everything else is unreachable in
 *  these tests. */
function makeFetchBackedPlane(url: string): SandboxDataPlane {
  const descriptor = buildLocalBareDescriptor({ isolation: "bwrap" })
  const unreachable = (): never => {
    throw new Error("not used by this test")
  }
  return {
    descriptor,
    stat: unreachable,
    list: unreachable,
    read: async () => {
      const res = await fetch(url)
      const bytes = new Uint8Array(await res.arrayBuffer())
      return { bytes, totalSize: bytes.byteLength, truncated: false }
    },
    write: unreachable,
    mkdir: unreachable,
    move: unreachable,
    remove: unreachable,
    search: unreachable,
    exec: unreachable,
    dispose: async () => {},
  }
}

test("deny branch (sandboxProvider:'none'): ONE INTERNAL `sandbox.dispatch <tool>` span, status ERROR, error.type='runtime_constraint'", async () => {
  __clearBareDataPlanes()
  exporter.reset()
  const runtimeId = randomUUID()
  const res = await dispatchBareRuntimeTool({
    runtimeId,
    runtimeServiceId: randomUUID(),
    envelope: envelopeFor({
      exposureId: randomUUID(),
      toolId: randomUUID(),
      toolRevisionId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    args: { path: "/conversation/hello.txt" },
    builtinKind: "filesystem",
    toolName: "fs_read",
    grant: fsReadGrant(),
    sandboxProvider: "none",
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "runtime_constraint")

  const spans = exporter
    .getFinishedSpans()
    .filter((s) => s.name.startsWith("sandbox.dispatch"))
  assert.equal(spans.length, 1, "exactly one parity span")
  const span = spans[0]!
  assert.equal(span.name, "sandbox.dispatch fs_read")
  assert.equal(span.kind, SpanKind.INTERNAL)
  assert.equal(span.status.code, SpanStatusCode.ERROR)
  assert.equal(span.attributes["error.type"], "runtime_constraint")
  assert.equal(span.attributes["synapse.runtime.id"], runtimeId)
  assert.equal(span.attributes["synapse.tool.name"], "fs_read")
  assert.equal(span.attributes["synapse.builtin.kind"], "filesystem")
  assert.equal(
    span.events.some((e) => e.name === "exception"),
    false,
    "TOTAL function: status mapping, never recordException"
  )
})

test("escaped infrastructure throw: the parity span exports ERROR + exception (never UNSET) and the error rethrows", async () => {
  __clearBareDataPlanes()
  exporter.reset()
  const runtimeId = randomUUID()
  // Live plane HIT (host adapter ⇒ the liveness re-check fails OPEN on a DB
  // error), then verifyBareDispatchTarget hits the throwing Executor and the
  // throw ESCAPES dispatchBareRuntimeTool — the one non-TOTAL class. The
  // wrapper's catch must record it before rethrowing.
  registerBareDataPlane(
    runtimeId,
    makeFetchBackedPlane("http://127.0.0.1:1/unused"),
    "local"
  )
  const throwingExecutor = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("db down")
      },
    }
  )
  await assert.rejects(
    () =>
      dispatchBareRuntimeTool({
        runtimeId,
        runtimeServiceId: randomUUID(),
        envelope: envelopeFor({
          exposureId: randomUUID(),
          toolId: randomUUID(),
          toolRevisionId: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        args: { path: "/conversation/hello.txt" },
        builtinKind: "filesystem",
        toolName: "fs_read",
        grant: fsReadGrant(),
        run: throwingExecutor as never,
        sandboxProvider: "local",
      }),
    /db down/,
    "the infrastructure error must surface to the caller unchanged"
  )

  const spans = exporter
    .getFinishedSpans()
    .filter((s) => s.name.startsWith("sandbox.dispatch"))
  assert.equal(spans.length, 1, "the parity span still exports (finally-end)")
  const span = spans[0]!
  assert.equal(
    span.status.code,
    SpanStatusCode.ERROR,
    "an errored dispatch must never export as UNSET"
  )
  assert.equal(span.attributes["error.type"], "Error")
  const exception = span.events.find((e) => e.name === "exception")
  assert.ok(exception, "the escaped throw is recorded on the span")
  assert.equal(exception.attributes?.["exception.message"], "db down")
})

test(
  "success through a fetch-backed fake plane: ONE parity span with runtime/adapter attributes; the undici CLIENT span parents UNDER it",
  { timeout: 5 * 60_000 },
  async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("hi from envd")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    const echoUrl = `http://127.0.0.1:${port}/files`

    try {
      await withTestDb(async (db) => {
        __clearBareDataPlanes()
        const { workspaceId, sessionId } = await seedSession(db)
        const runtimeId = randomUUID()
        const serviceId = randomUUID()
        const descriptor = buildLocalBareDescriptor({ isolation: "bwrap" })
        const minted = await mintBareSandboxRuntimeTx({
          runtimeId,
          workspaceId,
          sessionId,
          serviceId,
          adapter: "local",
          dataPlaneEndpoint: `inprocess:${runtimeId}`,
          capabilityDescriptor: descriptor as unknown as Record<
            string,
            unknown
          >,
          exposures: buildBareCoreCatalog(descriptor),
          executor: db,
        })
        const fsIds = minted.assignedIds["builtin/filesystem"]!
        const fsRead = fsIds.tools["fs_read"]!

        // Registry HIT path with the fetch-backed plane.
        registerBareDataPlane(runtimeId, makeFetchBackedPlane(echoUrl), "local")

        exporter.reset()
        const res = await dispatchBareRuntimeTool({
          runtimeId,
          runtimeServiceId: serviceId,
          envelope: envelopeFor({
            exposureId: fsIds.runtime_exposure_id,
            toolId: fsRead.runtime_tool_id,
            toolRevisionId: fsRead.runtime_tool_revision_id,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          args: { path: "/conversation/hello.txt" },
          builtinKind: "filesystem",
          toolName: "fs_read",
          grant: fsReadGrant(),
          run: db,
          sandboxProvider: "local",
        })
        assert.equal(res.ok, true, JSON.stringify(res.error ?? {}))

        const spans = exporter.getFinishedSpans()
        const parity = spans.filter((s) =>
          s.name.startsWith("sandbox.dispatch")
        )
        assert.equal(parity.length, 1, "exactly one parity span")
        const span = parity[0]!
        assert.equal(span.name, "sandbox.dispatch fs_read")
        assert.equal(span.kind, SpanKind.INTERNAL)
        assert.equal(span.status.code, SpanStatusCode.UNSET)
        assert.equal(span.attributes["synapse.runtime.id"], runtimeId)
        assert.equal(span.attributes["synapse.tool.name"], "fs_read")
        assert.equal(span.attributes["synapse.builtin.kind"], "filesystem")
        assert.equal(
          span.attributes["synapse.sandbox.adapter"],
          "local",
          "HIT path stamps the registry entry's adapter tag"
        )

        // The plane's fetch produced an undici auto CLIENT span that must be
        // a CHILD of the parity span (same trace) — not an anonymous sibling
        // root. This is the [D2] nesting property that gives the off-box
        // envd/control hops a per-tool INTERNAL parent.
        const client = spans.find(
          (s) =>
            s.kind === SpanKind.CLIENT &&
            s.spanContext().traceId === span.spanContext().traceId
        )
        assert.ok(client, "undici CLIENT span shares the parity trace")
        assert.equal(
          client.parentSpanContext?.spanId,
          span.spanContext().spanId
        )
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  }
)
