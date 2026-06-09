/**
 * Personal-WeChat (ilinkai) inbound long-poll loop. Reads sync_buf cursor
 * from Redis so multiple replicas can hand off cleanly via the existing
 * runtime lease.
 */

import { nowIsoInstant } from "@synapse/shared/datetime"
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
import { normalizeWeixinMessage, type WeixinMessage } from "./normalize.js"
import { sleep } from "../../../../infrastructure/async/index.js"

function envelopeFromNormalized(
  normalized: ReturnType<typeof normalizeWeixinMessage>,
  account: TransportAccountSummary
): InboundEnvelope | null {
  if (!normalized) return null
  return {
    endpointType: normalized.endpointType,
    endpointExternalId: normalized.endpointExternalId,
    externalMessageId: normalized.externalMessageId,
    sender: {
      externalId: normalized.senderExternalId,
      metadata: { contextToken: normalized.contextToken },
    },
    receivedAt: nowIsoInstant(),
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

  const loop = (async () => {
    while (!ctx.signal.aborted) {
      const currentBuf = await getSyncBuf(account.id)
      try {
        const response = await postWeixinJson({
          baseUrl: baseUrl!,
          endpoint: "ilink/bot/getupdates",
          token,
          timeoutMs: WEIXIN_LONG_POLL_TIMEOUT_MS,
          body: { get_updates_buf: currentBuf, base_info: {} },
          signal: ctx.signal,
        })
        if (ctx.signal.aborted) return

        const ret = Number(response.ret || 0)
        const errcode = Number(response.errcode || 0)
        if (ret !== 0 || errcode !== 0) {
          throw new Error(
            `Weixin getupdates failed: ret=${ret} errcode=${errcode} errmsg=${nonEmpty(response.errmsg) || ""}`
          )
        }

        const nextBuf = nonEmpty(response.get_updates_buf)
        if (nextBuf) {
          await setSyncBuf(account.id, nextBuf)
        }

        const messages = Array.isArray(response.msgs)
          ? (response.msgs as WeixinMessage[])
          : []
        for (const message of messages) {
          try {
            const normalized = normalizeWeixinMessage(message)
            const envelope = envelopeFromNormalized(normalized, account)
            if (envelope) await ctx.emitInbound(envelope)
          } catch (err) {
            ctx.logger.error("weixin inbound dispatch failed", err)
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) return
        ctx.logger.error("weixin poll error", err)
        await sleep(2_000, ctx.signal).catch(() => undefined)
      }
    }
  })()

  return {
    stop: async () => {
      // Cursor stays in Redis on graceful stop so the next worker resumes.
      await loop.catch(() => undefined)
    },
  }
}

export { clearSyncBuf }
