/**
 * Telegram inbound — startAccount + handleWebhook.
 *
 *   - `startAccount(ctx)`: for `long_connection` accounts, run the getUpdates
 *     loop (long-poll.ts). For `webhook` accounts, return a no-op `{ stop }` —
 *     the runtime reconcile loop only invokes startAccount for long_connection
 *     accounts, so the webhook branch is unreachable in practice but kept for
 *     contract completeness.
 *   - `handleWebhook(input)`: verify the `X-Telegram-Bot-Api-Secret-Token`
 *     header → normalize → enrich media → emitInbound → 200. Always answer
 *     200 on a verified update (Telegram retries non-200) and dedup by
 *     `update_id`.
 */

import type {
  AccountStartContext,
  RunningAccount,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"
import { startTelegramLongPoll } from "./long-poll.js"
import { enrichInboundTelegramMedia } from "./inbound-media.js"
import { normalizeTelegramMessage } from "./normalize.js"
import { getTelegramCredentialsOrThrow } from "./credentials.js"
import { verifyTelegramWebhookSecret } from "./webhook-signature.js"
import { isDuplicateUpdate } from "./webhook-dedup.js"
import type { TelegramMessage, TelegramUpdate } from "./types.js"

export async function startTelegramAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  if (ctx.account.connectionMode === "webhook") {
    // Never invoked by the runtime (long_connection-only). Kept for symmetry.
    return { stop: async () => {} }
  }
  return startTelegramLongPoll(ctx)
}

function messageOfUpdate(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post ?? update.edited_message
}

/** Test seams for handleTelegramWebhook (default to the real impls). */
export interface TelegramWebhookDeps {
  isDuplicate?: (accountId: string, updateId: number) => Promise<boolean>
  enrich?: typeof enrichInboundTelegramMedia
}

export async function handleTelegramWebhook(
  input: WebhookHandlerInput,
  deps: TelegramWebhookDeps = {}
): Promise<WebhookHandlerResult> {
  const logger = input.logger
  const isDuplicate = deps.isDuplicate ?? isDuplicateUpdate
  const enrich = deps.enrich ?? enrichInboundTelegramMedia
  let creds: ReturnType<typeof getTelegramCredentialsOrThrow>
  try {
    creds = getTelegramCredentialsOrThrow(input.account)
  } catch (err) {
    logger?.error?.("telegram: webhook missing credentials", err)
    return { statusCode: 500, body: { ok: false } }
  }

  // Verify the secret-token header (constant-time). Reject on mismatch.
  const verified = verifyTelegramWebhookSecret({
    headers: input.headers,
    expected: creds.webhookSecretToken,
  })
  if (!verified) {
    logger?.warn?.("telegram: webhook secret-token mismatch")
    return { statusCode: 401, body: { ok: false } }
  }

  const update = input.body as TelegramUpdate
  if (!update || typeof update.update_id !== "number") {
    return { statusCode: 400, body: { ok: false } }
  }

  // Dedup by update_id (at-least-once on both webhook + poll).
  if (await isDuplicate(input.account.id, update.update_id)) {
    return { statusCode: 200, body: { ok: true } }
  }

  const message = messageOfUpdate(update)
  if (!message) {
    // Non-message update (reaction/membership) — ack so Telegram stops retrying.
    return { statusCode: 200, body: { ok: true } }
  }

  try {
    const envelope = normalizeTelegramMessage(message)
    if (envelope) {
      const enriched = await enrich(envelope, {
        account: input.account,
        logger,
      })
      await input.emitInbound(enriched)
    }
  } catch (err) {
    logger?.error?.("telegram: webhook dispatch failed", err, {
      updateId: update.update_id,
    })
    // Still 200 — a non-200 makes Telegram retry the same update forever.
  }
  return { statusCode: 200, body: { ok: true } }
}
