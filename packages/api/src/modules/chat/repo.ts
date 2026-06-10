// chat/repo.ts — DB-touching helpers for the chat module.
//
// This is the only chat file permitted to import from generated/db and to
// define map*Row helpers (see packages/api/scripts/guard-layering.mjs). It
// owns the jsonb SQL fragment builder and the push-token row mapper so that
// service.ts stays free of generated/db imports and row-mapping definitions.

import { sql, type RawBuilder } from "kysely"
import type { Timestamp } from "@synapse/shared"
import type { JsonValue } from "../../infrastructure/database/generated/db.js"
import { serializeInstant } from "../../infrastructure/datetime.js"

/** Serialize a value into a jsonb-typed SQL fragment (matches `$N::jsonb`). */
export function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value ?? null)}::jsonb`
}

export interface ChatPushTokenRow {
  id: string
  workspaceMemberId: string
  platform: "ios" | "android" | "web"
  token: string
  deviceLabel: string | null
  createdAt: Timestamp
  lastSeenAt: Timestamp
}

export function mapPushTokenRow(
  row: Record<string, unknown>
): ChatPushTokenRow {
  return {
    id: String(row.id),
    workspaceMemberId: String(row.workspace_member_id),
    platform: row.platform as "ios" | "android" | "web",
    token: String(row.token),
    deviceLabel: (row.device_label as string | null) ?? null,
    createdAt: serializeInstant(row.created_at as Date),
    lastSeenAt: serializeInstant(row.last_seen_at as Date),
  }
}
