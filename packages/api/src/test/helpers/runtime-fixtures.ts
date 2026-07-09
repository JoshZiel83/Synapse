// Test fixture helper for the runtime/sandbox CTI schema.
//
// A `devices` row is now a detail of the `runtimes` supertype: devices.id has a
// deferred FK to runtimes(id) and a deferred detail-consistency constraint
// trigger requires runtimes(kind='device') to have exactly one devices row at
// COMMIT. So a device fixture MUST insert the runtimes parent + the devices
// detail in the SAME transaction (separate autocommit statements trip the
// deferred trigger). This helper encapsulates that so tests read like the old
// single `insertInto("devices")`.

import { randomUUID } from "node:crypto"

// Kept intentionally loose (`any`) to match the test call sites, which already
// pass `as any` device value bags with varying optional column sets.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any

/**
 * Insert a `runtimes(kind='device')` parent + its `devices` detail row in one
 * transaction and return the shared id. `values` is the same device value bag
 * the tests previously passed to `insertInto("devices")` (must include
 * `workspaceId`); an explicit `id` is honored, else one is generated.
 */
export async function insertDeviceRuntime(
  db: AnyDb,
  values: Record<string, unknown> & { workspaceId: string; id?: string }
): Promise<{ id: string }> {
  // `db` is the per-test transaction handle from withTestDb (always rolled
  // back), so the deferred detail-consistency/root triggers only ever validate
  // at that transaction's boundary — the runtimes parent + devices detail land
  // together. Insert the parent first (the substrate FKs reference runtimes.id).
  const id = values.id ?? randomUUID()
  await db
    .insertInto("runtimes")
    .values({ id, workspaceId: values.workspaceId, kind: "device" })
    .execute()
  await db
    .insertInto("devices")
    .values({ ...values, id })
    .execute()
  return { id }
}
