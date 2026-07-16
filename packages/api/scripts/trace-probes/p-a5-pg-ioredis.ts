// P-A5 (pg + ioredis instrumentation) — §7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md.
// Registers PgInstrumentation/IORedisInstrumentation at §4.A's exact pins
// (0.71.0 / 0.67.0, deduping to the hoisted @opentelemetry/instrumentation
// 0.219.0) against LIVE Postgres + Redis (repo .env), asserting:
//   - client spans appear UNDER a parent span;
//   - requireParentSpan:true keeps parentless work span-free (the BullMQ
//     polling equivalence);
//   - the value-safe redis serializer truncates EVAL args while the installed
//     DEFAULT serializer provably leaks them (BullMQ job payloads, §5.7).
// The REAL wiring's serializer + config values are imported from
// instrumentation.ts (loaded inert under OTEL_SDK_DISABLED so this probe owns
// its own provider).
// Run: npx tsx scripts/trace-probes/p-a5-pg-ioredis.ts
import { check, finish } from "./_shared.js"

process.env.OTEL_SDK_DISABLED = "true"
process.env.SENTRY_DSN = ""
const { valueSafeRedisSerializer } =
  await import("../../src/instrumentation.js")

import { context, trace, type Span } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { defaultDbStatementSerializer } from "@opentelemetry/redis-common"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base"
import { createRequire } from "node:module"

// Exact-pin sanity: both packages must resolve to the pinned versions and
// dedupe onto the hoisted instrumentation 0.219.0 line.
const require = createRequire(import.meta.url)
const pgVersion = (
  require("@opentelemetry/instrumentation-pg/package.json") as {
    version: string
  }
).version
const ioredisVersion = (
  require("@opentelemetry/instrumentation-ioredis/package.json") as {
    version: string
  }
).version
check("instrumentation-pg pinned at 0.71.0", pgVersion === "0.71.0", pgVersion)
check(
  "instrumentation-ioredis pinned at 0.67.0",
  ioredisVersion === "0.67.0",
  ioredisVersion
)

const exporter = new InMemorySpanExporter()
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
})
trace.setGlobalTracerProvider(provider)
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [
    // §4.A's exact configs.
    new PgInstrumentation({
      requireParentSpan: true,
      ignoreConnectSpans: true,
    }),
    new IORedisInstrumentation({
      requireParentSpan: true,
      dbStatementSerializer: valueSafeRedisSerializer,
    }),
  ],
})

// Instrumented modules must load AFTER registerInstrumentations, THROUGH the
// CJS require hook: a plain ESM `import` of these CJS packages bypasses
// require-in-the-middle on Node 22 — the exact seam instrumentation.ts closes
// with its own forced requires (this probe pins both the bypass and the fix).
const unpatchedRedis = (await import("ioredis")).default
check(
  "ESM import alone does NOT activate the ioredis patch (the RITM bypass)",
  (unpatchedRedis.prototype.sendCommand as { __wrapped?: boolean })
    .__wrapped !== true
)
const PgClient = (require("pg") as typeof import("pg")).Client
const Redis = require("ioredis") as typeof import("ioredis").default
check(
  "forced CJS require activates the ioredis patch on the SHARED prototype",
  (Redis.prototype.sendCommand as unknown as { __wrapped?: boolean })
    .__wrapped === true && Redis === (unpatchedRedis as unknown)
)

const databaseUrl = process.env.DATABASE_URL
const redisUrl = process.env.REDIS_URL
if (!databaseUrl || !redisUrl) {
  console.error("DATABASE_URL / REDIS_URL missing — repo .env not loaded?")
  process.exit(1)
}

const pg = new PgClient({ connectionString: databaseUrl })
await pg.connect()
const redis = new Redis(redisUrl)

const finished = (): ReadableSpan[] => exporter.getFinishedSpans()
const tracer = trace.getTracer("p-a5")

// --- parentless work is span-free (requireParentSpan) ------------------------
exporter.reset()
await pg.query("SELECT 1")
await redis.set("pa5:plain", "x")
check(
  "parentless pg/redis work emits ZERO spans (requireParentSpan)",
  finished().length === 0,
  finished().map((s) => s.name)
)

// --- under a parent: client spans appear as children -------------------------
exporter.reset()
const SECRET = "pa5-super-secret-job-payload"
let parentSpanId = ""
await tracer.startActiveSpan("pa5-parent", async (parent: Span) => {
  parentSpanId = parent.spanContext().spanId
  await pg.query("SELECT 2")
  await redis.eval("return ARGV[1]", 0, SECRET)
  parent.end()
})
const spans = finished()
const pgSpan = spans.find((s) => s.instrumentationScope.name.includes("pg"))
const redisSpan = spans.find((s) =>
  s.instrumentationScope.name.includes("ioredis")
)
check("pg client span exported under the parent", pgSpan !== undefined)
check(
  "pg span parented correctly",
  pgSpan?.parentSpanContext?.spanId === parentSpanId,
  pgSpan?.parentSpanContext
)
check("redis client span exported under the parent", redisSpan !== undefined)
check(
  "redis span parented correctly",
  redisSpan?.parentSpanContext?.spanId === parentSpanId,
  redisSpan?.parentSpanContext
)

// --- value-safe serializer on the wire ---------------------------------------
const statement = String(redisSpan?.attributes["db.statement"] ?? "")
check(
  "EVAL args truncated: secret payload NOT in db.statement",
  statement.length > 0 && !statement.includes(SECRET),
  statement
)
check(
  "serialized form keeps command + script + arg count",
  /^eval return ARGV\[1\] \[2 more args\]$/.test(statement),
  statement
)

// --- the installed default serializer provably leaks -------------------------
const defaultSerialized = defaultDbStatementSerializer("eval", [
  "return ARGV[1]",
  0,
  SECRET,
])
check(
  "installed DEFAULT serializer leaks the EVAL payload (the §5.7 bug)",
  defaultSerialized.includes(SECRET),
  defaultSerialized
)

// --- credential commands: command name only ----------------------------------
check(
  "AUTH serializes to command only",
  valueSafeRedisSerializer("auth", ["user", "hunter2"]) === "auth"
)
check(
  "HELLO serializes to command only",
  valueSafeRedisSerializer("hello", ["3", "AUTH", "user", "hunter2"]) ===
    "hello"
)

redis.disconnect()
await pg.end()
finish("P-A5")
