import type { RemoteMcpProtocol } from "../mcp-remote-client.js"
import { z } from "zod"
import { getAuthSecretSerializer } from "./auth-serializers.js"

/**
 * Remote-MCP entryPoint template engine.
 *
 * Resolves a plugin's entryPoint (a bare URL or a JSON `{url, headers, query,
 * protocol}` blob) into a concrete URL + headers, expanding `${...}` templates
 * against the per-instance config / env / runtime / auth-connection sources.
 *
 * Fail-closed: a `${...}` is required by default — a missing value throws.
 * Use `${source?:...}` to allow an empty value. `${auth:*}` / `${auth_b64:*}`
 * additionally require the referenced auth_connection to be status==="active",
 * so a stale/expired credential is never forwarded.
 *
 * Pure (no redis/db); unit-tested in entrypoint.test.ts.
 */

export type TemplateContext = {
  config: Record<string, unknown>
  runtime: Record<string, unknown>
}

export type ResolvedRemoteEntryPoint = {
  url: string
  headers: Record<string, string>
  protocol: RemoteMcpProtocol
}

export class TemplateResolutionError extends Error {}

const RemoteEntryPointJsonSchema = z
  .object({
    url: z.string().optional(),
    endpoint: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    protocol: z.enum(["sse", "streamable-http"]).optional(),
  })
  .passthrough()

type RemoteEntryPointJson = z.infer<typeof RemoteEntryPointJsonSchema>

export function getConfigValue(
  config: Record<string, unknown>,
  pathExpression: string
): unknown {
  const pathParts = pathExpression.split(".").filter(Boolean)
  let current: unknown = config
  for (const segment of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return JSON.stringify(value)
}

function getAuthConnection(
  field: string,
  ctx: TemplateContext
): Record<string, unknown> {
  const conn = getConfigValue(ctx.config, field)
  if (!conn || typeof conn !== "object" || Array.isArray(conn)) {
    throw new TemplateResolutionError(
      `Auth connection '${field}' is not configured`
    )
  }
  const obj = conn as Record<string, unknown>
  if (obj.status !== "active") {
    // Fail-closed: never forward a stale/expired credential.
    throw new TemplateResolutionError(
      `Auth connection '${field}' is not active (status=${String(obj.status)})`
    )
  }
  return obj
}

function resolveAuthExpression(
  rest: string,
  ctx: TemplateContext
): string | undefined {
  const dot = rest.indexOf(".")
  const field = dot === -1 ? rest : rest.slice(0, dot)
  const path = dot === -1 ? "" : rest.slice(dot + 1)
  const conn = getAuthConnection(field, ctx)
  const secret = conn.secretPayload
  if (!secret || typeof secret !== "object") return undefined
  const value = path
    ? getConfigValue(secret as Record<string, unknown>, path)
    : secret
  if (value === undefined || value === null) return undefined
  return stringifyTemplateValue(value)
}

function resolveAuthB64Expression(
  field: string,
  ctx: TemplateContext
): string | undefined {
  const conn = getAuthConnection(field, ctx)
  let secret = conn.secretPayload
  if (!secret || typeof secret !== "object") return undefined
  // Per-driver serializer hook: lets a plugin (e.g. Mijia) transform the stored
  // internal secret into the exact shape its sidecar expects before encoding.
  const serializer = getAuthSecretSerializer(
    typeof conn.driver === "string" ? conn.driver : undefined
  )
  if (serializer) {
    secret = serializer(secret as Record<string, unknown>)
  }
  return Buffer.from(JSON.stringify(secret), "utf-8").toString("base64")
}

/**
 * Resolve a `${...}` expression. Returns `undefined` when the source resolves
 * to a missing value so the caller can decide required (throw) vs optional.
 *
 * Sources: `${config:a.b}`, `${env:NAME}`, `${runtime:key}`,
 * `${auth:field.path}` (secretPayload implicit), `${auth_b64:field}`.
 * Optional variants `${source?:...}` allow empty.
 */
function resolveTemplateExpression(
  expression: string,
  ctx: TemplateContext
): { value: string | undefined; optional: boolean } {
  const optional = /^(config|env|runtime|auth|auth_b64)\?:/.test(expression)
  const normalized = optional ? expression.replace("?:", ":") : expression

  if (normalized.startsWith("env:")) {
    const v = process.env[normalized.slice(4)]
    return { value: v === undefined || v === "" ? undefined : v, optional }
  }
  if (normalized.startsWith("runtime:")) {
    const v = ctx.runtime[normalized.slice(8)]
    return { value: v ? String(v) : undefined, optional }
  }
  if (normalized.startsWith("config:")) {
    const raw = getConfigValue(ctx.config, normalized.slice(7))
    if (raw === undefined || raw === null) return { value: undefined, optional }
    // boolean false / number 0 are present values, not "missing".
    return { value: stringifyTemplateValue(raw), optional }
  }
  if (normalized.startsWith("auth:")) {
    return { value: resolveAuthExpression(normalized.slice(5), ctx), optional }
  }
  if (normalized.startsWith("auth_b64:")) {
    return {
      value: resolveAuthB64Expression(normalized.slice(9), ctx),
      optional,
    }
  }
  return { value: undefined, optional }
}

/**
 * Render a template string. Each `${...}` is required by default — a missing
 * value throws (fail-closed). Use `${source?:...}` to allow an empty value.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, rawExpression: string) => {
    const expression = rawExpression.trim()
    const { value, optional } = resolveTemplateExpression(expression, ctx)
    if (value === undefined) {
      if (optional) return ""
      throw new TemplateResolutionError(
        `Required template value '${expression}' could not be resolved`
      )
    }
    return value
  })
}

function parseRemoteEntryPointJson(raw: string): RemoteEntryPointJson {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid remote MCP entry point JSON: ${(error as Error).message}`
    )
  }

  const parsed = RemoteEntryPointJsonSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("Remote MCP entry point JSON has invalid shape")
  }
  return parsed.data
}

function isJsonEntryPointValue(raw: string): boolean {
  return (
    raw.startsWith("{") ||
    raw.startsWith("[") ||
    raw.startsWith('"') ||
    raw === "null" ||
    raw === "true" ||
    raw === "false"
  )
}

function parseRemoteEntryPointUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("Remote MCP entry point URL is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote MCP entry point URL must use http or https")
  }
  return url
}

/**
 * Resolve a remote (http/sse) plugin entryPoint into a concrete URL + headers.
 *
 * entryPoint may be a bare URL string OR a JSON object:
 *   { url|endpoint, headers?, query?, protocol? }
 * All url/header/query values run through the template engine. `query` keys are
 * injected via URL.searchParams.set (correct encoding; e.g. AMap `?key=`).
 */
export function resolveRemoteEntryPoint(
  entryPoint: string,
  ctx: TemplateContext,
  defaultProtocol: RemoteMcpProtocol
): ResolvedRemoteEntryPoint {
  const trimmed = entryPoint.trim()
  if (!trimmed) {
    throw new Error("Remote MCP entry point is required")
  }

  if (!isJsonEntryPointValue(trimmed)) {
    const url = parseRemoteEntryPointUrl(renderTemplate(trimmed, ctx))
    return {
      url: url.toString(),
      headers: {},
      protocol: defaultProtocol,
    }
  }

  const parsed = parseRemoteEntryPointJson(trimmed)
  let baseUrl = ""
  if (parsed.url !== undefined) {
    baseUrl = renderTemplate(parsed.url, ctx)
  } else if (parsed.endpoint !== undefined) {
    baseUrl = renderTemplate(parsed.endpoint, ctx)
  }
  if (!baseUrl) {
    throw new Error("Remote MCP entry point JSON is missing url")
  }
  const url = parseRemoteEntryPointUrl(baseUrl)

  const headers: Record<string, string> = parsed.headers
    ? Object.fromEntries(
        Object.entries(parsed.headers).map(([key, value]) => [
          key,
          renderTemplate(value, ctx),
        ])
      )
    : {}

  if (parsed.query) {
    for (const [key, value] of Object.entries(parsed.query)) {
      url.searchParams.set(key, renderTemplate(value, ctx))
    }
  }

  const protocol: RemoteMcpProtocol = parsed.protocol ?? defaultProtocol

  return { url: url.toString(), headers, protocol }
}

/** Strip secret-bearing query params before logging an endpoint URL. */
export function redactUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const SENSITIVE = new Set(["key", "token", "sig", "secret", "apikey"])
    let redacted = false
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE.has(name.toLowerCase())) {
        url.searchParams.set(name, "***")
        redacted = true
      }
    }
    return redacted ? url.toString() : rawUrl
  } catch {
    return rawUrl
  }
}
