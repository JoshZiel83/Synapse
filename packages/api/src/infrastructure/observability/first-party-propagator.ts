import {
  diag,
  trace,
  type Context,
  type Span,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
} from "@opentelemetry/api"

/**
 * Ring-2 egress choke point (docs/trace-propagation-policy.md): wraps the
 * ENTIRE final composite propagator so NOTHING — traceparent, tracestate,
 * sentry-trace, Sentry DSC baggage — is injected toward third-party hosts.
 * `Sentry.init tracePropagationTargets` stays unset by design: one matcher,
 * one policy, enforced here for both configs.
 *
 * First-party (Ring 1) = dotless hostnames (docker DNS — every current and
 * future compose sidecar, zero config drift), loopback, RFC1918 IPv4, IPv6
 * ULA, the `BASE_URL`/`APP_BASE_URL` hosts, and `SYNAPSE_TRACE_FIRST_PARTY_HOSTS`
 * entries (comma-separated; leading dot = suffix match — the CubeSandbox envd
 * virtual vhost `{envdPort}-{sandboxID}.{domain}` needs `.{domain}` here, see
 * the policy doc).
 */

export interface FirstPartyAllowlist {
  readonly exact: ReadonlySet<string>
  readonly suffixes: readonly string[]
}

/**
 * Allowlist from the environment: `SYNAPSE_TRACE_FIRST_PARTY_HOSTS` entries
 * (lowercased; leading dot ⇒ suffix) plus the hostnames of `BASE_URL` and
 * `APP_BASE_URL` (always first-party). Malformed URLs and empty entries are
 * skipped — the matcher then simply falls back to deny.
 */
export function buildFirstPartyAllowlist(
  env: Record<string, string | undefined>
): FirstPartyAllowlist {
  const exact = new Set<string>()
  const suffixes: string[] = []
  for (const entry of (env.SYNAPSE_TRACE_FIRST_PARTY_HOSTS ?? "").split(",")) {
    const host = entry.trim().toLowerCase()
    if (!host) continue
    if (host.startsWith(".")) suffixes.push(host)
    else exact.add(host)
  }
  for (const base of [env.BASE_URL, env.APP_BASE_URL]) {
    if (!base) continue
    try {
      exact.add(new URL(base).hostname.toLowerCase())
    } catch {
      // Not this module's job to validate BASE_URL — just no allowlist entry.
    }
  }
  return { exact, suffixes }
}

// RFC1918 (10/8, 172.16/12, 192.168/16) or loopback (127/8).
function isPrivateOrLoopbackIpv4(a: number, b: number): boolean {
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

const DOTTED_IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
// Single-label numeric IPv4 forms: decimal (2130706433), hex (0x7f000001),
// octal (017700000001). Dotted-mixed forms never reach the matcher — WHATWG
// URL parsing (below) already normalizes every IPv4-number host of an
// http/https URL to canonical dotted-decimal.
const NUMERIC_LABEL_RE = /^(?:0x[0-9a-f]*|\d+)$/

function numericLabelToIpv4(label: string): [number, number] | undefined {
  let value: number
  if (label.startsWith("0x")) value = parseInt(label.slice(2), 16)
  else if (label.startsWith("0")) value = parseInt(label, 8)
  else value = parseInt(label, 10)
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return undefined
  }
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff]
}

/**
 * Classify a destination URL as first-party (Ring 1) or not. Anything
 * unparseable, unmatched, or exotic (IPv4-mapped IPv6, `0.0.0.0`, …) is NOT
 * first-party — deny is always the safe direction (spans still export; the
 * loss is correlation-only).
 *
 * Hardening: a numeric-only single label is an IP *literal*, not a docker DNS
 * name — it is normalized to an address and given the loopback/RFC1918 checks
 * (public ranges denied), so an SSRF-adjacent fetch to `http://2130706433`
 * can never take the dotless first-party branch.
 */
export function isFirstParty(
  rawUrl: string,
  allowlist: FirstPartyAllowlist
): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (host === "") return false

  if (allowlist.exact.has(host)) return true
  if (allowlist.suffixes.some((suffix) => host.endsWith(suffix))) return true

  // IPv6 (WHATWG keeps the brackets on url.hostname).
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1)
    if (inner === "::1") return true // loopback
    const firstGroup = inner.split(":", 1)[0]
    return /^f[cd][0-9a-f]{2}$/.test(firstGroup ?? "") // ULA fc00::/7
  }

  const ipv4 = DOTTED_IPV4_RE.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a > 255 || b > 255 || Number(ipv4[3]) > 255 || Number(ipv4[4]) > 255) {
      return false
    }
    return isPrivateOrLoopbackIpv4(a, b)
  }

  if (!host.includes(".")) {
    if (NUMERIC_LABEL_RE.test(host)) {
      const octets = numericLabelToIpv4(host)
      return octets !== undefined && isPrivateOrLoopbackIpv4(...octets)
    }
    return true // genuinely non-numeric single label ⇒ docker DNS ⇒ first-party
  }

  return false
}

// Reading `span.attributes` is an SDK implementation field, not @opentelemetry/api
// surface — the same technique Sentry ships in @sentry/opentelemetry. Pinned by
// the SDK-shape test in first-party-propagator.test.ts.
function resolveDestinationUrl(span: Span): string | undefined {
  const attributes = (span as Span & { attributes?: Record<string, unknown> })
    .attributes
  const fromAttributes = attributes?.["url.full"] ?? attributes?.["http.url"]
  if (typeof fromAttributes === "string") return fromAttributes
  // wrapSamplingDecision (called by instrumentation.ts's SentryWrappedSampler)
  // stashes the URL in traceState even for NOT_RECORD decisions, so under
  // Sentry-ON unsampled CLIENT spans still resolve.
  return span.spanContext().traceState?.get("sentry.url")
}

const NO_URL_WARN_INTERVAL_MS = 60_000

/**
 * Wraps the final composite propagator: `inject()` delegates iff the active
 * span's destination URL classifies first-party; `extract()`/`fields()`
 * delegate unconditionally (inbound trust is Ring 0's job — nginx strips
 * vendor state; traceparent is kept-but-untrusted, flags advisory).
 *
 * Recording spans without a resolvable URL fail CLOSED (grep-verified: nothing
 * in-repo calls the global propagator's inject outside HttpInstrumentation/
 * UndiciInstrumentation, and both set `url.full`/`http.url` on recording
 * CLIENT spans pre-inject). One narrow carve-out: non-recording spans under
 * Sentry-OFF delegate — unsampled requests yield attribute-less
 * NonRecordingSpans there, so first- vs third-party is undecidable and
 * severing every unsampled first-party hop would be the greater loss. The
 * disclosure surface (flags-00 traceparent to third parties, Sentry-off +
 * ratio sampler only) is recorded in the policy doc.
 */
export class FirstPartyOnlyPropagator implements TextMapPropagator {
  private lastNoUrlWarnAt = 0

  constructor(
    private readonly inner: TextMapPropagator,
    private readonly sentryEnabled: boolean,
    private readonly allowlist: FirstPartyAllowlist
  ) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const span = trace.getSpan(context)
    if (!span) return
    const url = resolveDestinationUrl(span)
    if (url !== undefined) {
      if (isFirstParty(url, this.allowlist)) {
        this.inner.inject(context, carrier, setter)
      }
      return
    }
    if (!span.isRecording()) {
      if (!this.sentryEnabled) this.inner.inject(context, carrier, setter)
      return
    }
    const now = Date.now()
    if (now - this.lastNoUrlWarnAt >= NO_URL_WARN_INTERVAL_MS) {
      this.lastNoUrlWarnAt = now
      diag.warn(
        "FirstPartyOnlyPropagator: recording span without a resolvable destination URL — trace headers suppressed (fail-closed)"
      )
    }
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.inner.extract(context, carrier, getter)
  }

  fields(): string[] {
    return this.inner.fields()
  }
}

/**
 * The single integration point for instrumentation.ts: wrap the final
 * composite (`basePropagator`) with the process-env allowlist.
 */
export function firstPartyPropagator(
  inner: TextMapPropagator,
  sentryEnabled: boolean
): FirstPartyOnlyPropagator {
  return new FirstPartyOnlyPropagator(
    inner,
    sentryEnabled,
    buildFirstPartyAllowlist(process.env)
  )
}
