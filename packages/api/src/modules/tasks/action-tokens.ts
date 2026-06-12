/**
 * task_action_tokens (Stage 8 supporting code).
 *
 * Short, opaque tokens minted when a runtime-authorization task
 * is projected onto an IM transport that supports interaction_prompt
 * (today: QQ Inline Keyboard). The token rides in the button's
 * `action.data` field — QQ's button payload is space-limited so we
 * can't encode the full ResolveTaskRequestParams there. On
 * click, the connector redeems the token to recover the original
 * payload.
 *
 * Crucially, redemption is NOT one-shot: ACK round-trips can fail and
 * QQ replays the same INTERACTION_CREATE event on retry. The redeem
 * helper checks the token's own `expires_at` only; idempotence comes
 * from `resolveTaskRequest`'s (task_id, command_id) dedup
 * (the connector derives command_id deterministically from
 * uuidv5(qqEvent.id + actionToken + clickerExternalId), so a replayed
 * click hits the same (taskId, commandId) cell and returns the
 * cached result).
 */

import { v4 as uuidv4 } from "uuid"
import { type Executor } from "../../infrastructure/database/kysely.js"
import {
  insertActionToken,
  findActionTokenRow,
  deleteExpiredActionTokens,
} from "./repo.js"

export interface ActionTokenPayload {
  /** One of the option labels we offered (e.g. "allow_once", "deny"). */
  decision: string
  /** Optional preset id (runtime-authorization preset selection). */
  preset?: string
  /** Optional grant option id when the user picks among grant_options. */
  selectedGrantOptionId?: string
}

export interface ActionTokenRecord {
  token: string
  taskId: string
  payload: ActionTokenPayload
  expiresAt: Date
}

/**
 * Mint a fresh token. Caller passes a client so the token row commits
 * atomically with the projection that uses it.
 *
 * `taskExpiresAt` is the tool_call_tasks.expires_at value
 * (which may be NULL). The token's expires_at is
 * min(task.expires_at OR now+24h, now+24h) — so the token can
 * never outlive the underlying task.
 */
export async function mintActionToken(
  executor: Executor,
  params: {
    taskId: string
    taskExpiresAt: Date | null | undefined
    payload: ActionTokenPayload
  }
): Promise<ActionTokenRecord> {
  const token = uuidv4()
  const now = Date.now()
  const twentyFourHours = now + 24 * 60 * 60 * 1000
  const taskExpiresMs = parseTimestamp(params.taskExpiresAt)
  const expiresAtMs = Math.min(
    taskExpiresMs ?? twentyFourHours,
    twentyFourHours
  )
  const expiresAt = new Date(expiresAtMs)
  await insertActionToken(executor, {
    token,
    taskId: params.taskId,
    payload: params.payload,
    expiresAt,
  })
  return {
    token,
    taskId: params.taskId,
    payload: params.payload,
    expiresAt,
  }
}

export async function lookupActionToken(
  token: string
): Promise<ActionTokenRecord | null> {
  if (!token || typeof token !== "string") return null
  const row = await findActionTokenRow(token)
  if (!row) return null
  const expiresAt = row.expiresAt
  if (expiresAt.getTime() < Date.now()) return null
  return {
    token: row.token,
    taskId: row.taskId,
    payload: (row.payload ?? {}) as unknown as ActionTokenPayload,
    expiresAt,
  }
}

/**
 * Best-effort cleanup of expired token rows. The projection worker
 * triggers this on its sweep tick; we don't bother scheduling a
 * separate cron because the volume is small.
 */
export async function sweepExpiredActionTokens(): Promise<number> {
  return deleteExpiredActionTokens()
}

function parseTimestamp(value: Date | null | undefined): number | null {
  if (!value) return null
  return value.getTime()
}
