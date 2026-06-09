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
 *   5. On op:1 Heartbeat ack → record ts (used to detect zombie conn).
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
import {
  QQ_CLOSE_CODE,
  QQ_EVENT,
  QQ_OP,
  QQ_V1_INTENTS,
  type QqEventName,
} from "./types.js"
import { qqApiFetch } from "./client.js"
import { getQqCredentialsOrThrow } from "./credentials.js"
import { getAccessToken } from "./client.js"
import { handleQqInteractionCreate } from "./interaction-handler.js"
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

export interface QqGatewayClientOptions {
  account: AccountStartContext["account"]
  signal: AbortSignal
  logger: ConnectorLogger
  redis: Redis
  emitInbound: (envelope: InboundEnvelope) => Promise<void>
}

interface DispatchEnvelope {
  op: number
  d?: unknown
  s?: number
  t?: string
}

interface HelloPayload {
  heartbeat_interval?: number
}

interface ReadyPayload {
  version?: number
  session_id?: string
  user?: { id?: string; username?: string }
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
      const sessionInvalidated =
        code === QQ_CLOSE_CODE.SESSION_INVALID ||
        code === QQ_CLOSE_CODE.RESUME_SEQ_INVALID ||
        code === QQ_CLOSE_CODE.SESSION_TIMEOUT ||
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
      const delay = rateLimited
        ? RATE_LIMIT_DELAY_MS
        : quickDisconnectCount >= QUICK_DISCONNECT_MAX
          ? QUICK_DISCONNECT_COOLDOWN_MS
          : exponentialDelay(attempt)
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
      let envelope: DispatchEnvelope
      try {
        envelope = JSON.parse(raw.toString()) as DispatchEnvelope
      } catch (err) {
        logger.warn("qq-gateway: invalid JSON payload", { err: String(err) })
        return
      }
      try {
        switch (envelope.op) {
          case QQ_OP.HELLO: {
            const interval = (envelope.d as HelloPayload | undefined)
              ?.heartbeat_interval
            if (!interval || interval <= 0) {
              logger.warn(
                "qq-gateway: HELLO missing heartbeat_interval; using 30s"
              )
            }
            const beatMs = interval ?? 30_000
            heartbeatTimer = setInterval(() => {
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
            return
          case QQ_OP.RECONNECT:
            // Server-initiated reconnect — keep the session id so we can
            // resume after reopening.
            logger.info("qq-gateway: server requested RECONNECT")
            close(4000, "server requested reconnect")
            return
          case QQ_OP.INVALID_SESSION: {
            // d is true if resumable, false if not (we always drop).
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
            const t = envelope.t as QqEventName | undefined
            if (t === QQ_EVENT.READY) {
              const ready = envelope.d as ReadyPayload | undefined
              if (ready?.session_id) {
                sessionId = ready.session_id
              }
              logger.info("qq-gateway: READY", {
                accountId,
                sessionId,
                user: ready?.user?.username,
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
            return
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

interface GatewayResponse {
  url?: string
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
  const body = (await res.json()) as GatewayResponse
  if (!body.url) {
    throw new Error("qq-gateway: /gateway returned no url")
  }
  return body.url
}

async function routeBusinessDispatch(
  t: QqEventName | undefined,
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
      await recordWsAnchor(opts, env, "msg_id", env.externalMessageId, t)
      await opts.emitInbound(env)
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
      await recordWsAnchor(opts, env, "msg_id", env.externalMessageId, t)
      await opts.emitInbound(env)
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
      return
  }
}

async function recordWsAnchor(
  opts: QqGatewayClientOptions,
  env: InboundEnvelope,
  anchorKind: "msg_id" | "event_id",
  anchorId: string,
  eventType: QqEventName
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
