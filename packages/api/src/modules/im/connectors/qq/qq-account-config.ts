/**
 * QQ account.config zod schema + read helper.
 *
 * `transport_accounts.config` is a free-form jsonb column. Connector
 * code that reads boolean flags from it should NEVER do truthy checks
 * (a stored string `"false"` would silently parse as `true`).
 * `readQqAccountConfig` validates the shape with zod and returns a
 * strongly typed record with explicit defaults.
 *
 * Rejection vs default behavior:
 *   - Unknown keys are passed through (zod default is .strip → ignore).
 *   - Wrong-typed required-with-default keys raise a parse error so the
 *     operator notices misconfiguration immediately rather than getting
 *     silent fallbacks.
 *   - Missing optional keys default to safe values (false / []).
 *
 * Stage 2 fields:
 *   - `webhookInboundConfirmed` (default false) — gate flipped by the
 *     operator after sandbox-verifying that webhook accounts actually
 *     receive C2C/GROUP_AT events (OQ2). When false, the inbound
 *     handler short-circuits op=0 dispatch to log-only.
 *   - `configuredUrlDomains` (default []) — list of hostnames the
 *     operator has registered in the QQ console's
 *     "消息URL配置" page. Outbound messages whose text contains a URL
 *     are validated against this list to fail-loud BEFORE consuming
 *     the per-anchor reply quota (Stage 4 enforces).
 *   - `allowProactiveBestEffort` (default false) — deprecated; v1 keeps
 *     the field for forward-compat but the connector never calls the
 *     dead proactive API. Used by the UI for the "you can opt into a
 *     no-op" toggle so config import doesn't drop a populated value.
 *
 * NOT in this schema (lives in credentials):
 *   - botSecret, clientSecret, appId
 */

import { z } from "zod"

const HOSTNAME_PATTERN =
  // RFC 1035-ish lowercase hostname, allow IDNA punycode (xn--), no
  // wildcard, no scheme, no path. Server-side normalization (below)
  // already strips path/scheme; this is a final shape check.
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

const HostnameSchema = z
  .string()
  .min(1)
  .refine((s) => HOSTNAME_PATTERN.test(s), {
    message: "hostname must be lowercase domain (no scheme/path/wildcard)",
  })
  .refine((s) => !IPV4_PATTERN.test(s), {
    message: "hostname must not be a bare IPv4 address",
  })

export const QqAccountConfigSchema = z
  .object({
    webhookInboundConfirmed: z.boolean().default(false),
    allowProactiveBestEffort: z.boolean().default(false),
    configuredUrlDomains: z.array(HostnameSchema).default([]),
  })
  // Use `.passthrough` so unknown fields the dashboard might add later
  // don't fail validation here — only the typed surface is what
  // connector code can trust.
  .passthrough()

export type QqAccountConfig = z.infer<typeof QqAccountConfigSchema>

/**
 * Normalize a raw config record into the strict QqAccountConfig shape.
 * Throws on shape errors (operator-visible). Use this from any code
 * path that needs to check a config flag.
 *
 * Server-side host normalization for `configuredUrlDomains`:
 *   - lowercase
 *   - strip "http(s)://" prefix if accidentally included
 *   - strip path / query / fragment
 *   - strip port
 *   - drop empties
 *   - dedupe
 *   - reject wildcards (`*`, `*.foo`) and bare IPs (validated by HostnameSchema)
 */
export function normalizeQqAccountConfig(
  raw: Record<string, unknown> | null | undefined
): QqAccountConfig {
  const value = raw && typeof raw === "object" ? { ...raw } : {}
  if (
    Array.isArray(
      (value as { configuredUrlDomains?: unknown }).configuredUrlDomains
    )
  ) {
    const normalized = (
      value as { configuredUrlDomains: unknown[] }
    ).configuredUrlDomains
      .map(normalizeHostInput)
      .filter((h): h is string => !!h)
    // De-dup, stable order.
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const h of normalized) {
      if (!seen.has(h)) {
        seen.add(h)
        deduped.push(h)
      }
    }
    ;(value as { configuredUrlDomains: string[] }).configuredUrlDomains =
      deduped
  }
  return QqAccountConfigSchema.parse(value)
}

function normalizeHostInput(input: unknown): string | null {
  if (typeof input !== "string") return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  // Strip scheme if present
  s = s.replace(/^[a-z][a-z0-9+\-.]*:\/\//, "")
  // Strip path / query / fragment
  const slashAt = s.indexOf("/")
  if (slashAt >= 0) s = s.slice(0, slashAt)
  const queryAt = s.indexOf("?")
  if (queryAt >= 0) s = s.slice(0, queryAt)
  const fragAt = s.indexOf("#")
  if (fragAt >= 0) s = s.slice(0, fragAt)
  // Strip port
  const colonAt = s.indexOf(":")
  if (colonAt >= 0) s = s.slice(0, colonAt)
  return s || null
}

/**
 * Read account config. Always returns a fully-defaulted record so
 * callers don't have to check for undefined fields.
 */
export function readQqAccountConfig(account: {
  config?: Record<string, unknown> | null
}): QqAccountConfig {
  return normalizeQqAccountConfig(account.config ?? {})
}

/**
 * Convenience predicate: is the dashboard deep-link domain present in
 * the operator's configured allowlist?
 */
export function isDashboardDomainAllowed(
  config: QqAccountConfig,
  dashboardDomain: string
): boolean {
  const lower = dashboardDomain.trim().toLowerCase()
  return config.configuredUrlDomains.includes(lower)
}
