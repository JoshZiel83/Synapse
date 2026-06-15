import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  type ThinkingResult,
} from "@synapse/shared"
import { sql } from "kysely"
import { db, type TableInsert } from "../infrastructure/database/kysely.js"

export async function getActorMaxSessions(actorId: string): Promise<number> {
  const row = await db
    .selectFrom("actors")
    .select(
      sql<number>`CASE
        WHEN COALESCE(config->>'maxConcurrentSessions', '') ~ '^[0-9]+$'
          THEN GREATEST((config->>'maxConcurrentSessions')::int, 1)
        ELSE ${DEFAULT_MAX_CONCURRENT_SESSIONS}
      END`.as("max_concurrent_sessions")
    )
    .where("id", "=", actorId)
    .executeTakeFirst()
  return row?.max_concurrent_sessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS
}

export async function insertSessionThinkAuditLog(input: {
  workspaceId: string
  actorId: string
  sessionId: string
  trigger: string
  tokensUsed: ThinkingResult["tokensUsed"]
  actionsCount: number
  reasoning: string
  turnId: string
}): Promise<void> {
  await db
    .insertInto("auditLogs")
    .values({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: "ai.think",
      resourceType: "session",
      resourceId: input.sessionId,
      details: {
        trigger: input.trigger,
        tokensUsed: input.tokensUsed,
        actionsCount: input.actionsCount,
        reasoning: input.reasoning,
        turnId: input.turnId,
      } as TableInsert<"auditLogs">["details"],
    })
    .execute()
}

export async function markSessionMemoryBootstrapCompleted(
  sessionId: string
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      memoryBootstrapCompleted: true,
    })
    .where("id", "=", sessionId)
    .execute()
}
