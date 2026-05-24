/**
 * Redis-backed store for the in-flight Weixin QR login sessions.
 *
 * Replaces the per-process Map in the old weixin-qr.ts so that:
 *   - multi-replica API can share QR session state (the user's POST that
 *     creates the session and the subsequent polls might land on different
 *     replicas behind the load balancer)
 *   - a restart doesn't black-hole a user who's mid-scan
 *
 * Each session is serialized as JSON with a 6-minute TTL (slightly longer
 * than the 5-min QR validity, so we can return "expired" to the client
 * instead of "session not found").
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
  WeixinQrLoginStatus,
} from "@synapse/shared/types"

export interface ActiveWeixinQrLogin {
  sessionId: string
  workspaceId: string
  qrcode: string
  qrCodeUrl: string
  baseUrl: string
  botType: string
  displayName?: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId?: string | null
  status: WeixinQrLoginStatus
  message: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  transportAccountId?: string
  botId?: string
  scannerUserId?: string
}

const KEY_PREFIX = "im:weixin:qr-session:"
const SESSION_TTL_SECONDS = 6 * 60 // 6 minutes

function key(workspaceId: string, sessionId: string): string {
  return `${KEY_PREFIX}${workspaceId}:${sessionId}`
}

export async function getQrSession(
  workspaceId: string,
  sessionId: string
): Promise<ActiveWeixinQrLogin | null> {
  const raw = await redis.get(key(workspaceId, sessionId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ActiveWeixinQrLogin
  } catch {
    return null
  }
}

export async function setQrSession(
  session: ActiveWeixinQrLogin
): Promise<void> {
  await redis.set(
    key(session.workspaceId, session.sessionId),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS
  )
}

export async function deleteQrSession(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await redis.del(key(workspaceId, sessionId))
}
