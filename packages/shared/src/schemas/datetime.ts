/**
 * Single source of truth for the wire-instant zod schema lives in
 * `@synapse/device-protocol/instant/schema`. Re-exported here so `@synapse/shared`
 * consumers keep importing `IsoInstantStringSchema` from `@synapse/shared/schemas`
 * unchanged, while there is exactly ONE schema definition repo-wide (C1).
 *
 * This subpath carries zod, but `@synapse/shared/schemas` is never reachable
 * from the service-worker bundle, so it does not pollute it.
 */
export { IsoInstantStringSchema } from "@synapse/device-protocol/instant/schema"
