import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@synapse/shared"
import { sql } from "kysely"
import { db } from "../infrastructure/database/kysely.js"

export async function getActorMaxSessions(actorId: string): Promise<number> {
  const row = await db
    .selectFrom("actors")
    .select(
      sql<number>`CASE
        WHEN COALESCE(config->>'maxConcurrentSessions', '') ~ '^[0-9]+$'
          THEN GREATEST((config->>'maxConcurrentSessions')::int, 1)
        ELSE ${DEFAULT_MAX_CONCURRENT_SESSIONS}
      END`.as("maxConcurrentSessions")
    )
    .where("id", "=", actorId)
    .executeTakeFirst()
  return row?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS
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
