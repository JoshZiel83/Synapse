/**
 * tasks module repo — owns DB I/O for the tasks module's
 * `toolCallTaskActionTokens` table. This is the only file in the module
 * that may import the db client (guard r8 exempts repo*.ts).
 *
 * Repo functions return camelCase DOMAIN records and KEEP Date objects;
 * time serialization belongs to presenters (guard r3).
 */

import { sql } from "kysely"
import {
  db,
  runBuilder,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import type { ToolCallTaskActionTokensPayload } from "./repo.types.js"

/**
 * Atomic insert on the caller's executor (preserves the tx-mint contract:
 * the worker passes its tx `client` so the token row commits in the SAME
 * transaction as the projection write). The payload is cast via raw
 * `::jsonb` to bypass CamelCasePlugin nested-key mangling.
 */
export async function insertActionToken(
  executor: Executor,
  row: {
    token: string
    taskId: string
    payload: unknown
    expiresAt: Date
  }
): Promise<void> {
  await runBuilder(
    executor,
    db.insertInto("toolCallTaskActionTokens").values({
      token: row.token,
      taskId: row.taskId,
      payload: sql`${JSON.stringify(
        row.payload
      )}::jsonb` as unknown as ToolCallTaskActionTokensPayload,
      expiresAt: row.expiresAt,
    })
  )
}

/**
 * Direct read on the singleton — returns a camelCase domain record
 * (Date kept) or null.
 */
export async function findActionTokenRow(token: string): Promise<{
  token: string
  taskId: string
  payload: unknown
  expiresAt: Date
} | null> {
  const row = await db
    .selectFrom("toolCallTaskActionTokens")
    .select(["token", "taskId", "payload", "expiresAt"])
    .where("token", "=", token)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Direct delete sweep of expired token rows — returns affected count.
 * Uses a server-side `NOW()` comparison to avoid app/db clock skew.
 */
export async function deleteExpiredActionTokens(): Promise<number> {
  const result = await db
    .deleteFrom("toolCallTaskActionTokens")
    .where("expiresAt", "<", sql<Date>`NOW()`)
    .executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}
