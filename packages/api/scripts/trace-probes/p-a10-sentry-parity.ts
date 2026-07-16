// P-A10 — Phase-1 gate probe (§6 "Sentry-on/off Tempo parity", invariant I1):
// OTLP span volume/coverage must be identical whether SENTRY_DSN is set or
// not, modulo the Sentry-side machinery. Boots the REAL instrumentation
// (src/instrumentation.boot-probe.ts) against a local OTLP catcher and
// DECODES the protobuf (trace id / scope / name / kind per span):
//
//   Case A (request path, the I1 acceptance diff from §4.A verification):
//     Sentry OFF vs ON(rate 0) vs ON(rate 1) — EXACT span-multiset equality,
//     equal span volume, equal distinct-trace count. rate 1 additionally
//     proves the SentrySpanProcessor was live (transactions forwarded) and
//     that forwarding changed NOTHING on the OTLP side.
//
//   Case B (error path): EXACT parity here too. The §4.A [adj 7] house
//     onError hook registers UNCONDITIONALLY (only the capture inside is
//     gated on the Sentry client), so the "@fastify/otel onError" INTERNAL
//     hook span appears in BOTH configs — pinned to exactly one per
//     error-throwing request on each side (non-vacuity: the hook is present
//     and instrumented, not merely absent from both). Any sampling loss /
//     dropped instrumentation / extra Sentry spans breaks the multiset diff.
import {
  check,
  finish,
  runBootProbe,
  startOtlpCatcher,
  startSentryCatcher,
} from "./_shared.js"

// --- minimal protobuf TLV walker (OTLP ExportTraceServiceRequest) -----------

interface Field {
  no: number
  bytes?: Buffer
  varint?: bigint
}

function walk(buf: Buffer): Field[] {
  const out: Field[] = []
  let i = 0
  const varint = (): bigint => {
    let v = 0n
    let s = 0n
    for (;;) {
      const b = buf[i++]!
      v |= BigInt(b & 0x7f) << s
      if ((b & 0x80) === 0) return v
      s += 7n
    }
  }
  while (i < buf.length) {
    const tag = varint()
    const no = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) out.push({ no, varint: varint() })
    else if (wire === 2) {
      const len = Number(varint())
      out.push({ no, bytes: buf.subarray(i, i + len) })
      i += len
    } else if (wire === 5) {
      out.push({ no, bytes: buf.subarray(i, i + 4) })
      i += 4
    } else if (wire === 1) {
      out.push({ no, bytes: buf.subarray(i, i + 8) })
      i += 8
    } else throw new Error(`unexpected wire type ${wire}`)
  }
  return out
}

interface DecodedSpan {
  traceId: string
  key: string // "scope|name|kind" — the shape identity used for the diff
}

function decodeSpans(posts: Buffer[]): DecodedSpan[] {
  const out: DecodedSpan[] = []
  for (const post of posts) {
    for (const rs of walk(post).filter((f) => f.no === 1)) {
      for (const ss of walk(rs.bytes!).filter((f) => f.no === 2)) {
        const fields = walk(ss.bytes!)
        const scopeField = fields.find((f) => f.no === 1)
        const scope = scopeField
          ? (walk(scopeField.bytes!)
              .find((f) => f.no === 1)
              ?.bytes?.toString("utf8") ?? "?")
          : "?"
        for (const sp of fields.filter((f) => f.no === 2)) {
          const s = walk(sp.bytes!)
          const traceId =
            s.find((f) => f.no === 1)?.bytes?.toString("hex") ?? "?"
          const name = s.find((f) => f.no === 5)?.bytes?.toString("utf8") ?? "?"
          const kind = s.find((f) => f.no === 6)?.varint ?? 0n
          out.push({ traceId, key: `${scope}|${name}|kind=${kind}` })
        }
      }
    }
  }
  return out
}

function multiset(spans: DecodedSpan[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of spans) m.set(s.key, (m.get(s.key) ?? 0) + 1)
  return m
}

/** Multiset diff b - a (added) and a - b (removed), as printable entries. */
function diff(
  a: Map<string, number>,
  b: Map<string, number>
): { added: string[]; removed: string[] } {
  const added: string[] = []
  const removed: string[] = []
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(key) ?? 0) - (a.get(key) ?? 0)
    for (let i = 0; i < d; i++) added.push(key)
    for (let i = 0; i < -d; i++) removed.push(key)
  }
  return { added: added.sort(), removed: removed.sort() }
}

// --- runner ------------------------------------------------------------------

interface RunSummary {
  name: string
  spans: DecodedSpan[]
  traceCount: number
  transactions: number
  errorEvents: number
}

async function runCase(
  name: string,
  sentry: "off" | "rate0" | "rate1",
  errorRoutes: boolean
): Promise<RunSummary> {
  const otlp = await startOtlpCatcher()
  const sentryCatcher =
    sentry === "off" ? undefined : await startSentryCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${otlp.url}/v1/traces`,
    BOOT_PROBE_ERROR_ROUTES: errorRoutes ? "1" : "",
    ...(sentryCatcher
      ? {
          SENTRY_DSN: sentryCatcher.dsn,
          SENTRY_TRACES_SAMPLE_RATE: sentry === "rate1" ? "1" : "0",
        }
      : {}),
  })
  check(`${name}: child exits 0 + BOOT_OK`, run.code === 0 && run.bootOk, {
    code: run.code,
    stderr: run.stderr.slice(-800),
  })
  const spans = decodeSpans(otlp.posts)
  const summary: RunSummary = {
    name,
    spans,
    traceCount: new Set(spans.map((s) => s.traceId)).size,
    transactions: sentryCatcher?.itemsOfType("transaction").length ?? 0,
    errorEvents: sentryCatcher?.itemsOfType("event").length ?? 0,
  }
  await otlp.close()
  await sentryCatcher?.close()
  return summary
}

// --- Case A: request path — EXACT parity -------------------------------------

const aOff = await runCase("A off", "off", false)
const aRate0 = await runCase("A on(rate0)", "rate0", false)
const aRate1 = await runCase("A on(rate1)", "rate1", false)

check("A: spans exported at all", aOff.spans.length > 0, aOff.spans.length)
for (const on of [aRate0, aRate1]) {
  const d = diff(multiset(aOff.spans), multiset(on.spans))
  check(
    `A: EXACT span-multiset parity off vs ${on.name} (volume ${aOff.spans.length})`,
    d.added.length === 0 && d.removed.length === 0,
    d
  )
  check(
    `A: distinct-trace count parity off vs ${on.name}`,
    aOff.traceCount === on.traceCount,
    { off: aOff.traceCount, on: on.traceCount }
  )
}
check(
  "A: rate 0 forwards ZERO Sentry transactions [D4]",
  aRate0.transactions === 0,
  aRate0.transactions
)
check(
  "A: rate 1 forwards transactions (SentrySpanProcessor provably live)",
  aRate1.transactions > 0,
  aRate1.transactions
)

// --- Case B: error path — EXACT parity; hook spans present in BOTH configs ---

const bOff = await runCase("B off", "off", true)
const bOn = await runCase("B on(rate1)", "rate1", true)

const HOOK_SPAN = "@fastify/otel|onError - fastify -> @fastify/otel|kind=1"
const hookCount = (s: RunSummary) =>
  s.spans.filter((sp) => sp.key === HOOK_SPAN).length
const bDiff = diff(multiset(bOff.spans), multiset(bOn.spans))
check(
  `B: EXACT span-multiset parity off vs on on the error path (I1; volume ${bOff.spans.length})`,
  bDiff.added.length === 0 && bDiff.removed.length === 0,
  bDiff
)
check(
  "B: house onError hook span present in BOTH configs (1 per error request — the hook registers unconditionally)",
  hookCount(bOff) === 2 && hookCount(bOn) === 2,
  { off: hookCount(bOff), on: hookCount(bOn) }
)
check(
  "B: distinct-trace count parity (hook spans join existing traces, no new roots)",
  bOff.traceCount === bOn.traceCount,
  { off: bOff.traceCount, on: bOn.traceCount }
)
check(
  "B: /boom captured Sentry-side, expected-400 gated (exactly 1 error event)",
  bOn.errorEvents === 1,
  bOn.errorEvents
)

finish("P-A10")
