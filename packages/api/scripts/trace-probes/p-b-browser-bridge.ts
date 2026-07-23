// P-B (browser bridge) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
//
// The client side of the W3C bridge, rewritten around the round-2 rule: a client
// carrier's span id must come from a Span the SDK created (via the shared
// `withClientSpan` shape), and NO Sentry client means NO carrier. This replaces
// the two vacuous cells that only exercised `Sentry.getTraceData` inside an
// explicit span. Six cells now pin the behaviour the web + RN `client-trace.ts`
// helpers depend on, including a NEGATIVE control that reproduces the
// `getTraceData` fabrication the helpers exist to eliminate.
//
// Process model: `@sentry/nextjs`'s node build sets up its OTel SDK + sampler
// ONCE per process — a second `Sentry.init` after `close()` (even after
// `trace.disable()`) does NOT re-arm the sampler (verified), so the sampled
// (rate 1) and unsampled (rate 0) cells each run in their OWN child process
// (`PB_SENTRY_RATE`), print `PB_RESULT <json>`, and the parent asserts on it —
// the same child-process pattern the P-A boot probes use. What the node harness
// CANNOT reproduce is the browser build's page-level scope-propagation
// inheritance (the node build mints a fresh root trace id); that property was
// pinned in the design spike against the client build and is represented here by
// the reproducible nested-child cell (a child under an active span shares its
// trace id).
//
// Run: npx tsx scripts/trace-probes/p-b-browser-bridge.ts
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import {
  context,
  defaultTextMapGetter,
  trace,
  ROOT_CONTEXT,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { TRACEPARENT_RE, isValidTraceparent } from "@synapse/shared"
import {
  API_DIR,
  TSX_BIN,
  baselineEnv,
  check,
  finish,
  startSentryCatcher,
} from "./_shared.js"

// CJS require: the package's node entry re-exports @sentry/node DYNAMICALLY,
// which cjs-module-lexer cannot see through an ESM namespace import. The SDK
// LOGIC this probe pins (startSpan id generation, spanContext, the getClient
// gate, the getTraceData scope fallback) is shared @sentry/core code, identical
// in the browser build the frontends consume.
const require = createRequire(import.meta.url)
const Sentry = require("@sentry/nextjs") as typeof import("@sentry/nextjs")

// The exact carrier construction the shared helpers use (assemble + canonical
// gate; flags mirror the real sampling decision). Reproduced here so the probe
// pins the SDK behaviour the helper relies on.
function carrierOf(spanContext: {
  traceId: string
  spanId: string
  traceFlags: number
}): string | undefined {
  const flags = (spanContext.traceFlags & 1) === 1 ? "01" : "00"
  const candidate = `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
  return isValidTraceparent(candidate) ? candidate : undefined
}
function withClientSpan<T>(
  name: string,
  op: string,
  fn: (carrier: string | undefined) => T
): T {
  if (!Sentry.getClient()) return fn(undefined)
  return Sentry.startSpan({ name, op }, (span) =>
    fn(carrierOf(span.spanContext()))
  )
}

const traceIdOf = (tp: string) => tp.slice(3, 35)
const spanIdOf = (tp: string) => tp.slice(36, 52)

interface RateChildResult {
  rate: 0 | 1
  carrier: string | null
  spanId: string
  scopeTraceId: string
  exportedSpanIds: string[]
  neg?: { tp1?: string; tp2?: string; st1?: string }
  nested?: { outerTraceId: string; childCarrier: string | null }
}

// ── CHILD MODE: one @sentry/node init at exactly one sampling rate, then print
//    PB_RESULT and exit. Kept BEFORE the main orchestration so a child never
//    re-spawns itself.
const childRate = process.env.PB_SENTRY_RATE
if (childRate === "0" || childRate === "1") {
  const rate = Number(childRate) as 0 | 1
  const catcher = await startSentryCatcher()
  Sentry.init({
    dsn: catcher.dsn,
    tracesSampleRate: rate,
    defaultIntegrations: false,
  })

  const scopeTraceId = Sentry.getCurrentScope().getPropagationContext().traceId
  const probe = Sentry.startSpan(
    { name: "ws.send auth", op: "ws.client" },
    (span) => ({
      carrier: carrierOf(span.spanContext()),
      spanId: span.spanContext().spanId,
    })
  )

  // NEGATIVE control (rate-0 child): getTraceData with no active span fabricates
  // a fresh random span id per call and disagrees with its own sibling
  // sentry-trace. This is the F10 defect; if a future change reintroduces
  // getTraceData stamping, these ids stop differing and the parent's assertions
  // fail.
  let neg: RateChildResult["neg"]
  if (rate === 0) {
    const td1 = Sentry.getTraceData({ propagateTraceparent: true })
    const td2 = Sentry.getTraceData({ propagateTraceparent: true })
    neg = {
      tp1: td1.traceparent?.split("-")[2],
      tp2: td2.traceparent?.split("-")[2],
      st1: td1["sentry-trace"]?.split("-")[1],
    }
  }

  // NESTED (rate-1 child): a withClientSpan opened inside an active span is a
  // true child sharing that span's trace id (the reproducible core of page-level
  // correlation).
  let nested: RateChildResult["nested"]
  if (rate === 1) {
    nested = Sentry.startSpan({ name: "pageload-sim" }, (outer) => ({
      outerTraceId: outer.spanContext().traceId,
      childCarrier:
        withClientSpan("ws.send subscribe", "ws.client", (c) => c) ?? null,
    }))
  }

  await Sentry.flush(2000)
  const exportedSpanIds = catcher
    .itemsOfType("transaction")
    .map((item) => {
      const p = item.payload as { contexts?: { trace?: { span_id?: string } } }
      return p?.contexts?.trace?.span_id
    })
    .filter((id): id is string => typeof id === "string")

  const result: RateChildResult = {
    rate,
    carrier: probe.carrier ?? null,
    spanId: probe.spanId,
    scopeTraceId,
    exportedSpanIds,
    neg,
    nested,
  }
  console.log("PB_RESULT " + JSON.stringify(result))
  await Sentry.close(2000)
  await catcher.close()
  process.exit(0)
}

async function runRateChild(rate: 0 | 1): Promise<RateChildResult> {
  const child = spawn(TSX_BIN, [fileURLToPath(import.meta.url)], {
    cwd: API_DIR,
    env: baselineEnv({ PB_SENTRY_RATE: String(rate) }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  await once(child, "exit")
  clearTimeout(timer)
  const line = stdout.split("\n").find((l) => l.startsWith("PB_RESULT "))
  if (!line) {
    throw new Error(
      `rate=${rate} child produced no PB_RESULT\n${stderr || stdout}`
    )
  }
  return JSON.parse(line.slice("PB_RESULT ".length)) as RateChildResult
}

// ── CELL 1: no client ⇒ helper stamps NOTHING (even though startSpan fabricates)
{
  const bare = Sentry.startSpan({ name: "no-client-probe" }, (s) =>
    s.spanContext()
  )
  check(
    "no client: a BARE startSpan still hands back plausible-looking ids (why the gate is mandatory)",
    /^[0-9a-f]{32}$/.test(bare.traceId) && /^[0-9a-f]{16}$/.test(bare.spanId),
    bare
  )
  const carrier = withClientSpan("ws.send auth", "ws.client", (c) => c)
  check("no client: the GATED helper yields no carrier", carrier === undefined)
}

const r1 = await runRateChild(1)
const r0 = await runRateChild(0)

// ── CELL 2: rate 1 ⇒ a real, canonical, SAMPLED, EXPORTED carrier the api extracts
check(
  "rate 1: carrier produced and canonical",
  typeof r1.carrier === "string" && TRACEPARENT_RE.test(r1.carrier),
  r1.carrier
)
check("rate 1: flags are 01 (sampled)", r1.carrier?.endsWith("-01"), r1.carrier)
check(
  "rate 1: carrier span id === the real span object's id",
  r1.carrier !== null && spanIdOf(r1.carrier) === r1.spanId
)
{
  const extracted = trace.getSpanContext(
    new W3CTraceContextPropagator().extract(
      ROOT_CONTEXT,
      { traceparent: r1.carrier! },
      defaultTextMapGetter
    )
  )
  check(
    "rate 1: api-side W3C extract yields the identical trace + span id",
    Boolean(
      extracted &&
      r1.carrier &&
      extracted.traceId === traceIdOf(r1.carrier) &&
      extracted.spanId === spanIdOf(r1.carrier)
    ),
    { extracted, carrier: r1.carrier }
  )
}
check(
  "rate 1: the emitting span id appears in a TRANSMITTED envelope (real, exported span)",
  r1.carrier !== null && r1.exportedSpanIds.includes(spanIdOf(r1.carrier)),
  r1.exportedSpanIds
)

// ── CELL 4: nested inside an active span ⇒ a true child of the same trace.
check(
  "nested: the child carrier shares the active span's trace id",
  r1.nested?.childCarrier != null &&
    traceIdOf(r1.nested.childCarrier) === r1.nested.outerTraceId,
  r1.nested
)

// ── CELL 3: rate 0 ⇒ a real span id, flags 00, nothing exported
check(
  "rate 0: carrier still produced and canonical",
  typeof r0.carrier === "string" && TRACEPARENT_RE.test(r0.carrier),
  r0.carrier
)
check(
  "rate 0: flags are 00 (unsampled)",
  r0.carrier?.endsWith("-00"),
  r0.carrier
)
check(
  "rate 0: carrier span id === the real span object's id",
  r0.carrier !== null && spanIdOf(r0.carrier) === r0.spanId
)
check(
  "rate 0: zero span envelopes transmitted",
  r0.exportedSpanIds.length === 0,
  r0.exportedSpanIds.length
)

// ── NEGATIVE control (from the rate-0 child): getTraceData fabrication.
check(
  "NEGATIVE control: two getTraceData calls fabricate DIFFERENT parent span ids",
  Boolean(r0.neg?.tp1 && r0.neg?.tp2 && r0.neg.tp1 !== r0.neg.tp2),
  r0.neg
)
check(
  "NEGATIVE control: traceparent span id disagrees with its own sentry-trace",
  Boolean(r0.neg?.tp1 && r0.neg?.st1 && r0.neg.tp1 !== r0.neg.st1),
  r0.neg
)

// ── CELL 6: RN parity against the mobile app's own installed @sentry/core
{
  const RNcore =
    require("../../../mobile-app/node_modules/@sentry/core") as typeof import("@sentry/core")
  check(
    "RN core: exports the same primitives the helper uses (no getTraceData needed)",
    typeof RNcore.startSpan === "function" &&
      typeof RNcore.getClient === "function" &&
      typeof RNcore.getActiveSpan === "function" &&
      typeof RNcore.getCurrentScope === "function"
  )
  check(
    "RN core: no client ⇒ getClient() undefined (same gate as web)",
    RNcore.getClient() === undefined
  )
  const rnCarrier = RNcore.startSpan({ name: "ws.send auth" }, (span) =>
    carrierOf(span.spanContext())
  )
  check(
    "RN core: startSpan + spanContext().traceFlags builds the same canonical carrier shape",
    typeof rnCarrier === "string" && TRACEPARENT_RE.test(rnCarrier),
    rnCarrier
  )
}

await new Promise((r) => setTimeout(r, 0))
context.disable()
finish("P-B")
