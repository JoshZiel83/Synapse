/**
 * Redis-backed store for in-flight DingTalk Device Flow registration
 * sessions.
 *
 * Mirrors the Weixin QR session pattern (qr-session-store.ts):
 *   - shared across API replicas (POST start and subsequent GET polls
 *     may land on different replicas behind a load balancer)
 *   - survives restarts (so a user mid-scan isn't black-holed)
 *
 * TTL is `expiresIn + 5min grace`. The grace window lets `GET poll`
 * return the lowercase `expired` summary instead of 404 just because
 * the Redis key vanished a heartbeat before the cleanup tick.
 *
 * `deviceCode` is intentionally kept in this store ONLY. It's the
 * actual auth secret; never include it in any response body.
 */

import { redis } from "../../../../infrastructure/redis/index.js"
import type {
  DingtalkDeviceFlowStatus,
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
} from "@synapse/shared/types"

export type RegistrationSessionStatus = DingtalkDeviceFlowStatus

/**
 * Form fields supplied to /device-registration/start that need to survive
 * until the success branch of /device-registration/:sessionId persists
 * the account. Stored on the session so the user only fills the form once.
 * Never exposed via the public summary (buildSummary picks only public
 * fields).
 */
export interface DingtalkRegistrationPendingForm {
  displayName: string
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId: string | null
  inboundActorMode: TransportAccountInboundActorMode
  inboundActorId: string | null
}

export interface DingtalkRegistrationSession {
  sessionId: string
  workspaceId: string
  /** Internal-only. Never returned to clients. */
  deviceCode: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete: string
  /** Original interval from the provider (used by the UI's poll cadence). */
  expiresInSeconds: number
  intervalSeconds: number
  /** Absolute ms timestamp when the deviceCode is expected to expire. */
  expiresAt: number
  createdAt: number
  updatedAt: number
  status: RegistrationSessionStatus
  message?: string
  transportAccountId?: string
  /**
   * Number of consecutive HTTP/network failures since the last successful
   * poll. Reset to zero whenever any successful (non-throwing) provider
   * call returns. Drives the "5th transient failure flips session to fail"
   * behavior in the controller.
   */
  providerFailureCount?: number
  lastProviderError?: string
  lastProviderErrorAt?: string
  /**
   * Form fields supplied by the caller of /device-registration/start that
   * the success branch needs to persist the account. Optional because the
   * manual route never seeds a session.
   */
  pendingForm?: DingtalkRegistrationPendingForm
}

const KEY_PREFIX = "im:dingtalk:device-flow:"
const GRACE_SECONDS = 5 * 60
const MIN_TTL_SECONDS = 60

function key(workspaceId: string, sessionId: string): string {
  return `${KEY_PREFIX}${workspaceId}:${sessionId}`
}

/**
 * Returns the absolute TTL in seconds — `expiresAt - now + grace`.
 *
 * The poll handler `set`s the session repeatedly during a session's life
 * (every waiting tick, terminal transitions, transient-failure counter
 * bumps). If we used `expiresIn + grace` here, each `set` would *slide*
 * the TTL forward from now — keeping the internal `deviceCode` secret
 * alive for arbitrarily long if poll fires frequently. Anchoring TTL to
 * the original `expiresAt` (which never moves) keeps the key around for
 * exactly grace seconds past the device code's actual expiry, matching
 * the design intent.
 *
 * `MIN_TTL_SECONDS` guards against a session whose expiresAt has already
 * passed: we still want a short tail in Redis so the next `GET poll`
 * returns lowercase `expired` instead of a confusing 404.
 */
function effectiveTtlSeconds(session: DingtalkRegistrationSession): number {
  const nowSec = Math.floor(Date.now() / 1000)
  const expiresAtSec = Math.floor(session.expiresAt / 1000)
  return Math.max(MIN_TTL_SECONDS, expiresAtSec - nowSec + GRACE_SECONDS)
}

/**
 * Clear the internal `deviceCode` secret. Called by the controller on
 * terminal session states (success/fail/expired) so the credential
 * doesn't sit in Redis any longer than necessary. The Redis key itself
 * stays around until its TTL expires so polls can still observe the
 * terminal status.
 */
export function withDeviceCodeRedacted(
  session: DingtalkRegistrationSession
): DingtalkRegistrationSession {
  if (session.deviceCode === "") return session
  return { ...session, deviceCode: "" }
}

export async function getDingtalkRegistrationSession(
  workspaceId: string,
  sessionId: string
): Promise<DingtalkRegistrationSession | null> {
  const raw = await redis.get(key(workspaceId, sessionId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as DingtalkRegistrationSession
  } catch {
    return null
  }
}

export async function setDingtalkRegistrationSession(
  session: DingtalkRegistrationSession
): Promise<void> {
  await redis.set(
    key(session.workspaceId, session.sessionId),
    JSON.stringify(session),
    "EX",
    effectiveTtlSeconds(session)
  )
}

export async function deleteDingtalkRegistrationSession(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await redis.del(key(workspaceId, sessionId))
}
