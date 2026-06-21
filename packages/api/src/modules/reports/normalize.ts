// Normalizers for browser auto-reports (W3C Reporting API + legacy CSP).
//
// Two wire formats arrive at POST /api/v1/reports and MUST be parsed
// differently (review finding: a single shape is wrong):
//   - application/reports+json : a JSON ARRAY of {type, age, url, user_agent,
//     body}. NEL bodies use snake_case; csp/deprecation/intervention/crash
//     bodies use camelCase — so we keep `body` OPAQUE (no key normalization).
//   - application/csp-report   : a SINGLE {"csp-report":{...}} object with
//     hyphenated keys (Firefox/Safari's only path).
//
// Everything here is attacker-controllable and unauthenticated: we validate the
// `type` against a closed allowlist, size/count-cap, defensively coerce, and
// NEVER throw on malformed input (return []). The raw `body` is kept as opaque
// structured data, size-capped, and is only ever logged as a structured field —
// never interpolated into a log message.

/** Closed allowlist of report types we accept + log. */
export const REPORT_TYPES = [
  "network-error", // NEL
  "csp-violation",
  "deprecation",
  "intervention",
  "crash",
] as const
export type ReportType = (typeof REPORT_TYPES)[number]
const TYPE_SET: ReadonlySet<string> = new Set(REPORT_TYPES)

export interface NormalizedReport {
  reportType: ReportType
  age?: number
  url?: string
  userAgent?: string
  /** Raw type-specific body, size-capped, kept opaque (snake/camel preserved). */
  body: Record<string, unknown>
}

const MAX_REPORTS = 100
const MAX_STR = 2_000
const MAX_BODY_BYTES = 8_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function clampStr(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, MAX_STR) : undefined
}

function capBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {}
  try {
    // Measure UTF-8 bytes (String.length is UTF-16 code units — up to ~3x off
    // for CJK/emoji, which would let one report's Loki line blow past the cap).
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
      return { truncated: true }
    }
  } catch {
    return { unserializable: true }
  }
  return body
}

/**
 * Parse `application/reports+json` — a JSON ARRAY (even for a single report).
 * Drops entries whose `type` is missing or not in the allowlist. Caps count.
 */
export function parseReportsJson(parsed: unknown): NormalizedReport[] {
  if (!Array.isArray(parsed)) return []
  const out: NormalizedReport[] = []
  for (const item of parsed.slice(0, MAX_REPORTS)) {
    if (!isRecord(item)) continue
    const type = item.type
    if (typeof type !== "string" || !TYPE_SET.has(type)) continue
    out.push({
      reportType: type as ReportType,
      // Reject NaN/Infinity/negative (spec: age is a non-negative ms delta);
      // a rejected age becomes undefined and pino omits it.
      age:
        Number.isFinite(item.age) && (item.age as number) >= 0
          ? (item.age as number)
          : undefined,
      url: clampStr(item.url),
      // Reporting API field is `user_agent` (snake_case), not `userAgent`.
      userAgent: clampStr(item.user_agent),
      body: capBody(item.body),
    })
  }
  return out
}

/**
 * Parse legacy `application/csp-report` — a SINGLE {"csp-report":{...}} object
 * with hyphenated keys. Always a csp-violation. Returns [] when malformed.
 */
export function parseCspReport(parsed: unknown): NormalizedReport[] {
  if (!isRecord(parsed)) return []
  const report = parsed["csp-report"]
  if (!isRecord(report)) return []
  return [
    {
      reportType: "csp-violation",
      url: clampStr(report["document-uri"]),
      body: capBody(report),
    },
  ]
}
