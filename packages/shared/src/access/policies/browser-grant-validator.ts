// Browser grant policy validator + normalizer. Last line of defence before a
// browser grant lands in `runtime_authorization_grants.policy`. Called from:
//   1. manual grant endpoint (POST /workspaces/:id/runtime-authorization-grants)
//   2. approval default grantOption generation in capability-projection
//   3. createRuntimeAuthorizationGrant helper (unconditional — caller bypass not allowed)
//
// Rejects unparseable / non-http(s) origins, missing scope tuples, and
// empty `operations` arrays (which would otherwise be a fail-closed
// matcher trap producing dead grants).
//
// Bundle-safe; relies only on URL + tldts.

import { getDomain } from "tldts"
import type { BrowserPolicy } from "./browser.js"

export class BrowserGrantPolicyError extends Error {
  constructor(
    message: string,
    public readonly field: string
  ) {
    super(message)
    this.name = "BrowserGrantPolicyError"
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"])

/**
 * Validate AND normalize a browser grant policy. Returns a normalized COPY
 * (callers should use the return value, not the input) so casing / trailing
 * slashes / IDN punycode are canonical in the persisted row.
 *
 * Throws BrowserGrantPolicyError on any rule failure — callers map to HTTP
 * 400 (manual endpoint) or reject the approval flow.
 */
export function normalizeBrowserGrantPolicy(
  policy: BrowserPolicy
): BrowserPolicy {
  // operations — required non-empty array. Missing/empty is a dead grant.
  if (!Array.isArray(policy.operations) || policy.operations.length === 0) {
    throw new BrowserGrantPolicyError(
      "browser grant must declare at least one operation",
      "operations"
    )
  }
  const operations = Array.from(
    new Set(policy.operations)
  ).sort() as BrowserPolicy["operations"]

  // scopeType — required for browser; matcher refuses undefined anyway.
  if (!policy.scopeType) {
    throw new BrowserGrantPolicyError(
      "browser grant must declare scopeType (origin | host | domain)",
      "scopeType"
    )
  }

  // Only the field matching scopeType may be populated; others must be undefined.
  let origin: string | undefined
  let host: string | undefined
  let registrableDomain: string | undefined

  switch (policy.scopeType) {
    case "origin": {
      if (typeof policy.origin !== "string" || policy.origin.length === 0) {
        throw new BrowserGrantPolicyError(
          "scopeType=origin requires non-empty origin",
          "origin"
        )
      }
      let parsed: URL
      try {
        parsed = new URL(policy.origin)
      } catch {
        throw new BrowserGrantPolicyError(
          `origin is not a valid URL: ${policy.origin}`,
          "origin"
        )
      }
      if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        throw new BrowserGrantPolicyError(
          `origin scheme not allowed: ${parsed.protocol}`,
          "origin"
        )
      }
      if (parsed.origin === "null") {
        throw new BrowserGrantPolicyError(
          "origin resolves to opaque 'null'",
          "origin"
        )
      }
      // Reject inputs that aren't already canonical (trailing slash, path,
      // query, fragment, userinfo). Caller should pass `parsed.origin`
      // upstream — silently rewriting risks UI showing a different string
      // than what was approved.
      if (parsed.origin !== policy.origin) {
        throw new BrowserGrantPolicyError(
          `origin must equal new URL(origin).origin — got ${policy.origin}, expected ${parsed.origin}`,
          "origin"
        )
      }
      origin = policy.origin
      // host & registrableDomain must NOT be set when scopeType=origin
      if (policy.host !== undefined || policy.registrableDomain !== undefined) {
        throw new BrowserGrantPolicyError(
          "scopeType=origin must not also set host or registrableDomain",
          "scopeType"
        )
      }
      break
    }
    case "host": {
      if (typeof policy.host !== "string" || policy.host.length === 0) {
        throw new BrowserGrantPolicyError(
          "scopeType=host requires non-empty host",
          "host"
        )
      }
      if (/[\s/:]/.test(policy.host)) {
        throw new BrowserGrantPolicyError(
          `host contains illegal characters: ${policy.host}`,
          "host"
        )
      }
      // Run through URL hostname pipeline to get punycode + lowercase.
      let normalized: string
      try {
        normalized = new URL(`https://${policy.host}`).hostname
      } catch {
        throw new BrowserGrantPolicyError(
          `host is not parseable: ${policy.host}`,
          "host"
        )
      }
      host = normalized.toLowerCase()
      if (
        policy.origin !== undefined ||
        policy.registrableDomain !== undefined
      ) {
        throw new BrowserGrantPolicyError(
          "scopeType=host must not also set origin or registrableDomain",
          "scopeType"
        )
      }
      break
    }
    case "domain": {
      if (
        typeof policy.registrableDomain !== "string" ||
        policy.registrableDomain.length === 0
      ) {
        throw new BrowserGrantPolicyError(
          "scopeType=domain requires non-empty registrableDomain",
          "registrableDomain"
        )
      }
      if (/[\s/:]/.test(policy.registrableDomain)) {
        throw new BrowserGrantPolicyError(
          `registrableDomain contains illegal characters: ${policy.registrableDomain}`,
          "registrableDomain"
        )
      }
      const candidate = policy.registrableDomain.toLowerCase()
      // tldts must agree this IS a registrable domain (rejects bare TLD like "co.uk"
      // and multi-level public suffixes that wouldn't actually match anything).
      const resolved = getDomain(candidate)
      if (!resolved || resolved !== candidate) {
        throw new BrowserGrantPolicyError(
          `not a valid registrable domain per PSL: ${policy.registrableDomain}`,
          "registrableDomain"
        )
      }
      registrableDomain = candidate
      if (policy.origin !== undefined || policy.host !== undefined) {
        throw new BrowserGrantPolicyError(
          "scopeType=domain must not also set origin or host",
          "scopeType"
        )
      }
      break
    }
  }

  return {
    action: policy.action,
    scopeType: policy.scopeType,
    origin,
    host,
    registrableDomain,
    operations,
  }
}
