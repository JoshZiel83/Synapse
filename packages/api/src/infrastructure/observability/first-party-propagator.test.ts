import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import { once } from "node:events"
import path from "node:path"
import { createRequire } from "node:module"
import {
  context,
  createTraceState,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  trace,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type TraceState,
} from "@opentelemetry/api"
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import * as Sentry from "@sentry/node"
import { SentryPropagator, SentrySampler } from "@sentry/opentelemetry"
import {
  FirstPartyOnlyPropagator,
  buildFirstPartyAllowlist,
  firstPartyPropagator,
  isFirstParty,
} from "./first-party-propagator.js"
import {
  SENTRY_TRACE_STATE_KEYS,
  activeTraceCarrier,
  sanitizeTraceState,
} from "./traceparent.js"

const EMPTY_ALLOWLIST = buildFirstPartyAllowlist({})
const REMOTE_TRACEPARENT =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

// Local (non-global) provider for the pure inject/extract tests — spans get
// creation-time attributes and the default AlwaysOn sampler.
const localExporter = new InMemorySpanExporter()
const localProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(localExporter)],
})
const localTracer = localProvider.getTracer("first-party-propagator-test")

function recordingSpanContext(url?: string) {
  const span = localTracer.startSpan(
    "client",
    url === undefined ? {} : { attributes: { "url.full": url } }
  )
  return { span, ctx: trace.setSpan(ROOT_CONTEXT, span) }
}

function injectInto(
  propagator: TextMapPropagator,
  ctx: Context
): Record<string, string> {
  const carrier: Record<string, string> = {}
  propagator.inject(ctx, carrier, defaultTextMapSetter)
  return carrier
}

// ---------------------------------------------------------------------------
// isFirstParty matcher table
// ---------------------------------------------------------------------------

test("matcher allows dotless, loopback, RFC1918, ULA", () => {
  for (const url of [
    "http://embedding-sidecar:8775/embed", // dotless docker DNS
    "http://tika/rmeta",
    "http://localhost:3000/api",
    "http://127.0.0.1:4318/v1/traces",
    "http://127.255.0.9/", // whole 127/8
    "http://[::1]:8080/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.10.20/",
    "http://[fd12:3456:789a::1]/", // ULA fd00::/8
    "http://[fc00::1]/", // ULA fc00::/8
  ]) {
    assert.ok(isFirstParty(url, EMPTY_ALLOWLIST), `expected allow: ${url}`)
  }
})

test("matcher denies third-party hosts and public addresses", () => {
  for (const url of [
    "https://api.telegram.org/bot123/getUpdates",
    "https://graph.facebook.com/v19.0/me",
    "https://api.notion.com/v1/pages",
    "https://api.telegram.org./x", // trailing-dot variant
    "http://8.8.8.8/",
    "http://172.32.0.1/", // just past RFC1918 172.16/12
    "http://192.169.0.1/",
    "http://[2001:db8::1]/", // public IPv6
    "http://0.0.0.0:8080/", // exotic ⇒ deny (fail-closed)
    "not a url",
    "",
  ]) {
    assert.ok(!isFirstParty(url, EMPTY_ALLOWLIST), `expected deny: ${url}`)
  }
})

test("matcher normalizes integer/hex/octal IP literals — public denied, private allowed", () => {
  // WHATWG URL parsing already canonicalizes these for http(s), so the matcher
  // sees dotted-decimal — the point is they must NEVER hit the dotless branch.
  for (const url of [
    "http://134744072/", // 8.8.8.8 decimal
    "http://0x08080808/", // 8.8.8.8 hex
    "http://010.010.010.010/", // 8.8.8.8 dotted-octal
    "http://0x08.0x08.0x08.0x08/",
  ]) {
    assert.ok(!isFirstParty(url, EMPTY_ALLOWLIST), `expected deny: ${url}`)
  }
  for (const url of [
    "http://2130706433/", // 127.0.0.1 decimal
    "http://0x7f000001/", // 127.0.0.1 hex
    "http://0177.0.0.1/", // 127.0.0.1 octal first octet
    "http://0xc0.0xa8.1.1/", // 192.168.1.1
  ]) {
    assert.ok(isFirstParty(url, EMPTY_ALLOWLIST), `expected allow: ${url}`)
  }
})

test("matcher hardening holds for a raw numeric label (no WHATWG normalization)", () => {
  // Non-special URL schemes keep the host opaque — the single-label numeric
  // guard itself must classify these as IP literals, never as docker DNS.
  assert.ok(!isFirstParty("foo://134744072/", EMPTY_ALLOWLIST)) // 8.8.8.8
  assert.ok(!isFirstParty("foo://0x08080808/", EMPTY_ALLOWLIST))
  assert.ok(isFirstParty("foo://2130706433/", EMPTY_ALLOWLIST)) // 127.0.0.1
  assert.ok(isFirstParty("foo://0x7f000001/", EMPTY_ALLOWLIST))
  assert.ok(isFirstParty("http://redis/", EMPTY_ALLOWLIST)) // non-numeric label
})

test("env allowlist: exact entries, leading-dot suffixes, BASE_URL/APP_BASE_URL", () => {
  const allowlist = buildFirstPartyAllowlist({
    SYNAPSE_TRACE_FIRST_PARTY_HOSTS:
      "tempo.internal.example, .svc.cluster.example",
    BASE_URL: "https://app.synapse.example",
    APP_BASE_URL: "https://console.synapse.example:8443/base",
  })
  assert.ok(isFirstParty("https://tempo.internal.example/api", allowlist))
  assert.ok(isFirstParty("https://api.svc.cluster.example/y", allowlist))
  assert.ok(isFirstParty("https://a.b.svc.cluster.example/z", allowlist))
  assert.ok(isFirstParty("https://app.synapse.example/callback", allowlist))
  assert.ok(isFirstParty("https://console.synapse.example/x", allowlist))
  // exact entries are not suffixes; suffix entries do not match the bare domain
  assert.ok(!isFirstParty("https://evil-tempo.internal.example/", allowlist))
  assert.ok(!isFirstParty("https://svc.cluster.example/", allowlist))
  assert.ok(!isFirstParty("https://api.telegram.org/", allowlist))
})

test("CubeSandbox envd vhost: denied by default, allowed via .{domain} suffix entry", () => {
  // The envd data plane addresses a virtual vhost {envdPort}-{sandboxID}.{domain}
  // — dotted, so it fails the auto-first-party rules (fail-closed default is a
  // correlation-only loss; see docs/trace-propagation-policy.md).
  const vhost = "https://49983-ibkkg5qm2eumavdgapku.cube.app/exec"
  assert.ok(!isFirstParty(vhost, EMPTY_ALLOWLIST))
  assert.ok(
    !isFirstParty(
      vhost,
      buildFirstPartyAllowlist({ SYNAPSE_TRACE_FIRST_PARTY_HOSTS: "cube.app" })
    )
  )
  assert.ok(
    isFirstParty(
      vhost,
      buildFirstPartyAllowlist({ SYNAPSE_TRACE_FIRST_PARTY_HOSTS: ".cube.app" })
    )
  )
})

test("firstPartyPropagator factory builds its allowlist from process.env", () => {
  const prev = process.env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS
  process.env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS = ".factory.example"
  try {
    const wrapper = firstPartyPropagator(new W3CTraceContextPropagator(), false)
    const { span, ctx } = recordingSpanContext("https://api.factory.example/x")
    assert.ok("traceparent" in injectInto(wrapper, ctx))
    span.end()
  } finally {
    if (prev === undefined) delete process.env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS
    else process.env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS = prev
  }
})

// ---------------------------------------------------------------------------
// FirstPartyOnlyPropagator inject/extract
// ---------------------------------------------------------------------------

test("deny writes NOTHING through the composite while the span still exports", () => {
  const wrapper = new FirstPartyOnlyPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator()],
    }),
    false,
    EMPTY_ALLOWLIST
  )
  const { span, ctx } = recordingSpanContext(
    "https://api.telegram.org/bot123/sendMessage"
  )
  const carrier = injectInto(wrapper, ctx)
  assert.deepEqual(carrier, {})
  span.end()
  const exported = localExporter
    .getFinishedSpans()
    .find((s) => s.spanContext().spanId === span.spanContext().spanId)
  assert.ok(exported, "denied span must still export")
})

test("first-party URL delegates to the composite", () => {
  const wrapper = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    false,
    EMPTY_ALLOWLIST
  )
  const { span, ctx } = recordingSpanContext("http://127.0.0.1:8775/embed")
  const carrier = injectInto(wrapper, ctx)
  const sc = span.spanContext()
  assert.equal(carrier.traceparent, `00-${sc.traceId}-${sc.spanId}-01`)
  span.end()
})

test("recording span without a resolvable URL fails closed", () => {
  const wrapper = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    false,
    EMPTY_ALLOWLIST
  )
  const { span, ctx } = recordingSpanContext()
  assert.deepEqual(injectInto(wrapper, ctx), {})
  span.end()
})

test("non-recording carve-out delegates under Sentry-off only", () => {
  // Unsampled requests yield attribute-less NonRecordingSpans; Sentry-on
  // resolves via the sentry.url traceState fallback instead.
  const nonRecording = trace.wrapSpanContext({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: TraceFlags.NONE,
  })
  const ctx = trace.setSpan(ROOT_CONTEXT, nonRecording)
  const sentryOff = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    false,
    EMPTY_ALLOWLIST
  )
  const sentryOn = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    true,
    EMPTY_ALLOWLIST
  )
  assert.equal(
    injectInto(sentryOff, ctx).traceparent,
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00"
  )
  assert.deepEqual(injectInto(sentryOn, ctx), {})
})

// Minimal TraceState double with Sentry's semantics: their vendored class
// skips @opentelemetry/core's key validation, which is the only way sentry.*
// keys exist in a real traceState in the first place.
function sentryStyleTraceState(entries: Record<string, string>): TraceState {
  const state = new Map(Object.entries(entries))
  const ts: TraceState = {
    set: (k, v) =>
      sentryStyleTraceState({ ...Object.fromEntries(state), [k]: v }),
    unset: (k) => {
      const next = Object.fromEntries(state)
      delete next[k]
      return sentryStyleTraceState(next)
    },
    get: (k) => state.get(k),
    serialize: () =>
      Array.from(state.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
  }
  return ts
}

test("sentry.url traceState fallback resolves non-recording spans under Sentry-on", () => {
  const wrapper = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    true,
    EMPTY_ALLOWLIST
  )
  const mk = (url: string) =>
    trace.setSpan(
      ROOT_CONTEXT,
      trace.wrapSpanContext({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: TraceFlags.NONE,
        traceState: sentryStyleTraceState({ "sentry.url": url }),
      })
    )
  assert.ok(
    "traceparent" in injectInto(wrapper, mk("http://127.0.0.1:8775/embed"))
  )
  assert.deepEqual(
    injectInto(wrapper, mk("https://api.telegram.org/bot123/getMe")),
    {}
  )
})

test("extract delegates unconditionally; garbage extract is a safe no-op", () => {
  const wrapper = new FirstPartyOnlyPropagator(
    new W3CTraceContextPropagator(),
    false,
    EMPTY_ALLOWLIST
  )
  const good = wrapper.extract(
    ROOT_CONTEXT,
    { traceparent: REMOTE_TRACEPARENT },
    defaultTextMapGetter
  )
  assert.equal(
    trace.getSpanContext(good)?.traceId,
    "4bf92f3577b34da6a3ce929d0e0e4736"
  )
  const garbage = wrapper.extract(
    ROOT_CONTEXT,
    { traceparent: "garbage" },
    defaultTextMapGetter
  )
  assert.equal(trace.getSpanContext(garbage), undefined)
  assert.deepEqual(wrapper.fields(), new W3CTraceContextPropagator().fields())
})

// ---------------------------------------------------------------------------
// SDK-shape and installed-version canaries
// ---------------------------------------------------------------------------

test("SDK-shape pin: span.attributes is readable on the installed sdk-trace-base", () => {
  // first-party-propagator.ts reads `span.attributes` — an SDK implementation
  // field, not @opentelemetry/api surface (same technique Sentry ships). If an
  // SDK upgrade drops it, this fails before production does.
  const { span } = recordingSpanContext("http://127.0.0.1:1/x")
  const attributes = (
    span as unknown as { attributes?: Record<string, unknown> }
  ).attributes
  assert.equal(attributes?.["url.full"], "http://127.0.0.1:1/x")
  span.end()
})

test("canary: SENTRY_TRACE_STATE_KEYS matches the installed @sentry/opentelemetry", () => {
  const require = createRequire(import.meta.url)
  const dir = path.dirname(require.resolve("@sentry/opentelemetry"))
  const source = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n")
  const installed = new Set(
    [...source.matchAll(/SENTRY_TRACE_STATE_[A-Z_]+ = "([^"]+)"/g)].map(
      (m) => m[1]
    )
  )
  assert.deepEqual(installed, new Set(SENTRY_TRACE_STATE_KEYS))
})

// ---------------------------------------------------------------------------
// sanitizeTraceState round-trip (stage 1)
// ---------------------------------------------------------------------------

test("sanitizeTraceState: vendor member survives alone; zero junk keys after re-extract", () => {
  const dirty = sentryStyleTraceState({
    "sentry.dsc":
      "sentry-trace_id=4bf92f3577b34da6a3ce929d0e0e4736,sentry-public_key=k",
    "sentry.sample_rand": "0.5",
    "sentry.sample_rate": "1",
    "sentry.url": "http://api-internal:1/x",
    "sentry.sampled_not_recording": "1",
    "sentry.ignored": "1",
    "sentry.segment_ignored": "1",
    othervendor: "xyz",
  })
  // Unsanitized control — the C9c corruption mechanism: sentry.dsc's value
  // embeds `=`/`,`, so a compliant re-parse splits it into a grammar-valid
  // junk top-level key while dropping the sentry.* members.
  const corrupted = createTraceState(dirty.serialize())
  assert.equal(corrupted.get("sentry-public_key"), "k")
  const clean = sanitizeTraceState(dirty)
  assert.equal(clean?.serialize(), "othervendor=xyz")
  const reExtracted = createTraceState(clean?.serialize() ?? "")
  assert.equal(reExtracted.serialize(), "othervendor=xyz")
  assert.equal(reExtracted.get("sentry-public_key"), undefined)
})

test("sanitizeTraceState: all-sentry traceState collapses to undefined; absent stays absent", () => {
  const onlySentry = sentryStyleTraceState({ "sentry.sample_rand": "0.5" })
  assert.equal(sanitizeTraceState(onlySentry), undefined)
  assert.equal(sanitizeTraceState(undefined), undefined)
})

// ---------------------------------------------------------------------------
// [D1] sanitized-member wire probe — real Sentry-ON composite, instrumented
// fetch, real HTTP server. The `sanitizedW3C` member below mirrors the exact
// ~2-line composition instrumentation.ts adopts in Phase 1 (§4.A): only the
// W3C member sees the sanitized traceState; SentryPropagator sees the ORIGINAL
// context (it reads sentry.dsc from traceState at inject).
// ---------------------------------------------------------------------------

function sanitizedW3CMember(): TextMapPropagator {
  const w3c = new W3CTraceContextPropagator()
  return {
    inject(ctx: Context, carrier: unknown, setter: TextMapSetter) {
      const sc = trace.getSpanContext(ctx)
      w3c.inject(
        sc
          ? trace.setSpanContext(ctx, {
              ...sc,
              traceState: sanitizeTraceState(sc.traceState),
            })
          : ctx,
        carrier,
        setter
      )
    },
    extract: (ctx: Context, carrier: unknown, getter: TextMapGetter) =>
      w3c.extract(ctx, carrier, getter),
    fields: () => w3c.fields(),
  }
}

const sentryClient = Sentry.init({
  dsn: "https://examplepublickey@o0.ingest.sentry.io/0",
  tracesSampleRate: 1,
  defaultIntegrations: false,
  skipOpenTelemetrySetup: true,
  registerEsmLoaderHooks: false,
  transport: () => ({ send: async () => ({}), flush: async () => true }),
})

const wireExporter = new InMemorySpanExporter()
let server: http.Server
let serverUrl: string
let receivedHeaders: http.IncomingHttpHeaders | undefined

function sentryOnComposite(): TextMapPropagator {
  return new CompositePropagator({
    propagators: [new SentryPropagator(), sanitizedW3CMember()],
  })
}

function setGlobalPropagator(p: TextMapPropagator) {
  propagation.disable()
  assert.ok(propagation.setGlobalPropagator(p))
}

function lastReceivedHeaders(): http.IncomingHttpHeaders {
  assert.ok(receivedHeaders, "echo server saw the request")
  return receivedHeaders
}

before(async () => {
  assert.ok(sentryClient, "Sentry.init must return a client")
  const provider = new BasicTracerProvider({
    sampler: new SentrySampler(sentryClient),
    spanProcessors: [new SimpleSpanProcessor(wireExporter)],
  })
  assert.ok(trace.setGlobalTracerProvider(provider))
  assert.ok(
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable()
    )
  )
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new UndiciInstrumentation()],
  })
  server = http.createServer((req, res) => {
    receivedHeaders = req.headers
    res.end("ok")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as { port: number }
  serverUrl = `http://127.0.0.1:${port}`
})

after(() => {
  server?.close()
})

async function fetchUnderRootSpan(url: string): Promise<void> {
  const tracer = trace.getTracer("wire-probe")
  // Locally-rooted (no remote parent): the sampler seeds a Sentry-class
  // traceState with sentry.sample_rand + sentry.url — the exact members that
  // leak onto internal wires without [D1].
  await tracer.startActiveSpan(
    "root",
    { attributes: { "url.full": url } },
    async (span) => {
      await fetch(url)
      span.end()
    }
  )
}

test("[D1] wire probe: sanitized member keeps sentry.* off the wire; DSC rides sentry-trace/baggage", async () => {
  setGlobalPropagator(
    new FirstPartyOnlyPropagator(sentryOnComposite(), true, EMPTY_ALLOWLIST)
  )
  receivedHeaders = undefined
  await fetchUnderRootSpan(`${serverUrl}/sanitized`)

  const headers = lastReceivedHeaders()
  // (a) no sentry.* tracestate member reaches the wire — here the traceState
  // was all-sentry, so the header must be entirely absent.
  assert.equal(headers.tracestate, undefined)
  // (b) sentry-trace + baggage (with DSC incl. public_key) still present and
  // consistent with traceparent.
  const traceparent = headers.traceparent as string
  const sentryTrace = headers["sentry-trace"] as string
  const baggage = headers.baggage as string
  assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(sentryTrace.split("-")[0], traceparent.split("-")[1])
  assert.equal(sentryTrace.split("-")[1], traceparent.split("-")[2])
  assert.ok(baggage.includes("sentry-public_key=examplepublickey"))
  // (c) an api-side re-extract reconstructs the DSC — SentryPropagator.extract
  // (propagationContextFromHeaders under the hood) reads ONLY sentry-trace/
  // baggage, never the wire tracestate (which is absent here anyway).
  const reExtracted = new SentryPropagator().extract(
    ROOT_CONTEXT,
    { "sentry-trace": sentryTrace, baggage },
    defaultTextMapGetter
  )
  const remote = trace.getSpanContext(reExtracted)
  assert.equal(remote?.traceId, traceparent.split("-")[1])
  assert.ok(
    remote?.traceState
      ?.get("sentry.dsc")
      ?.includes("sentry-public_key=examplepublickey"),
    "DSC must survive the re-extract"
  )
})

test("[D1] wire probe negative control: unsanitized W3C member leaks sentry.* tracestate", async () => {
  // Same harness minus the sanitized member — proves the probe would catch a
  // regression (and reproduces the pre-[D1] leak).
  setGlobalPropagator(
    new FirstPartyOnlyPropagator(
      new CompositePropagator({
        propagators: [new SentryPropagator(), new W3CTraceContextPropagator()],
      }),
      true,
      EMPTY_ALLOWLIST
    )
  )
  receivedHeaders = undefined
  await fetchUnderRootSpan(`${serverUrl}/unsanitized`)
  const tracestate = String(lastReceivedHeaders().tracestate)
  assert.ok(tracestate.includes("sentry.sample_rand="))
  assert.ok(tracestate.includes("sentry.url="))
})

test("[D1] wire probe: vendor tracestate member passes verbatim to a first-party host", async () => {
  setGlobalPropagator(
    new FirstPartyOnlyPropagator(sentryOnComposite(), true, EMPTY_ALLOWLIST)
  )
  // Remote parent carrying a legitimate co-resident vendor member.
  const parentCtx = sentryOnComposite().extract(
    ROOT_CONTEXT,
    { traceparent: REMOTE_TRACEPARENT, tracestate: "othervendor=xyz" },
    defaultTextMapGetter
  )
  receivedHeaders = undefined
  await context.with(parentCtx, () =>
    trace.getTracer("wire-probe").startActiveSpan("parent", async (span) => {
      await fetch(`${serverUrl}/vendor`)
      span.end()
    })
  )
  const headers = lastReceivedHeaders()
  assert.equal(headers.tracestate, "othervendor=xyz")
  assert.equal(
    String(headers.traceparent).split("-")[1],
    "4bf92f3577b34da6a3ce929d0e0e4736"
  )
})

test("third-party destination receives ZERO trace headers under Sentry-on", async () => {
  // Under Sentry-on the wrapper gates sentry-trace + DSC baggage too — today
  // those leak to every third party via default-allow tracePropagationTargets.
  // (The dotted-fake-host-over-loopback variant lives in the P-F probe script,
  // which drives a real socket; here the recording CLIENT span carries the
  // third-party URL and the whole composite must write nothing.)
  const wrapper = new FirstPartyOnlyPropagator(
    sentryOnComposite(),
    true,
    EMPTY_ALLOWLIST
  )
  const span = trace.getTracer("wire-probe").startSpan("client", {
    attributes: { "url.full": "https://api.telegram.org/bot123/getMe" },
  })
  const carrier = injectInto(wrapper, trace.setSpan(ROOT_CONTEXT, span))
  span.end()
  // Nothing: no traceparent, no tracestate, no sentry-trace, no baggage/DSC.
  assert.deepEqual(carrier, {})
})

// ---------------------------------------------------------------------------
// activeTraceCarrier under the global provider
// ---------------------------------------------------------------------------

test("activeTraceCarrier mints {traceparent} with sanitized (here: absent) tracestate", async () => {
  await trace
    .getTracer("wire-probe")
    .startActiveSpan(
      "mint",
      { attributes: { "url.full": "http://127.0.0.1:1/x" } },
      async (span) => {
        // Sentry-ON root span: traceState is all-sentry — the carrier must
        // sanitize it away rather than serialize it.
        const carrier = activeTraceCarrier()
        const sc = span.spanContext()
        assert.deepEqual(carrier, {
          traceparent: `00-${sc.traceId}-${sc.spanId}-01`,
        })
        span.end()
      }
    )
})

test("activeTraceCarrier is undefined outside any span", () => {
  assert.equal(activeTraceCarrier(), undefined)
})
