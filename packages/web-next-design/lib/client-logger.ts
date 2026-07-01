// Browser structured logger for web-next.
//
// Domain-tagged, batches records and ships them to POST /api/v1/logs (same-origin
// via the next rewrites proxy, with the user's session cookie); the server
// re-emits them into the one pino -> Alloy -> Loki stream tagged source="client".
// In dev it also mirrors to the browser console.
//
// The method signatures are CONSOLE-COMPATIBLE (variadic) so call sites migrate
// as a near drop-in rename of `console.*` -> `clientLog.*`. The first string arg
// becomes `msg`; remaining args (and Errors) are serialized into `fields.args`.
//
// This is the logger implementation itself (allowlisted in guard-logging.mjs);
// app code calls createLogger(...) instead of console.*. Redaction is out of
// scope (D3) — do not log secrets/tokens. The server stamps authoritative time.

type Level = "debug" | "info" | "warn" | "error"

interface ClientLogRecord {
  level: Level
  domain: string
  component?: string
  msg: string
  fields?: Record<string, unknown>
}

const ENDPOINT = `${process.env.NEXT_PUBLIC_API_URL || "/api/v1"}/logs`
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
  if (buffer.length === 0 || typeof window === "undefined") return
  const records = buffer.splice(0, buffer.length)
  const body = JSON.stringify({ records })
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: "application/json" })
      )
    } else {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "include",
      })
    }
  } catch {
    /* best-effort: never let logging break the app */
  }
}

function scheduleFlush(): void {
  if (flushTimer || typeof window === "undefined") return
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush)
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush()
  })
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

  if (process.env.NODE_ENV !== "production") {
    const tag = component ? `${domain}.${component}` : domain
    // eslint-disable-next-line no-console
    console[DEV_CONSOLE[level]](`[${tag}]`, ...args)
  }

  buffer.push({ level, domain, component, msg, fields })
  if (buffer.length >= MAX_BUFFER) flush()
  else scheduleFlush()
}

export interface ClientLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Create a domain-tagged browser logger. `scope` is "domain" or
 * "domain.component" (e.g. "web.client", "web.dashboard.im").
 */
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
