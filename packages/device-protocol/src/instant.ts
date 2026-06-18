const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Plausible-instant window used to catch unit misconfiguration (seconds vs
 * milliseconds) and clock garbage when ingesting numeric external timestamps.
 *
 * - A seconds value (~1.7e9) wrongly passed as millis lands in 1970 -> below.
 * - A millis value (~1.7e12) wrongly passed as seconds lands in year ~55000 -> above.
 *
 * Bounds are fixed (not `now`-relative) so conversion is deterministic and
 * testable. 2000-01-01 .. 2200-01-01 (UTC) comfortably brackets any real
 * timestamp this system handles.
 */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2000, 0, 1)
const MAX_PLAUSIBLE_EPOCH_MS = Date.UTC(2200, 0, 1)

export type IsoInstantString = string & {
  readonly __synapseIsoInstant: unique symbol
}

export function isValidDateInstance(value: unknown): value is Date {
  return (
    Object.prototype.toString.call(value) === "[object Date]" &&
    !Number.isNaN((value as Date).getTime())
  )
}

/**
 * Wire-level ISO-8601 UTC instant guard.
 *
 * Accepts only canonical `Date#toISOString()` output so every protocol path
 * converges on one string shape.
 */
export function isIsoInstantString(value: unknown): value is IsoInstantString {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    return false
  }

  const parsedMs = Date.parse(value)
  if (!Number.isFinite(parsedMs)) {
    return false
  }

  return new Date(parsedMs).toISOString() === value
}

export function assertIsoInstantString(value: string): IsoInstantString {
  if (!isIsoInstantString(value)) {
    throw new Error(
      "Expected a canonical UTC ISO-8601 instant string with millisecond precision"
    )
  }
  return value
}

export function dateToIsoInstant(value: Date): IsoInstantString {
  if (!isValidDateInstance(value)) {
    throw new Error("Expected a valid Date when converting to IsoInstantString")
  }
  return assertIsoInstantString(value.toISOString())
}

export function dateToOptionalIsoInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return value ? dateToIsoInstant(value) : undefined
}

export function nowIsoInstant(): IsoInstantString {
  return dateToIsoInstant(new Date())
}

/**
 * The instant the server observed an external event for which the upstream
 * platform provided no trustworthy event time (e.g. a button-interaction event
 * that carries no message timestamp).
 *
 * Semantically distinct from a *parsed event time*: this is "server receive
 * time". NEVER use it to paper over a present-but-unparseable value — that is a
 * silent degradation. If an event time is present, parse it (and fail loud on
 * garbage) instead of falling back here.
 */
export function serverReceiveInstant(): IsoInstantString {
  return nowIsoInstant()
}

/** Back-compat alias. Prefer {@link assertIsoInstantString}. */
export function assertIsoInstant(value: string): IsoInstantString {
  return assertIsoInstantString(value)
}

/** Parse a canonical instant string back to a `Date`. Throws on non-canonical input. */
export function parseIsoInstant(value: string): Date {
  return new Date(assertIsoInstantString(value))
}

/** Back-compat alias. Prefer {@link isIsoInstantString}. */
export function isIsoInstant(value: string): value is IsoInstantString {
  return isIsoInstantString(value)
}

function assertPlausibleEpochMillis(ms: number, label: string): number {
  if (!Number.isFinite(ms)) {
    throw new Error(
      `${label}: expected a finite epoch-millisecond value, got ${ms}`
    )
  }
  if (ms < MIN_PLAUSIBLE_EPOCH_MS || ms >= MAX_PLAUSIBLE_EPOCH_MS) {
    throw new Error(
      `${label}: epoch-ms ${ms} is outside the plausible range ` +
        `[2000-01-01, 2200-01-01); likely a seconds/millis unit error`
    )
  }
  return ms
}

/**
 * Convert an explicit Unix epoch (SECONDS) to a canonical instant.
 * Throws on non-finite or implausible values — there is intentionally NO
 * magnitude heuristic. The caller must know the unit from the upstream contract.
 */
export function fromUnixSeconds(value: number): IsoInstantString {
  if (!Number.isFinite(value)) {
    throw new Error(
      `fromUnixSeconds: expected a finite seconds value, got ${value}`
    )
  }
  return fromUnixMillis(value * 1000)
}

/**
 * Convert an explicit Unix epoch (MILLISECONDS) to a canonical instant.
 * Throws on non-finite or implausible values (no magnitude heuristic).
 */
export function fromUnixMillis(value: number): IsoInstantString {
  return dateToIsoInstant(
    new Date(assertPlausibleEpochMillis(value, "fromUnixMillis"))
  )
}

/**
 * Parse an external RFC3339 / ISO-8601 string (which MAY carry a numeric offset
 * or non-canonical precision) into a canonical instant. Throws on unparseable
 * input — never returns a fabricated value. RFC3339 is unambiguous about the
 * instant, so no plausibility window is applied.
 */
export function fromExternalRfc3339(value: string): IsoInstantString {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("fromExternalRfc3339: expected a non-empty RFC3339 string")
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new Error(
      `fromExternalRfc3339: unparseable datetime string: ${value}`
    )
  }
  return dateToIsoInstant(new Date(ms))
}

/** Explicit Unix SECONDS -> epoch milliseconds, with plausibility check. */
export function unixSecondsToEpochMillis(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `unixSecondsToEpochMillis: expected a finite seconds value, got ${value}`
    )
  }
  return assertPlausibleEpochMillis(value * 1000, "unixSecondsToEpochMillis")
}

/**
 * Coerce an unknown numeric-or-numeric-string value to epoch MILLISECONDS using
 * an EXPLICIT unit. For callers that genuinely need a `number` (e.g. comparing a
 * webhook expiry against `Date.now()`) rather than an instant string. Throws on
 * non-finite / implausible input — never returns `undefined` to be treated as
 * "not expired".
 */
export function requireEpochMillis(value: unknown, unit: "s" | "ms"): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : Number.NaN
  if (!Number.isFinite(n)) {
    throw new Error(
      `requireEpochMillis: not a finite numeric value: ${String(value)}`
    )
  }
  return assertPlausibleEpochMillis(
    unit === "s" ? n * 1000 : n,
    "requireEpochMillis"
  )
}
