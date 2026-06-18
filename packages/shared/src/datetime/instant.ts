/**
 * Single source of truth for the canonical wire instant primitive lives in
 * `@synapse/device-protocol/instant`. This module ONLY re-exports it so the
 * entire `@synapse/shared` surface — including the `Timestamp` DTO scalar
 * (`../types/index.ts`) — shares one branded type, one ISO regex, and one set
 * of conversion/guard functions.
 *
 * C1 INVARIANT: do NOT redefine the type, the ISO pattern, or any conversion
 * here or anywhere else. New conversions belong in
 * `packages/device-protocol/src/instant.ts`.
 */
export type { IsoInstantString } from "@synapse/device-protocol/instant"
export {
  isIsoInstantString,
  assertIsoInstantString,
  dateToIsoInstant,
  dateToOptionalIsoInstant,
  nowIsoInstant,
  serverReceiveInstant,
  assertIsoInstant,
  parseIsoInstant,
  isIsoInstant,
  fromUnixSeconds,
  fromUnixMillis,
  fromExternalRfc3339,
  unixSecondsToEpochMillis,
  requireEpochMillis,
} from "@synapse/device-protocol/instant"
