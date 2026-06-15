const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type IsoInstantString = string & {
  readonly __synapseIsoInstant: unique symbol
}

function isValidDateInstance(value: unknown): value is Date {
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

export function nowIsoInstant(): IsoInstantString {
  return dateToIsoInstant(new Date())
}
