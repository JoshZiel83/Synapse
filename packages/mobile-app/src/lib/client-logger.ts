// Structured logger for the mobile app (native + react-native-web).
//
// Domain-tagged, batches records and ships them to POST <api>/api/v1/logs with
// the user's session (Bearer on native, cookie on web), where the server
// re-emits them into the one pino -> Alloy -> Loki stream tagged source="client".
// In __DEV__ it also mirrors to the console. Crash/error capture is separately
// handled by Sentry (app/_layout.tsx) — this is for structured operational logs.
//
// Console-compatible (variadic) signatures so call sites migrate as a near
// drop-in rename of console.* -> clientLog.*. Allowlisted in guard-logging.mjs.
// Redaction out of scope (D3); never log secrets/tokens.
//
// Trace ids are captured at EMIT time, never at flush (by the 5s flush the
// Sentry scope/span has moved on). `trace_id` is the field the ingest
// RecordSchema already accepts and re-emits as `clientTraceId`; absent when no
// Sentry client is configured.
import { getApiAuthToken } from "@/lib/api"
import { getApiBase } from "@/lib/config"
import { currentClientTraceId } from "@/lib/client-trace"

type Level = "debug" | "info" | "warn" | "error"

interface ClientLogRecord {
  level: Level
  domain: string
  component?: string
  msg: string
  fields?: Record<string, unknown>
  trace_id?: string
}

const MAX_BUFFER = 100
const FLUSH_INTERVAL_MS = 5_000

const buffer: ClientLogRecord[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function serializeArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { name: arg.name, message: arg.message, stack: arg.stack }
  }
  return arg
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buffer.length === 0) return
  const records = buffer.splice(0, buffer.length)
  let body: string
  let endpoint: string
  try {
    body = JSON.stringify({ records })
    // getApiBase() ends in /api/v1 (and throws if EXPO_PUBLIC_API_URL unset) —
    // resolveApiUrl("/logs") would strip the base path to just the origin (404).
    endpoint = `${getApiBase()}/logs`
  } catch {
    return
  }
  const token = getApiAuthToken()
  void fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
    credentials: "include",
  }).catch(() => {
    /* best-effort: logging must never break the app */
  })
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
  const t = flushTimer as { unref?: () => void }
  if (typeof t.unref === "function") t.unref()
}

const DEV_CONSOLE: Record<Level, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
}

function emit(
  level: Level,
  domain: string,
  component: string | undefined,
  args: unknown[]
): void {
  let msg = ""
  const fieldArgs: unknown[] = []
  if (args.length > 0) {
    const [first, ...rest] = args
    if (typeof first === "string") {
      msg = first
      fieldArgs.push(...rest)
    } else if (first instanceof Error) {
      msg = first.message
      fieldArgs.push(first, ...rest)
    } else {
      msg = safeString(first)
      fieldArgs.push(...rest)
    }
  }
  const fields =
    fieldArgs.length > 0 ? { args: fieldArgs.map(serializeArg) } : undefined

  if (typeof __DEV__ !== "undefined" && __DEV__) {
    const tag = component ? `${domain}.${component}` : domain
    // eslint-disable-next-line no-console
    console[DEV_CONSOLE[level]](`[${tag}]`, ...args)
  }

  const traceId = currentClientTraceId()
  buffer.push({
    level,
    domain,
    component,
    msg,
    fields,
    ...(traceId ? { trace_id: traceId } : {}),
  })
  if (buffer.length >= MAX_BUFFER) flush()
  else scheduleFlush()
}

export interface ClientLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Create a domain-tagged mobile logger. `scope` is "domain" or "domain.component". */
export function createLogger(scope: string): ClientLogger {
  const dot = scope.indexOf(".")
  const domain = dot === -1 ? scope : scope.slice(0, dot)
  const component = dot === -1 ? undefined : scope.slice(dot + 1)
  return {
    debug: (...args: unknown[]) => emit("debug", domain, component, args),
    info: (...args: unknown[]) => emit("info", domain, component, args),
    warn: (...args: unknown[]) => emit("warn", domain, component, args),
    error: (...args: unknown[]) => emit("error", domain, component, args),
  }
}
