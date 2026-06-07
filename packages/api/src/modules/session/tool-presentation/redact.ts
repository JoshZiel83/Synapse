// API-only value-level redaction for tool-call presentation.
//
// Why a dedicated redactor (not shared/utils/redact.ts): the existing
// `redactSecrets` matches by KEY NAME, so it cannot catch a secret embedded in
// a free-text VALUE (e.g. a bash `command` = `curl -H "Authorization: Bearer
// sk-..."`). The presentation layer renders such values verbatim, so we scan
// the rendered text with @secretlint/core (the JS-native sibling of the gitleaks
// this repo already runs in pre-commit/CI): 100+ rules + entropy, covering
// AWS/GCP/GitHub/Slack/Stripe/OpenAI/Anthropic/JWT/private-key/etc.
//
// Lives in @synapse/api (never shared): secretlint is async + heavy and must not
// reach the web/mobile SW bundles. The shared/device-protocol renderer stays
// pure + sync; redaction is applied here, server-side, before the redis snapshot.

import { lintSource } from "@secretlint/core"
import { creator as recommendPreset } from "@secretlint/secretlint-rule-preset-recommend"
import type { SecretLintCoreConfig } from "@secretlint/types"

const REDACTED = "[redacted]"

// Hard cap: secretlint walks the whole string, so an unbounded multi-megabyte
// stdout would stall the 350ms-debounced runtime snapshot hot path. We scan only
// the head; anything past the cap is truncated with a marker (and thus also
// cannot leak). Tuned to comfortably cover realistic tool output previews.
const MAX_SCAN_CHARS = 16_000
const TRUNCATION_MARKER = "\n…[truncated]"

const config: SecretLintCoreConfig = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: recommendPreset,
    },
  ],
}

// Belt-and-suspenders: a small set of deterministic value-shaped patterns that
// are the real threat model for free-text tool args/output (a bash `command`
// or stdout echoing a credential). secretlint's recommend preset covers
// vendor-specific keys, but its rules are tuned to exact current formats and a
// generic "Bearer <token>" / "?token=<v>" can slip a specific rule. This regex
// pass runs FIRST so these high-value shapes are always masked regardless of
// preset rule drift.
const VALUE_SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bbasic\s+[A-Za-z0-9+/=]{12,}/gi,
  /([?&](?:access_token|api[_-]?key|auth|key|secret|token|password|passwd|pwd)=)[^&\s"']+/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // generic provider key prefixes
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // GCP API key
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
]

function preScrub(content: string): string {
  let out = content
  for (const re of VALUE_SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) =>
      typeof prefix === "string" ? prefix + REDACTED : REDACTED
    )
  }
  return out
}

// Replace each matched [start,end) range with REDACTED. Ranges from secretlint
// are non-overlapping; we splice from the end so earlier indices stay valid.
function applyRedactions(
  content: string,
  ranges: ReadonlyArray<readonly [number, number]>
): string {
  if (ranges.length === 0) return content
  const sorted = [...ranges].sort((a, b) => b[0] - a[0])
  let out = content
  for (const [start, end] of sorted) {
    if (start < 0 || end > out.length || start >= end) continue
    out = out.slice(0, start) + REDACTED + out.slice(end)
  }
  return out
}

/**
 * Redact secrets from an arbitrary text value. Async (secretlint is async); the
 * runtime display path is already async. Returns the original string when no
 * secret is found. Fails CLOSED: on any scanner error, returns a fully-masked
 * placeholder rather than risk leaking the raw value.
 */
export async function redactText(value: string): Promise<string> {
  if (!value) return value
  const capped =
    value.length > MAX_SCAN_CHARS
      ? value.slice(0, MAX_SCAN_CHARS) + TRUNCATION_MARKER
      : value
  // Deterministic value-shape scrub first (always-on), then secretlint's
  // vendor-rule + entropy pass on top for everything else.
  const scanned = preScrub(capped)
  try {
    const result = await lintSource({
      source: {
        content: scanned,
        filePath: "tool-presentation.txt",
        contentType: "text",
      },
      options: { config, noPhysicFilePath: true },
    })
    const ranges = result.messages.map((m) => m.range)
    return applyRedactions(scanned, ranges)
  } catch {
    // Never let a scanner failure surface a raw value.
    return REDACTED
  }
}

/**
 * Deep-redact every string leaf of a value (object/array/string), in place over
 * a structural clone. Used as the final pass over the rendered presentation so
 * NO string field — fallback, displayTitle, params, block text — can leak,
 * regardless of how the renderer produced it.
 */
export async function redactDeep<T>(value: T): Promise<T> {
  if (typeof value === "string") {
    return (await redactText(value)) as unknown as T
  }
  if (Array.isArray(value)) {
    return (await Promise.all(value.map((v) => redactDeep(v)))) as unknown as T
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(
        async ([k, v]) => [k, await redactDeep(v)] as const
      )
    )
    return Object.fromEntries(entries) as T
  }
  return value
}
