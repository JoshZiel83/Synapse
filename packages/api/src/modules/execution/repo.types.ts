/**
 * Execution module repo types.
 *
 * The ONLY execution file allowed to touch `generated/db` / `TableInsert`
 * (guard-layering r1/r2). Re-exports the DB enum used by the service and
 * groups the JSONB column-type aliases so the service can cast payloads
 * (`as TurnsMetadata`, etc.) without referencing `TableInsert<...>` inline.
 */

import type { TableInsert } from "../../infrastructure/database/kysely.js"

export type { PayloadBlobsRetentionClass } from "../../infrastructure/database/generated/db.js"

export type PayloadBlobsJsonBody = TableInsert<"payloadBlobs">["jsonBody"]
export type TurnsMetadata = TableInsert<"turns">["metadata"]
export type ProviderStepsCapabilitiesSnapshot =
  TableInsert<"providerSteps">["capabilitiesSnapshot"]
export type ToolCallsSourceSnapshot = TableInsert<"toolCalls">["sourceSnapshot"]
export type ToolCallsNormalizedInput =
  TableInsert<"toolCalls">["normalizedInput"]
export type ToolResultsMetadata = TableInsert<"toolResults">["metadata"]
export type ToolResultPartsMetadata = TableInsert<"toolResultParts">["metadata"]
export type RuntimeEventsPayload = TableInsert<"runtimeEvents">["payload"]
