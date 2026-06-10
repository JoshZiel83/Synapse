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
    .selectFrom("toolCalls as tc")
    .innerJoin("conversations as c", "c.id", "tc.conversationId")
    .innerJoin("turns as t", "t.id", "tc.turnId")
    .leftJoin("pluginInstallations as pi", "pi.id", "tc.pluginInstallationId")
    .leftJoin("toolResults as tr", (join) =>
      join.onRef("tr.toolCallId", "=", "tc.id").on("tr.resultIndex", "=", 0)
    )
    .select([
      "tc.id",
      "tc.conversationId",
      "tc.sessionId",
      "tc.turnId",
      "t.actorId",
      "tc.providerCallId",
      "tc.toolName",
      "tc.sourceKind",
      "tc.sourceSnapshot",
      "tc.pluginInstallationId",
      "tc.deviceToolId",
      "tc.normalizedInput",
      "tc.status",
      "tc.createdAt",
      "tc.completedAt",
      "tr.isError",
      "tr.errorMessage",
      "tr.metadata as resultMetadata",
    ])
    .where("c.workspaceId", "=", workspaceId)

  if (filters?.sessionId) {
    statement = statement.where("tc.sessionId", "=", filters.sessionId)
  }
  if (filters?.actorId) {
    statement = statement.where("t.actorId", "=", filters.actorId)
  }
  if (filters?.pluginId) {
    statement = statement.where((eb) =>
      eb.or([
        eb("tc.pluginInstallationId", "=", filters.pluginId!),
        eb("pi.catalogItemId", "=", filters.pluginId!),
      ])
    )
  }
  if (filters?.before) {
    statement = statement.where("tc.createdAt", "<", new Date(filters.before))
  }

  const rows = await statement
    .orderBy("tc.createdAt", "desc")
    .limit(limit)
    .execute()
  return rows.map((row) => ({
    ...row,
    normalizedInput: redactSecrets(
      row.normalizedInput as Record<string, unknown>
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
    .selectFrom("runtimeEvents")
    .selectAll()
    .where("workspaceId", "=", workspaceId)

  if (filters?.eventType) {
    statement = statement.where("eventType", "=", filters.eventType)
  }
  if (filters?.pluginId) {
    statement = statement.where(
      sql<boolean>`payload->>'pluginId' = ${filters.pluginId}`
    )
  }
  if (filters?.before) {
    statement = statement.where("createdAt", "<", new Date(filters.before))
  }

  return statement.orderBy("createdAt", "desc").limit(limit).execute()
}
