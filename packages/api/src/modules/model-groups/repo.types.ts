/**
 * Model-groups module repo types.
 *
 * The ONLY model-groups file allowed to touch `generated/db` / `TableInsert`
 * (guard-layering r1/r2). Groups the JSONB column-type aliases so the service
 * can cast payloads (`as ModelGroupsAttemptPolicy`, etc.) without referencing
 * `TableInsert<...>` inline.
 */

import type { TableInsert } from "../../infrastructure/database/kysely.js"

export type ModelGroupsAttemptPolicy =
  TableInsert<"modelGroups">["attemptPolicy"]
export type ModelBindingVersionsFeatures =
  TableInsert<"modelBindingVersions">["features"]
export type ModelBindingVersionsProviderOptions =
  TableInsert<"modelBindingVersions">["providerOptions"]
