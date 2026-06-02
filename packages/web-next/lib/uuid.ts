/**
 * Re-export of the canonical UUID helpers from @synapse/shared.
 *
 * Implementation now lives in `@synapse/shared/uuid` (single source of truth
 * across web + mobile). This shim keeps the existing `@/lib/uuid` import path
 * stable. `createUuid` no longer accepts a prefix argument (it was ignored).
 */
export { createUuid, isUuid } from "@synapse/shared/uuid"
