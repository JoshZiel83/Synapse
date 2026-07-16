/**
 * Telegram getUpdates long-poll loop.
 *
 * `while(!signal.aborted)`:
 *   getUpdates({offset, limit:100, timeout:30, allowed_updates}) → emit each →
 *   offset = max(update_id)+1 → persist to cursor-store.
 *
 * Lifecycle details (all load-bearing):
 *   - FIRST iteration: `deleteWebhook` (getUpdates 409s while a webhook is
 *     set) AND send `allowed_updates` EXPLICITLY including "message_reaction"
 *     and "chat_member" (allowed_updates is sticky; an empty list silently
 *     drops those). Subsequent polls omit allowed_updates to keep the sticky
 *     setting.
 *   - Cursor lives in Redis (im:telegram:offset:<accountId>) so a lease
 *     handoff resumes correctly. We persist the advanced offset BEFORE
 *     dispatching the batch's messages (and always advance even on a
 *     dispatch error path) to avoid the redelivery loop.
 *   - On stop, a final confirm poll acks the last batch (SKIPPED after a fatal
 *     exit — there is nothing to confirm and the token is dead/conflicting).
 *   - 401 (bad token) / 409 (another getUpdates holder) → FATAL: log.error +
 *     `return` (graceful exit — this loop is detached and never awaited by the
 *     runtime, so throwing would only surface as an unhandled rejection + a
 *     lease-holding zombie). 429 → honor parameters.retry_after. Else → 3s
 *     backoff.
 *   - Tracing: every getUpdates call (the loop poll AND stop()'s confirm) runs
 *     under `suppressTracing` — at 100% sampling each poll cycle would
 *     otherwise emit a fresh-root CLIENT span (~2-3k/day/account of pure
 *     transport noise). Suppression is enforced by the SDK Tracer + propagator,
 *     and is scoped to the poll fetch ONLY: inbound dispatch (emitInbound) runs
 *     outside the suppressed context so message-level instrumentation stays
 *     live. Fatal 401/409 visibility remains via logger.error.
 */

import { context } from "@opentelemetry/api"
import { suppressTracing } from "@opentelemetry/core"
import { sleep } from "../../../../infrastructure/async/index.js"
import type { AccountStartContext, RunningAccount } from "../types.js"
import { callMethod, TelegramApiError } from "./client.js"
import { getTelegramCredentialsOrThrow } from "./credentials.js"
import { enrichInboundTelegramMedia } from "./inbound-media.js"
import { normalizeTelegramMessage } from "./normalize.js"
import { getOffset, setOffset } from "./cursor-store.js"
import {
  TELEGRAM_ALLOWED_UPDATES,
  TELEGRAM_ERROR_CODE,
  TELEGRAM_GET_UPDATES_LIMIT,
  TELEGRAM_LONG_POLL_TIMEOUT_SEC,
  type TelegramMessage,
  type TelegramUpdate,
} from "./types.js"

const BACKOFF_MS = 3_000
// getUpdates holds open for `timeout` seconds; give the HTTP call headroom.
const POLL_HTTP_TIMEOUT_MS = (TELEGRAM_LONG_POLL_TIMEOUT_SEC + 10) * 1_000

/** Extract the inbound message from an update (message / channel_post). */
function messageOfUpdate(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post ?? update.edited_message
}

/** Test seams (default to the real cursor-store + media enrich). */
export interface LongPollDeps {
  getOffset?: typeof getOffset
  setOffset?: typeof setOffset
  enrich?: typeof enrichInboundTelegramMedia
}

export async function startTelegramLongPoll(
  ctx: AccountStartContext,
  deps: LongPollDeps = {}
): Promise<RunningAccount> {
  const { account, signal, emitInbound, logger } = ctx
  const creds = getTelegramCredentialsOrThrow(account)
  const readOffset = deps.getOffset ?? getOffset
  const writeOffset = deps.setOffset ?? setOffset
  const enrich = deps.enrich ?? enrichInboundTelegramMedia

  // Set when the loop exits because of a fatal 401/409 so stop() can skip its
  // best-effort confirm poll (the token is revoked or another holder owns the
  // poll — a confirm getUpdates would just 401/409 again).
  let fatal = false

  const loop = (async () => {
    let first = true
    let offset = await readOffset(account.id)

    while (!signal.aborted) {
      // On the first poll, drop any webhook so getUpdates won't 409.
      if (first) {
        try {
          await callMethod(creds, "deleteWebhook", {
            drop_pending_updates: false,
          })
        } catch (err) {
          logger.warn("telegram: deleteWebhook before poll failed", {
            err: String(err),
          })
        }
      }

      let updates: TelegramUpdate[]
      try {
        // Poll transport is trace-dark (see header): suppress the CLIENT span
        // + context injection for the fetch only — dispatch below is outside.
        updates = await context.with(suppressTracing(context.active()), () =>
          callMethod<TelegramUpdate[]>(
            creds,
            "getUpdates",
            {
              offset,
              limit: TELEGRAM_GET_UPDATES_LIMIT,
              timeout: TELEGRAM_LONG_POLL_TIMEOUT_SEC,
              // allowed_updates is sticky: send the explicit list ONLY on the
              // first poll (empty/omitted thereafter keeps the setting).
              ...(first
                ? { allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] }
                : {}),
            },
            { timeoutMs: POLL_HTTP_TIMEOUT_MS }
          )
        )
        first = false
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof TelegramApiError) {
          if (
            err.errorCode === TELEGRAM_ERROR_CODE.UNAUTHORIZED ||
            err.errorCode === TELEGRAM_ERROR_CODE.CONFLICT
          ) {
            // FATAL — bad token, or another getUpdates holder. Don't loop.
            // This loop is DETACHED (the runtime never awaits it), so throwing
            // would surface only as an unhandled rejection while the revoked
            // bot keeps renewing its lease. Log + flag + return for a graceful
            // exit; stop()'s confirm poll is skipped on this flag.
            logger.error("telegram: fatal getUpdates error", err, {
              accountId: account.id,
              code: err.errorCode,
            })
            fatal = true
            return
          }
          if (err.errorCode === TELEGRAM_ERROR_CODE.TOO_MANY_REQUESTS) {
            const waitMs = (err.retryAfter ?? 3) * 1_000
            await sleep(waitMs, signal).catch(() => undefined)
            continue
          }
        }
        logger.warn("telegram: getUpdates error; backing off", {
          err: String(err),
        })
        await sleep(BACKOFF_MS, signal).catch(() => undefined)
        continue
      }

      if (signal.aborted) return
      if (updates.length === 0) continue

      // Advance + persist the cursor BEFORE dispatch (max update_id + 1).
      const maxUpdateId = updates.reduce(
        (m, u) => (u.update_id > m ? u.update_id : m),
        offset - 1
      )
      offset = maxUpdateId + 1
      await writeOffset(account.id, offset).catch((err) =>
        logger.warn("telegram: failed to persist offset", { err: String(err) })
      )

      for (const update of updates) {
        try {
          await dispatchUpdate({ update, account, emitInbound, logger, enrich })
        } catch (err) {
          logger.error("telegram: inbound dispatch failed", err, {
            updateId: update.update_id,
          })
        }
      }
    }
  })()

  return {
    stop: async () => {
      // Drain the loop FIRST (abort is owned by ctx.signal — the runtime aborts
      // it; the loop exits promptly via its signal.aborted checks). Draining
      // first lets the `fatal` flag settle before we decide on the confirm
      // poll. THEN best-effort confirm so the last batch isn't redelivered.
      // Skip the confirm entirely after a fatal exit (401/409): the token is
      // revoked or another holder owns getUpdates, so a confirm would just
      // 401/409 again.
      await loop.catch(() => undefined)
      if (fatal) return
      try {
        const offset = await readOffset(account.id)
        if (offset > 0) {
          // Same trace suppression as the loop poll — the confirm is poll
          // transport too.
          await context.with(suppressTracing(context.active()), () =>
            callMethod(creds, "getUpdates", {
              offset,
              limit: 1,
              timeout: 0,
            })
          )
        }
      } catch {
        // ignore — confirm is best-effort
      }
    },
  }
}

async function dispatchUpdate(input: {
  update: TelegramUpdate
  account: AccountStartContext["account"]
  emitInbound: AccountStartContext["emitInbound"]
  logger: AccountStartContext["logger"]
  enrich: typeof enrichInboundTelegramMedia
}): Promise<void> {
  const message = messageOfUpdate(input.update)
  if (!message) {
    // message_reaction / chat_member / etc. — not modeled as inbound in v1.
    input.logger.debug?.("telegram: non-message update ignored", {
      updateId: input.update.update_id,
    })
    return
  }
  const envelope = normalizeTelegramMessage(message)
  if (!envelope) return
  const enriched = await input.enrich(envelope, {
    account: input.account,
    logger: input.logger,
  })
  await input.emitInbound(enriched)
}
