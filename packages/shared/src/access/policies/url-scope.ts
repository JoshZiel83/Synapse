// URL → {origin, host, registrableDomain} resolver shared by the API server
// (capability-projection.buildRequestedAction's argument_url branch) and the
// device-runtime chrome-devtools-mcp provider (post-resolve enforcement).
// Single helper means a domain-scoped grant never silently fails because one
// side forgot to populate one of the three fields.
//
// Bundle-safe: tldts ships an ESM build with no node: imports.

import { getDomain } from "tldts"

export interface ResolvedUrlScope {
  origin?: string
  host?: string
  registrableDomain?: string
}

/**
 * Parse `url` into the (origin, host, registrableDomain) triple. Returns an
 * empty object for non-string / non-parseable input — callers should fail
 * closed. Punycode normalization is handled by the URL constructor; tldts
 * applies the Public Suffix List to find the registrable domain.
 *
 * Caller is responsible for the http/https scheme allowlist BEFORE invoking
 * this helper; matchers don't accept synthetic `origin: "null"`.
 */
export function resolveUrlScope(url: unknown): ResolvedUrlScope {
  if (typeof url !== "string" || url.length === 0) return {}
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {}
  }
  const host = parsed.hostname.toLowerCase()
  const registrable = getDomain(host) ?? undefined
  return {
    origin: parsed.origin,
    host: host || undefined,
    registrableDomain: registrable ?? undefined,
  }
}
