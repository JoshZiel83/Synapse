/**
 * Personal-WeChat (ilink) inbound long-poll loop. Reads sync_buf cursor
 * from Redis so multiple replicas can hand off cleanly via the existing
 * runtime lease.
 */

import { fromUnixMillis, serverReceiveInstant } from "@synapse/shared/datetime"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type {
  AccountStartContext,
  InboundEnvelope,
  RunningAccount,
} from "../types.js"
import {
  getWeixinCredentialsOrThrow,
  postWeixinJson,
  nonEmpty,
  WEIXIN_LONG_POLL_TIMEOUT_MS,
} from "./client.js"
import { clearSyncBuf, getSyncBuf, setSyncBuf } from "./cursor-store.js"
import { enrichInboundWeixinMedia } from "./inbound-media.js"
import { normalizeWeixinMessage, type WeixinMessage } from "./normalize.js"
import {
  buildWeixinBaseInfo,
  WEIXIN_ENDPOINTS,
  WEIXIN_SESSION_EXPIRED_ERRCODE,
} from "./protocol.js"
import {
  clearSessionPause,
  getRemainingPauseMs,
  pauseSession,
} from "./session-guard.js"
import { sleep } from "../../../../infrastructure/async/index.js"

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_MS = 30_000
const RETRY_MS = 2_000
const SESSION_PAUSE_FALLBACK_MS = 60 * 60_000

function envelopeFromNormalized(
  normalized: ReturnType<typeof normalizeWeixinMessage>,
  account: TransportAccountSummary
): InboundEnvelope | null {
  if (!normalized) return null
  // `create_time_ms` (exposed as raw.createTimeMs) is documented Unix
  // MILLISECONDS. Thread the genuine event time through when present rather
  // than discarding it for now(); only fall back to server-receive when absent.
  const createTimeMs = normalized.raw.createTimeMs
  return {
    endpointType: normalized.endpointType,
    endpointExternalId: normalized.endpointExternalId,
    externalMessageId: normalized.externalMessageId,
    sender: {
      externalId: normalized.senderExternalId,
      metadata: { contextToken: normalized.contextToken },
    },
    receivedAt:
      typeof createTimeMs === "number"
        ? fromUnixMillis(createTimeMs)
        : // datetime-ok: genuine no-event-time default (create_time_ms absent).
          serverReceiveInstant(),
    message: normalized.message,
    raw: normalized.raw,
    endpointMetadata: { contextToken: normalized.contextToken },
  }
}

export async function startWeixinAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  const account = ctx.account
  const { token, baseUrl } = getWeixinCredentialsOrThrow(account)
  const cdnBaseUrl =
    typeof account.config?.cdnBaseUrl === "string"
      ? account.config.cdnBaseUrl
      : ""

  // A fresh start means a (re-)login happened — drop any stale pause flag.
  await clearSessionPause(account.id).catch(() => undefined)

  // Best-effort: tell the gateway this channel client is online.
  void postWeixinJson({
    baseUrl: baseUrl!,
    endpoint: WEIXIN_ENDPOINTS.NOTIFY_START,
    token,
    timeoutMs: 10_000,
    body: { base_info: buildWeixinBaseInfo() },
  }).catch((err) =>
    ctx.logger.error("weixin notifyStart failed (ignored)", err)
  )

  let nextTimeoutMs = WEIXIN_LONG_POLL_TIMEOUT_MS
  let consecutiveFailures = 0

  const backoff = async () => {
    const ms =
      consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_MS
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
    await sleep(ms, ctx.signal).catch(() => undefined)
  }

  const loop = (async () => {
    while (!ctx.signal.aborted) {
      const currentBuf = await getSyncBuf(account.id)
      let response: Record<string, unknown>
      try {
        response = await postWeixinJson({
          baseUrl: baseUrl!,
          endpoint: WEIXIN_ENDPOINTS.GET_UPDATES,
          token,
          timeoutMs: nextTimeoutMs,
          body: {
            get_updates_buf: currentBuf,
            base_info: buildWeixinBaseInfo(),
          },
          signal: ctx.signal,
        })
      } catch (err) {
        if (ctx.signal.aborted) return
        // A long-poll that yields nothing within the timeout aborts our
        // internal controller — that's the normal idle path, re-poll at once.
        if (err instanceof Error && err.name === "AbortError") continue
        consecutiveFailures += 1
        ctx.logger.error("weixin poll error", err)
        await backoff()
        continue
      }
      if (ctx.signal.aborted) return

      // Server can suggest the next long-poll timeout.
      const suggested = Number(response.longpolling_timeout_ms || 0)
      if (suggested > 0) nextTimeoutMs = suggested

      const ret = Number(response.ret || 0)
      const errcode = Number(response.errcode || 0)
      if (ret !== 0 || errcode !== 0) {
        if (
          ret === WEIXIN_SESSION_EXPIRED_ERRCODE ||
          errcode === WEIXIN_SESSION_EXPIRED_ERRCODE
        ) {
          // Session expired: the token is dead until the user re-scans. Pause
          // so we stop hammering the gateway; the runtime restarts on re-login.
          await pauseSession(account.id).catch(() => undefined)
          const pauseMs =
            (await getRemainingPauseMs(account.id).catch(() => 0)) ||
            SESSION_PAUSE_FALLBACK_MS
          ctx.logger.error(
            `weixin session expired (errcode ${WEIXIN_SESSION_EXPIRED_ERRCODE}); pausing ~${Math.ceil(
              pauseMs / 60_000
            )} min — re-scan QR to reconnect`
          )
          consecutiveFailures = 0
          await sleep(pauseMs, ctx.signal).catch(() => undefined)
          continue
        }
        consecutiveFailures += 1
        ctx.logger.error(
          `weixin getupdates failed: ret=${ret} errcode=${errcode} errmsg=${nonEmpty(response.errmsg) || ""}`
        )
        await backoff()
        continue
      }
      consecutiveFailures = 0

      const nextBuf = nonEmpty(response.get_updates_buf)
      if (nextBuf) await setSyncBuf(account.id, nextBuf)

      const messages = Array.isArray(response.msgs)
        ? (response.msgs as WeixinMessage[])
        : []
      for (const message of messages) {
        try {
          const normalized = normalizeWeixinMessage(message)
          const envelope = envelopeFromNormalized(normalized, account)
          if (envelope) {
            const enriched = await enrichInboundWeixinMedia(envelope, {
              account,
              cdnBaseUrl,
              logger: ctx.logger,
            })
            await ctx.emitInbound(enriched)
          }
        } catch (err) {
          ctx.logger.error("weixin inbound dispatch failed", err)
        }
      }
    }
  })()

  return {
    stop: async () => {
      // Cursor stays in Redis on graceful stop so the next worker resumes.
      // Best-effort notify the gateway we're going offline.
      void postWeixinJson({
        baseUrl: baseUrl!,
        endpoint: WEIXIN_ENDPOINTS.NOTIFY_STOP,
        token,
        timeoutMs: 10_000,
        body: { base_info: buildWeixinBaseInfo() },
      }).catch(() => undefined)
      await loop.catch(() => undefined)
    },
  }
}

export { clearSyncBuf }
