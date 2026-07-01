// Single faker/zod-schema-faker setup for the design mock layer.
//
// `mock(schema)` generates a value typed as `z.infer<typeof schema>` straight
// from a real @synapse/shared zod schema — we never re-declare response shapes.
// When a schema changes upstream, the generated data conforms automatically and
// any genuine drift surfaces at compile time where the handler is checked
// against the ApiClient method signature.
import type { z } from "zod"
import { IsoInstantStringSchema } from "@synapse/shared/schemas"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { faker } from "@faker-js/faker"
import { fake, setFaker, seed, custom, getFaker } from "zod-schema-faker/v4"

setFaker(faker)

// Canonical timestamps. `IsoInstantStringSchema` is `z.string().refine(isIso…)`,
// which the generic string faker would fill with lorem text and break every
// date formatter in the UI. There is exactly ONE instance of this schema
// repo-wide (re-exported from @synapse/device-protocol), so registering a custom
// faker for it here yields realistic UTC ISO instants for every createdAt /
// updatedAt across all 361 schemas.
custom(IsoInstantStringSchema, () =>
  dateToIsoInstant(getFaker().date.recent({ days: 90 }))
)

// Deterministic output → stable layouts and screenshots while iterating on the
// UI. Bump or remove this seed to reshuffle the generated fixtures.
seed(20240601)

// Bind the return type to zod's `z.infer` (not zod-schema-faker's internal
// `core.infer`). The View types the ApiClient returns, and the contract-parity
// assertions in @synapse/shared, are all expressed in `z.infer`; for a few
// families (e.g. the chat response unions guarded by MutualAssign, whose arms
// carry readonly SubjectRef identity) `core.infer` and `z.infer` differ, and
// only `z.infer` is assignable to the hand-written response type. Runtime is
// unchanged — this is purely the declared type.
export function mock<T extends z.ZodType>(schema: T): z.infer<T> {
  return fake(schema) as z.infer<T>
}
