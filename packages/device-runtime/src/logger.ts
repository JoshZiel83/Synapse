import { nowIsoInstant } from "@synapse/shared/datetime"
import type { RuntimeLogger } from "./types.js"

/**
 * The single device-runtime logger.
 *
 * Replaces the three duplicate console-backed logger shapes that used to live in
 * runtime.ts / builtins/chrome-devtools-mcp.ts / builtins/fs-helper-client.ts.
 * There is now ONE structured logger; do not reintroduce a parallel one.
 *
 * Writes NDJSON to STDERR only — stdout is reserved for the CLI result channel
 * (bin.ts prints machine-readable pair/status/rekey JSON there) and, for
 * sidecars, the JSON-RPC line protocol. A zero-dependency implementation
 * (no pino) keeps this published bin's install surface unchanged.
 *
 * Level via SYNAPSE_DEVICE_LOG_LEVEL (debug|info|warn|error, default info).
 * If a trace context was injected by a parent at spawn (SYNAPSE_TRACEPARENT /
 * W3C `traceparent`), it is echoed on every line so device logs correlate.
 */
type Level = "debug" | "info" | "warn" | "error"

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function resolveLevel(): Level {
  const raw = (process.env.SYNAPSE_DEVICE_LOG_LEVEL || "").toLowerCase()
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info"
}

const activeLevel = resolveLevel()
const traceparent =
  process.env.SYNAPSE_TRACEPARENT || process.env.TRACEPARENT || undefined

// --- optional remote shipping (device log回传 to POST <api>/api/v1/logs) ---
// Configured by runtime.ts after a successful control-plane hello, using the
// short-lived `log_ingest_token` from the hello ack. Records are STILL written
// to stderr (local); shipping is an ADDITIONAL sink, never a replacement. Fully
// best-effort — must never disrupt the runtime.
let shipEndpoint: string | null = null
let shipToken: string | null = null
const shipBuffer: Array<Record<string, unknown>> = []
let shipTimer: ReturnType<typeof setTimeout> | null = null
const SHIP_MAX = 50
const SHIP_INTERVAL_MS = 5_000

/** Enable (or, with null, disable) device log shipping. */
export function configureDeviceLogShipping(
  config: { endpoint: string; token: string } | null
): void {
  shipEndpoint = config?.endpoint ?? null
  shipToken = config?.token ?? null
}

function flushShip(): void {
  if (shipTimer) {
    clearTimeout(shipTimer)
    shipTimer = null
  }
  if (!shipEndpoint || !shipToken || shipBuffer.length === 0) return
  const records = shipBuffer.splice(0, shipBuffer.length)
  let body: string
  try {
    body = JSON.stringify({ records })
  } catch {
    return
  }
  void fetch(shipEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${shipToken}`,
    },
    body,
  }).catch(() => {
    /* best-effort: device回传 must never disrupt the runtime */
  })
}

function scheduleShip(): void {
  if (shipTimer) return
  shipTimer = setTimeout(flushShip, SHIP_INTERVAL_MS)
  // Never keep the process alive just to flush logs.
  if (typeof shipTimer.unref === "function") shipTimer.unref()
}

function maybeShip(record: Record<string, unknown>): void {
  if (!shipEndpoint || !shipToken) return
  // Map the device record onto the ingest RecordSchema. service -> domain;
  // traceparent -> trace_id (server re-emits it as clientTraceId).
  const {
    time,
    level,
    service,
    component,
    msg,
    traceparent: tp,
    ...rest
  } = record
  let traceId: string | undefined
  if (typeof tp === "string") {
    // W3C traceparent is version-traceid-spanid-flags; ship just the trace-id so
    // it joins cleanly against the server/Tempo trace_id.
    const parts = tp.split("-")
    traceId = parts.length === 4 && parts[1] ? parts[1] : tp
  }
  shipBuffer.push({
    level,
    domain: service,
    component,
    msg,
    time,
    trace_id: traceId,
    fields: Object.keys(rest).length > 0 ? rest : undefined,
  })
  if (shipBuffer.length >= SHIP_MAX) flushShip()
  else scheduleShip()
}

function emit(
  level: Level,
  component: string,
  message: string,
  data?: Record<string, unknown>
): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[activeLevel]) return
  // Caller data is spread FIRST so the fixed/trusted fields below always win —
  // a caller can't clobber level/service/msg/traceparent.
  const record: Record<string, unknown> = {
    ...(data ?? {}),
    time: nowIsoInstant(),
    level,
    service: "device-runtime",
    component,
    msg: message,
  }
  if (traceparent) record.traceparent = traceparent
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    line = JSON.stringify({
      time: nowIsoInstant(),
      level,
      service: "device-runtime",
      component,
      msg: message,
      dataError: "unserializable",
    })
  }
  process.stderr.write(`${line}\n`)
  maybeShip(record)
}

/**
 * Create the device-runtime logger for a component (e.g. "runtime", "fs-helper",
 * "chrome-devtools-mcp", "sidecar"). The returned object satisfies
 * `RuntimeLogger` so it drops into every existing `opts.logger` slot.
 */
export function createDeviceLogger(
  component: string
): RuntimeLogger & {
  debug(message: string, data?: Record<string, unknown>): void
} {
  return {
    debug: (m, d) => emit("debug", component, m, d),
    info: (m, d) => emit("info", component, m, d),
    warn: (m, d) => emit("warn", component, m, d),
    error: (m, d) => emit("error", component, m, d),
  }
}
