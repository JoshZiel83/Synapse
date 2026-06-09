import {
  dateToIsoInstant,
  dateToOptionalIsoInstant,
  isIsoInstant,
  nowIsoInstant,
  parseIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"

export type { IsoInstantString } from "@synapse/shared/datetime"

export function serializeInstant(value: Date): IsoInstantString {
  return dateToIsoInstant(value)
}

export function serializeOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return dateToOptionalIsoInstant(value)
}

export function serializeNowInstant(): IsoInstantString {
  return nowIsoInstant()
}

export function parseInstantString(value: string): Date {
  return parseIsoInstant(value)
}

export function isInstantString(value: string): value is IsoInstantString {
  return isIsoInstant(value)
}

export function requireInstantDate(
  value: Date | null | undefined,
  label: string
): Date {
  const isDateObject =
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Date]"

  if (!isDateObject || Number.isNaN(value.getTime())) {
    throw new Error(`${label} is required`)
  }
  return value
}
