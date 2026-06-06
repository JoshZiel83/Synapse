import { db } from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { redactSecrets } from "@synapse/shared"
import { logRuntimeEvent } from "../execution/service.js"

export async function logEvent(data: {
  workspaceId?: string
  userId?: string
  pluginId?: string
  deviceId?: string
  eventType: string
  eventData?: Record<string, unknown>
}) {
  await logRuntimeEvent({
    workspaceId: data.workspaceId,
    userId: data.userId,
    source: data.deviceId ? "device" : "tool",
    level: "info",
    eventType: data.eventType,
    payload: {
      pluginId: data.pluginId,
      deviceId: data.deviceId,
      ...(data.eventData || {}),
    },
  })
}

export async function getToolCallLogs(
  workspaceId: string,
  filters?: {
    pluginId?: string
    sessionId?: string
    actorId?: string
    limit?: number
    before?: string
  }
) {
  const limit = Math.min(filters?.limit || 50, 200)
  let statement = db
    .selectFrom("tool_calls as tc")
    .innerJoin("conversations as c", "c.id", "tc.conversation_id")
    .innerJoin("turns as t", "t.id", "tc.turn_id")
    .leftJoin(
      "plugin_installations as pi",
      "pi.id",
      "tc.plugin_installation_id"
    )
    .leftJoin("tool_results as tr", (join) =>
      join.onRef("tr.tool_call_id", "=", "tc.id").on("tr.result_index", "=", 0)
    )
    .select([
      "tc.id",
      "tc.conversation_id",
      "tc.session_id",
      "tc.turn_id",
      "t.actor_id",
      "tc.provider_call_id",
      "tc.tool_name",
      "tc.source_kind",
      "tc.source_snapshot",
      "tc.plugin_installation_id",
      "tc.device_tool_id",
      "tc.normalized_input",
      "tc.status",
      "tc.created_at",
      "tc.completed_at",
      "tr.is_error",
      "tr.error_message",
      "tr.metadata as result_metadata",
    ])
    .where("c.workspace_id", "=", workspaceId)

  if (filters?.sessionId) {
    statement = statement.where("tc.session_id", "=", filters.sessionId)
  }
  if (filters?.actorId) {
    statement = statement.where("t.actor_id", "=", filters.actorId)
  }
  if (filters?.pluginId) {
    statement = statement.where((eb) =>
      eb.or([
        eb("tc.plugin_installation_id", "=", filters.pluginId!),
        eb("pi.catalog_item_id", "=", filters.pluginId!),
      ])
    )
  }
  if (filters?.before) {
    statement = statement.where("tc.created_at", "<", new Date(filters.before))
  }

  const rows = await statement
    .orderBy("tc.created_at", "desc")
    .limit(limit)
    .execute()
  return rows.map((row) => ({
    ...row,
    normalized_input: redactSecrets(
      row.normalized_input as Record<string, unknown>
    ),
  }))
}

export async function getEventLogs(
  workspaceId: string,
  filters?: {
    eventType?: string
    pluginId?: string
    limit?: number
    before?: string
  }
) {
  const limit = Math.min(filters?.limit || 50, 200)
  let statement = db
    .selectFrom("runtime_events")
    .selectAll()
    .where("workspace_id", "=", workspaceId)

  if (filters?.eventType) {
    statement = statement.where("event_type", "=", filters.eventType)
  }
  if (filters?.pluginId) {
    statement = statement.where(
      sql<boolean>`payload->>'pluginId' = ${filters.pluginId}`
    )
  }
  if (filters?.before) {
    statement = statement.where("created_at", "<", new Date(filters.before))
  }

  return statement.orderBy("created_at", "desc").limit(limit).execute()
}
