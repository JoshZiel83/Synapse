/**
 * QQ WebSocket gateway client (Stage 3).
 *
 * Lifecycle:
 *   1. GET /gateway → wss URL
 *   2. Open WS → wait for op:10 HELLO with heartbeat_interval
 *   3. If we have a saved session_id (from Redis), op:6 Resume; else
 *      op:2 Identify with shard:[0,1] + intent mask
 *   4. On op:0 Dispatch → bump lastSeq, save (throttled), normalize +
 *      emit. v1 handles C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE;
 *      INTERACTION_CREATE handling lands in Stage 8.
 *   5. On op:11 Heartbeat ACK → record the ack timestamp. If a heartbeat
 *      goes un-ACKed for >1.5x the interval, the socket is treated as
 *      half-open and force-closed (4000) to trigger reconnect+Resume.
 *   6. On op:7 Reconnect or op:9 Invalid Session → close+reconnect; the
 *      close-code handler decides whether to drop the saved session.
 *   7. Periodic op:1 heartbeat every `heartbeat_interval` ms.
 *
 * Reconnect:
 *   - Exponential backoff with jitter, capped at 60s; if we see ≥3 close
 *     events under 5s apart we treat it as a thrash and back off harder.
 *   - 4914 (bot offline) / 4915 (bot banned) → DO NOT reconnect, log
 *     and exit. Operator intervention required.
 *   - 4004 (token invalid) / 4008 (rate limited) → drop saved session,
 *     wait 60s, then try Identify from scratch.
 *
 * IDENTIFY shard MUST be `[0, 1]` (single shard out of 1, NOT the
 * `[shard_id, total]` you see on READY events which use `[0, 0]` for
 * single-shard bots). v1 is single-shard; multi-shard support
 * (/gateway/bot) is v1.5.
 */

import WebSocket from "ws"
import { computeBackoff } from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { sleep } from "../../../../infrastructure/async/index.js"
import { QQ_CLOSE_CODE, QQ_EVENT, QQ_OP, QQ_V1_INTENTS } from "./types.js"
import { qqApiFetch } from "./client.js"
import { getQqCredentialsOrThrow } from "./credentials.js"
import { getAccessToken } from "./client.js"
import { handleQqInteractionCreate } from "./interaction-handler.js"
import { enrichInboundQqMedia } from "./inbound-media.js"
import { writeLatestInboundAnchor } from "./latest-inbound-store.js"
import {
  clearQqWsSession,
  loadQqWsSession,
  saveQqWsSession,
} from "./session-store.js"
import type { ConnectorLogger } from "../types.js"
import {
  normalizeQqC2cMessage,
  normalizeQqGroupAtMessage,
  type QqC2cMessageEventData,
  type QqGroupAtMessageEventData,
} from "./normalize.js"
import type { InboundEnvelope, AccountStartContext } from "../types.js"
import type { Redis } from "ioredis"
import {
  parseQqGatewayFrame,
  parseQqGatewayHelloPayload,
  parseQqGatewayReadyPayload,
  parseQqGatewayUrlResponse,
} from "./gateway-codec.js"
import { readQqProviderJsonObjectResponse } from "./response-codec.js"

export interface QqGatewayClientOptions {
  account: AccountStartContext["account"]
  signal: AbortSignal
  logger: ConnectorLogger
  redis: Redis
  emitInbound: (envelope: InboundEnvelope) => Promise<void>
}

const MAX_RECONNECT_DELAY_MS = 60_000
const BASE_RECONNECT_DELAY_MS = 1_000
const RATE_LIMIT_DELAY_MS = 60_000
const QUICK_DISCONNECT_THRESHOLD_MS = 5_000
const QUICK_DISCONNECT_MAX = 3
const QUICK_DISCONNECT_COOLDOWN_MS = 60_000

/**
 * Long-lived account runner. Maintains a single WebSocket connection,
 * reconnecting on close until the abort signal fires.
 */
export async function runQqGateway(
  opts: QqGatewayClientOptions
): Promise<void> {
  let quickDisconnectCount = 0
  let lastDisconnectAt = 0
  let attempt = 0

  while (!opts.signal.aborted) {
    try {
      const closeInfo = await runOneConnection(opts)
      // close code handling
      const code = closeInfo.code
      const unrecoverable =
        code === QQ_CLOSE_CODE.BOT_OFFLINE || code === QQ_CLOSE_CODE.BOT_BANNED
      if (unrecoverable) {
        opts.logger.error(
          `qq-gateway: bot offline/banned (close=${code}); not reconnecting`,
          undefined,
          { accountId: opts.account.id }
        )
        return
      }
      // 4013/4014 = invalid / unauthorized intents. Re-sending the same
      // compile-time intent mask can never succeed, so treat as fatal
      // (operator must fix console authorization) instead of hot-looping
      // reconnect+Identify and burning the Identify rate budget.
      const intentsRejected =
        code === QQ_CLOSE_CODE.INVALID_INTENTS ||
        code === QQ_CLOSE_CODE.DISALLOWED_INTENTS
      if (intentsRejected) {
        opts.logger.error(
          `qq-gateway: intents rejected (close=${code}); the IDENTIFY intent mask (QQ_V1_INTENTS=${QQ_V1_INTENTS}) is invalid or not authorized in the QQ bot console. Not reconnecting until the console authorization / intent mask is fixed.`,
          undefined,
          { accountId: opts.account.id }
        )
        return
      }
      // 4009 (session timeout) is RESUMABLE per botgo — do NOT clear the
      // saved session; the next HELLO will op:6 Resume. Only 4006/4007
      // (session invalid / bad resume seq) and 4004 (token) drop it.
      const sessionInvalidated =
        code === QQ_CLOSE_CODE.SESSION_INVALID ||
        code === QQ_CLOSE_CODE.RESUME_SEQ_INVALID ||
        code === QQ_CLOSE_CODE.TOKEN_INVALID
      if (sessionInvalidated) {
        await clearQqWsSession(opts.redis, opts.account.id).catch(
          () => undefined
        )
      }
      const rateLimited = code === QQ_CLOSE_CODE.RATE_LIMITED

      // Track quick-disconnect thrash
      const now = Date.now()
      if (now - lastDisconnectAt < QUICK_DISCONNECT_THRESHOLD_MS) {
        quickDisconnectCount += 1
      } else {
        quickDisconnectCount = 0
      }
      lastDisconnectAt = now

      // Backoff before reconnecting
      let delay: number
      if (rateLimited) {
        delay = RATE_LIMIT_DELAY_MS
      } else if (quickDisconnectCount >= QUICK_DISCONNECT_MAX) {
        delay = QUICK_DISCONNECT_COOLDOWN_MS
      } else {
        delay = exponentialDelay(attempt)
      }
      attempt += 1
      opts.logger.info(
        `qq-gateway: reconnecting after ${delay}ms (close=${code} reason=${closeInfo.reason})`
      )
      await sleep(delay, opts.signal)
    } catch (err) {
      if (opts.signal.aborted) return
      attempt += 1
      const delay = exponentialDelay(attempt)
      opts.logger.error("qq-gateway: connection failed", err, { delay })
      await sleep(delay, opts.signal)
    }
  }
}

interface CloseInfo {
  code: number
  reason: string
}

async function runOneConnection(
  opts: QqGatewayClientOptions
): Promise<CloseInfo> {
  const creds = getQqCredentialsOrThrow(opts.account)
  // Ensure we have a fresh token before opening the gateway; the token
  // is also passed inside the Identify/Resume payload.
  const token = await getAccessToken(creds)
  const wssUrl = await fetchGatewayUrl(opts.account)
  const ws = new WebSocket(wssUrl)
  const accountId = opts.account.id
  const logger = opts.logger

  let heartbeatTimer: NodeJS.Timeout | undefined
  let lastSeq = 0
  let helloAcked = false
  let sessionId: string | null = null
  let lastHeartbeatSentAt = 0
  let lastHeartbeatAckAt = 0

  const close = (code = 1000, reason = "abort") => {
    try {
      ws.close(code, reason)
    } catch {
      // ignore
    }
  }

  const onAbort = () => {
    close(1000, "abort signal")
  }
  opts.signal.addEventListener("abort", onAbort, { once: true })

  const closeInfo: CloseInfo = await new Promise<CloseInfo>((resolve) => {
    let resolved = false
    const finish = (info: CloseInfo) => {
      if (resolved) return
      resolved = true
      resolve(info)
    }

    ws.on("open", async () => {
      logger.info("qq-gateway: ws opened", { accountId })
      // Resume vs identify decision happens in op:10 HELLO handler so we
      // know the heartbeat_interval first.
    })

    ws.on("message", async (raw) => {
      const parsedFrame = parseQqGatewayFrame(raw.toString())
      if (!parsedFrame.ok) {
        logger.warn("qq-gateway: invalid payload", {
          reason: parsedFrame.reason,
        })
        return
      }
      const envelope = parsedFrame.frame
      try {
        switch (envelope.op) {
          case QQ_OP.HELLO: {
            const { heartbeatInterval: interval } = parseQqGatewayHelloPayload(
              envelope.d
            )
            if (!interval || interval <= 0) {
              logger.warn(
                "qq-gateway: HELLO missing heartbeat_interval; using 30s"
              )
            }
            const beatMs = interval ?? 30_000
            heartbeatTimer = setInterval(() => {
              const now = Date.now()
              // Half-open detection: if a prior beat went un-ACKed for
              // >1.5x the interval, treat the socket as dead and force a
              // reconnect+Resume (close 4000 keeps the saved session)
              // instead of streaming heartbeats into a void until the OS
              // TCP timeout fires (minutes), during which inbound events
              // are silently lost.
              if (
                lastHeartbeatSentAt > 0 &&
                lastHeartbeatAckAt < lastHeartbeatSentAt &&
                now - lastHeartbeatSentAt > beatMs * 1.5
              ) {
                logger.warn("qq-gateway: heartbeat ack timeout; reconnecting", {
                  accountId,
                })
                close(4000, "heartbeat ack timeout")
                return
              }
              lastHeartbeatSentAt = now
              sendJson(ws, {
                op: QQ_OP.HEARTBEAT,
                d: lastSeq > 0 ? lastSeq : null,
              })
            }, beatMs)
            heartbeatTimer.unref?.()

            // Try Resume if we have a saved session that matches our appId.
            const saved = await loadQqWsSession(
              opts.redis,
              accountId,
              creds.appId
            )
            if (saved) {
              sessionId = saved.sessionId
              lastSeq = saved.lastSeq
              sendJson(ws, {
                op: QQ_OP.RESUME,
                d: {
                  token: `QQBot ${token}`,
                  session_id: saved.sessionId,
                  seq: saved.lastSeq,
                },
              })
            } else {
              sendJson(ws, {
                op: QQ_OP.IDENTIFY,
                d: {
                  token: `QQBot ${token}`,
                  intents: QQ_V1_INTENTS,
                  // v1 single-shard: this connection is shard 0 of 1.
                  shard: [0, 1],
                  properties: {},
                },
              })
            }
            helloAcked = true
            return
          }
          case QQ_OP.HEARTBEAT_ACK:
            lastHeartbeatAckAt = Date.now()
            return
          case QQ_OP.RECONNECT:
            // Server-initiated reconnect — keep the session id so we can
            // resume after reopening.
            logger.info("qq-gateway: server requested RECONNECT")
            close(4000, "server requested reconnect")
            return
          case QQ_OP.INVALID_SESSION: {
            // envelope.d is a boolean: true = session resumable (keep
            // sessionId/lastSeq so the next HELLO sends op:6 Resume);
            // false = drop them so the next HELLO sends op:2 Identify.
            // Either way we close 4000 to trigger reconnect.
            const resumable = envelope.d === true
            logger.warn("qq-gateway: INVALID_SESSION", { resumable })
            if (!resumable) {
              sessionId = null
              lastSeq = 0
              await clearQqWsSession(opts.redis, accountId).catch(
                () => undefined
              )
            }
            close(4000, "invalid session")
            return
          }
          case QQ_OP.DISPATCH: {
            if (typeof envelope.s === "number" && envelope.s > lastSeq) {
              lastSeq = envelope.s
            }
            const t = envelope.t
            if (t === QQ_EVENT.READY) {
              const ready = parseQqGatewayReadyPayload(envelope.d)
              if (ready.sessionId) {
                sessionId = ready.sessionId
              }
              logger.info("qq-gateway: READY", {
                accountId,
                sessionId,
                user: ready.username,
              })
            } else if (t === QQ_EVENT.RESUMED) {
              logger.info("qq-gateway: RESUMED", { accountId })
            } else {
              await routeBusinessDispatch(t, envelope.d, opts, logger)
            }
            // Persist session/seq for resume after restart.
            if (sessionId) {
              await saveQqWsSession(opts.redis, accountId, {
                sessionId,
                lastSeq,
                appId: creds.appId,
              }).catch((err) => {
                logger.warn("qq-gateway: failed to save session", {
                  err: String(err),
                })
              })
            }
            return
          }
          default:
            logger.debug(`qq-gateway: ignored op=${envelope.op}`)
        }
      } catch (err) {
        logger.error("qq-gateway: message handler crashed", err)
      }
    })

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      const reason = reasonBuf?.toString?.() ?? ""
      logger.info("qq-gateway: ws closed", {
        code,
        reason,
        accountId,
        helloAcked,
      })
      opts.signal.removeEventListener("abort", onAbort)
      finish({ code, reason })
    })

    ws.on("error", (err) => {
      logger.warn("qq-gateway: ws error", { err: String(err) })
      // The ws library will fire 'close' shortly after; don't resolve here.
    })
  })

  return closeInfo
}

async function fetchGatewayUrl(
  account: AccountStartContext["account"]
): Promise<string> {
  const res = await qqApiFetch(account, "/gateway")
  if (!res.ok) {
    throw new Error(
      `qq-gateway: /gateway failed ${res.status} ${await res.text().catch(() => "")}`
    )
  }
  const url = parseQqGatewayUrlResponse(
    await readQqProviderJsonObjectResponse(res)
  )
  if (!url) {
    throw new Error("qq-gateway: /gateway returned no url")
  }
  return url
}

async function routeBusinessDispatch(
  t: string | undefined,
  data: unknown,
  opts: QqGatewayClientOptions,
  logger: ConnectorLogger
): Promise<void> {
  switch (t) {
    case QQ_EVENT.C2C_MESSAGE_CREATE: {
      const env = await normalizeQqC2cMessage(data as QqC2cMessageEventData, {
        accountId: opts.account.id,
      })
      if (!env) {
        logger.warn("qq-gateway: C2C event missing required fields")
        return
      }
      const enriched = await enrichInboundQqMedia(env, {
        account: opts.account,
        logger,
      })
      await recordWsAnchor(
        opts,
        enriched,
        "msg_id",
        enriched.externalMessageId,
        t
      )
      await opts.emitInbound(enriched)
      return
    }
    case QQ_EVENT.GROUP_AT_MESSAGE_CREATE: {
      const env = await normalizeQqGroupAtMessage(
        data as QqGroupAtMessageEventData,
        { accountId: opts.account.id }
      )
      if (!env) {
        logger.warn("qq-gateway: GROUP_AT event missing required fields")
        return
      }
      const enriched = await enrichInboundQqMedia(env, {
        account: opts.account,
        logger,
      })
      await recordWsAnchor(
        opts,
        enriched,
        "msg_id",
        enriched.externalMessageId,
        t
      )
      await opts.emitInbound(enriched)
      return
    }
    case QQ_EVENT.INTERACTION_CREATE: {
      // Record the event_id anchor first (independent of resolution) so
      // any synchronous outbound that needs to reply to the button
      // click can find it.
      const d = (data ?? {}) as {
        id?: string
        group_openid?: string
        group_member_openid?: string
        user_openid?: string
        data?: {
          resolved?: {
            button_data?: string
            button_id?: string
            user_id?: string
          }
          type?: number
        }
      }
      if (typeof d.id === "string" && d.id) {
        if (typeof d.group_openid === "string" && d.group_openid) {
          await writeLatestInboundAnchor(opts.redis, {
            accountId: opts.account.id,
            endpointType: "group",
            endpointExternalId: d.group_openid,
            anchor: {
              anchorKind: "event_id",
              anchorId: d.id,
              eventType: t,
              receivedAt: nowIsoInstant(),
            },
          }).catch(() => undefined)
        } else if (typeof d.user_openid === "string" && d.user_openid) {
          await writeLatestInboundAnchor(opts.redis, {
            accountId: opts.account.id,
            endpointType: "direct",
            endpointExternalId: `c2c:${d.user_openid}`,
            anchor: {
              anchorKind: "event_id",
              anchorId: d.id,
              eventType: t,
              receivedAt: nowIsoInstant(),
            },
          }).catch(() => undefined)
        }
      }
      // Stage 8: durable resolve then ACK. handleQqInteractionCreate
      // owns the full flow (button parse → token lookup → workspace
      // member resolution → resolveTaskRequest → PUT ACK).
      await handleQqInteractionCreate({
        account: opts.account,
        data: d,
        logger,
      }).catch((err) => {
        logger.error("qq-gateway: INTERACTION_CREATE handler crashed", err)
      })
      return
    }
    case QQ_EVENT.GROUP_MESSAGE_CREATE:
      // Non-@ group message — v1 ignores.
      return
    default:
      logger.debug(`qq-gateway: ignored dispatch t=${t}`)
  }
}

async function recordWsAnchor(
  opts: QqGatewayClientOptions,
  env: InboundEnvelope,
  anchorKind: "msg_id" | "event_id",
  anchorId: string,
  eventType: string
): Promise<void> {
  await writeLatestInboundAnchor(opts.redis, {
    accountId: opts.account.id,
    endpointType: env.endpointType,
    endpointExternalId: env.endpointExternalId,
    anchor: {
      anchorKind,
      anchorId,
      eventType,
      receivedAt: env.receivedAt,
    },
  }).catch((err) => {
    opts.logger.warn(
      `qq-gateway: failed to write latest-inbound anchor for ${env.endpointExternalId}`,
      { err: String(err) }
    )
  })
}

function sendJson(ws: WebSocket, value: unknown): void {
  try {
    ws.send(JSON.stringify(value))
  } catch (err) {
    // Best-effort; close handler will fire.
    void err
  }
}

function exponentialDelay(attempt: number): number {
  return computeBackoff(attempt, {
    baseMs: BASE_RECONNECT_DELAY_MS,
    maxMs: MAX_RECONNECT_DELAY_MS,
    minMs: BASE_RECONNECT_DELAY_MS,
    maxExponent: 8,
    jitterMode: "symmetric",
    jitter: 0.2,
  })
}
