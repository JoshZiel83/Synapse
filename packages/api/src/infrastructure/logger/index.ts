// Ensure .env is applied before we read LOG_LEVEL/NODE_ENV below. (ESM runs
// this imported side-effect before the rest of this module evaluates.)
import "../env-bootstrap.js"
import pino from "pino"
import { isSpanContextValid, trace } from "@opentelemetry/api"

/**
 * Process-wide structured logger — the SINGLE pino instance for the whole API.
 *
 * It is the logger for everything that runs OUTSIDE a request (module-load-time
 * config/crypto validation, workers, queue processors, IM connectors, any
 * service code) AND, by being passed to `Fastify({ logger })` in index.ts, it
 * is the request logger too. There is deliberately ONE instance so app logs and
 * request logs never drift in level/format (the previous design had a second,
 * separate pino inside Fastify that ignored LOG_LEVEL).
 *
 * LOG_LEVEL overrides the level; default is "debug" in development and "info"
 * otherwise. We read process.env directly (NOT the typed config) because the
 * config module itself logs through this logger during validation, so this
 * must have no dependency on config — importing config here reintroduces a
 * bootstrap cycle. Do not change this.
 */
const isDev = (process.env.NODE_ENV || "development") === "development"

/**
 * Closed business-domain taxonomy for log identifiers. Every log line carries a
 * `domain` (from this closed set) + optional `component`, so logs are queryable
 * by business area regardless of which module emitted them. The set is
 * intentionally closed: a new `createLogger` scope must map to one of these via
 * SCOPE_TO_DOMAIN below, enforced by scripts/guard-logging.mjs. Roots are
 * module-aligned; cross-cutting infrastructure folds under "infra", and "server"
 * is the HTTP/process root.
 */
export const LOG_DOMAINS = [
  "access",
  "ai",
  "asr",
  "audit",
  "auth",
  "automation",
  "avatar",
  "capabilities",
  "chat",
  "context",
  "devices",
  "documents",
  "embedding",
  "execution",
  "files",
  "im",
  "installer",
  "mcp",
  "memory",
  "model-groups",
  "notifications",
  "ocr",
  "orchestrator",
  "organization",
  "platform",
  "relationship",
  "remote-agent",
  "runtime-authorizations",
  "sandbox",
  "server",
  "session",
  "skills",
  "tasks",
  "transcription",
  "workspace",
  "infra",
] as const

export type LogDomain = (typeof LOG_DOMAINS)[number]

interface DomainScope {
  readonly domain: LogDomain
  readonly component?: string
}

const DOMAIN_SET: ReadonlySet<string> = new Set(LOG_DOMAINS)

/**
 * Authoritative scope -> {domain, component} lookup. The `scope` strings are the
 * historical `createLogger()` identifiers (kept as the ergonomic call surface so
 * call sites don't churn); this table maps each to the closed domain taxonomy.
 * Adding a new `createLogger` scope without a row here is caught by
 * scripts/guard-logging.mjs (so unmapped scopes never ship).
 */
const SCOPE_TO_DOMAIN: Readonly<Record<string, DomainScope>> = {
  ai: { domain: "ai" },
  "ai.sdk": { domain: "ai", component: "sdk" },
  "ai.to-model-messages": { domain: "ai", component: "to-model-messages" },
  "asr.registry": { domain: "asr", component: "registry" },
  audit: { domain: "audit" },
  "auth.better-auth": { domain: "auth", component: "better-auth" },
  "auth-session-registry": { domain: "auth", component: "session-registry" },
  automation: { domain: "automation" },
  "automation.integrations": {
    domain: "automation",
    component: "integrations",
  },
  "automation-execution": { domain: "automation", component: "execution" },
  "automation-scheduler": { domain: "automation", component: "scheduler" },
  capabilities: { domain: "capabilities" },
  "chat.dedup": { domain: "chat", component: "dedup" },
  "chat-push": { domain: "chat", component: "push" },
  config: { domain: "infra", component: "config" },
  crypto: { domain: "infra", component: "crypto" },
  database: { domain: "infra", component: "database" },
  "device-task-sweeper": { domain: "devices", component: "task-sweeper" },
  "documents.facade": { domain: "documents", component: "facade" },
  "documents.llamaparse": { domain: "documents", component: "llamaparse" },
  "documents.local": { domain: "documents", component: "local" },
  "documents.reconciler": { domain: "documents", component: "reconciler" },
  "documents.registry": { domain: "documents", component: "registry" },
  "documents.textin": { domain: "documents", component: "textin" },
  "embedding.facade": { domain: "embedding", component: "facade" },
  "embedding.registry": { domain: "embedding", component: "registry" },
  "embedding.local": { domain: "embedding", component: "local" },
  "embedding.openai-compatible": {
    domain: "embedding",
    component: "openai-compatible",
  },
  events: { domain: "infra", component: "events" },
  execution: { domain: "execution" },
  "file-io": { domain: "files", component: "io" },
  "file-parsing": { domain: "files", component: "parsing" },
  "files.ingest": { domain: "files", component: "ingest" },
  "im.controller": { domain: "im", component: "controller" },
  "im.delivery": { domain: "im", component: "delivery" },
  "im.dingtalk": { domain: "im", component: "dingtalk" },
  "im.dingtalk.outbound": { domain: "im", component: "dingtalk-outbound" },
  "im.qq": { domain: "im", component: "qq" },
  "im.qq.latest-inbound": { domain: "im", component: "qq-latest-inbound" },
  "im.runtime": { domain: "im", component: "runtime" },
  "im.status": { domain: "im", component: "status" },
  "im.telegram": { domain: "im", component: "telegram" },
  "im.wecom": { domain: "im", component: "wecom" },
  "im.whatsapp": { domain: "im", component: "whatsapp" },
  "im.whatsapp_unofficial": {
    domain: "im",
    component: "whatsapp_unofficial",
  },
  "mcp.controller": { domain: "mcp", component: "controller" },
  "mcp.feishu.auth": { domain: "mcp", component: "feishu-auth" },
  "mcp.runtime": { domain: "mcp", component: "runtime" },
  "mcp.service": { domain: "mcp", component: "service" },
  "mcp.stdio": { domain: "mcp", component: "stdio" },
  "mcp.tool-resolver": { domain: "mcp", component: "tool-resolver" },
  memory: { domain: "memory" },
  "memory-indexing": { domain: "memory", component: "indexing" },
  "ocr.facade": { domain: "ocr", component: "facade" },
  "ocr.ppocr": { domain: "ocr", component: "ppocr" },
  "ocr.registry": { domain: "ocr", component: "registry" },
  "ocr.tesseract": { domain: "ocr", component: "tesseract" },
  "outbox-sweeper": { domain: "infra", component: "outbox-sweeper" },
  "remote-agent-delivery-retry": {
    domain: "remote-agent",
    component: "delivery-retry",
  },
  "remote-agent.mcp": { domain: "remote-agent", component: "mcp" },
  "sandbox.adapter-registry": {
    domain: "sandbox",
    component: "adapter-registry",
  },
  "seed-model-groups": { domain: "model-groups", component: "seed" },
  server: { domain: "server" },
  session: { domain: "session" },
  "session.runtime": { domain: "session", component: "runtime" },
  "session-thinking": { domain: "session", component: "thinking" },
  storage: { domain: "infra", component: "storage" },
  "task-projection": { domain: "tasks", component: "projection" },
  "transcription.facade": { domain: "transcription", component: "facade" },
  "transcription.registry": { domain: "transcription", component: "registry" },
  "transcription.sherpa": { domain: "transcription", component: "sherpa" },
  "transcription.whisper": { domain: "transcription", component: "whisper" },
  workspace: { domain: "workspace" },
}

/**
 * Fastify v4's default logger serializers, reproduced here because passing a
 * pre-built pino instance to `Fastify({ logger })` bypasses Fastify's built-in
 * serializer injection — so they must live on the instance or request logs lose
 * their req/res/err shape. (Verbatim from fastify v4.29.x lib/logger.js.)
 */
interface SerializableReq {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, unknown>
  readonly hostname?: string
  readonly ip?: string
  readonly socket?: { readonly remotePort?: number }
}
interface SerializableRes {
  readonly statusCode?: number
}

const serializers = {
  req(req: SerializableReq) {
    return {
      method: req.method,
      url: req.url,
      version: req.headers?.["accept-version"],
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket ? req.socket.remotePort : undefined,
    }
  },
  err: pino.stdSerializers.err,
  res(reply: SerializableRes) {
    return {
      statusCode: reply.statusCode,
    }
  },
}

/**
 * Inject the active OpenTelemetry trace_id/span_id into every log line so logs
 * correlate with traces (Tempo/Sentry) by id. Read LIVE from the active span,
 * so it needs no module patching and works regardless of import order. Emits
 * nothing when there is no active span (startup, workers without a span).
 */
function traceContextMixin(): Record<string, string> {
  const span = trace.getActiveSpan()
  if (!span) return {}
  const sc = span.spanContext()
  if (!isSpanContextValid(sc)) return {}
  return { trace_id: sc.traceId, span_id: sc.spanId }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  mixin: traceContextMixin,
  serializers,
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
})

/**
 * Resolve a scope string to its {domain, component}. Unmapped scopes fall back
 * to a derived domain (or "infra") so logging never breaks at runtime; the guard
 * (scripts/guard-logging.mjs) fails CI before an unmapped scope can ship.
 */
function resolveScope(scope: string): DomainScope {
  const mapped = SCOPE_TO_DOMAIN[scope]
  if (mapped) return mapped
  const root = scope.split(/[.-]/, 1)[0]
  if (DOMAIN_SET.has(root)) {
    const component = scope.slice(root.length + 1)
    return component
      ? { domain: root as LogDomain, component }
      : { domain: root as LogDomain }
  }
  return { domain: "infra", component: scope }
}

/**
 * Create a child logger tagged with the business `domain` (+ optional
 * `component`) derived from `scope`. The `scope` string is retained as a field
 * for grep continuity during migration. Call sites keep their existing
 * `createLogger("im.qq")` ergonomics; the domain taxonomy is applied here.
 */
export function createLogger(scope: string) {
  const { domain, component } = resolveScope(scope)
  return logger.child(
    component ? { domain, component, scope } : { domain, scope }
  )
}
