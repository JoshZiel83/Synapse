import {
  assertIsoInstantString,
  isIsoInstantString,
  type IsoInstantString,
} from "@synapse/device-protocol/instant"

export type { IsoInstantString } from "@synapse/device-protocol/instant"

function isValidDateInstance(value: unknown): value is Date {
  return (
    Object.prototype.toString.call(value) === "[object Date]" &&
    !Number.isNaN((value as Date).getTime())
  )
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
