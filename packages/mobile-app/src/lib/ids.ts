/**
 * Re-export of the canonical UUID helpers from @synapse/shared.
 *
 * Implementation now lives in `@synapse/shared/uuid` (single source of truth
 * across web + mobile, imported here via the `@shared` alias). `createId` wraps
 * `createUuid` and keeps the historical optional `prefix` parameter for call-site
 * compatibility — the prefix has always been ignored; the result is a real
 * RFC-4122 v4 UUID.
 */
import { createUuid, isUuid } from "@shared/uuid"

export { isUuid }

export function createId(_prefix = "id"): string {
  return createUuid()
}
