const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type IsoInstantString = string

function isValidDateInstance(value: unknown): value is Date {
  return (
    Object.prototype.toString.call(value) === "[object Date]" &&
    !Number.isNaN((value as Date).getTime())
  )
}

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

export function assertIsoInstant(value: string): IsoInstantString {
  return assertIsoInstantString(value)
}

export function parseIsoInstant(value: string): Date {
  const instant = assertIsoInstant(value)
  return new Date(instant)
}

export function isIsoInstant(value: string): value is IsoInstantString {
  return isIsoInstantString(value)
}
