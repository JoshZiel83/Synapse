/**
 * Redis-backed login-session store for the Baileys QR / pairing flow.
 *
 * Mirrors weixin/qr-session-store.ts: a short-lived record holding the current
 * QR data-URL (or pairing code) and the login status, polled by the controller
 * until it flips to `linked` (or `expired`/`error`). Timestamps are stored as
 * ms numbers; a strict zod schema validates on read.
 *
 * The live Baileys login socket itself is held in an in-process map keyed by
 * sessionId (it cannot be serialized to Redis); Redis only carries the
 * pollable status. A login that started on another replica is therefore not
 * resumable — acceptable for an interactive, single-tab QR scan.
 */

import { z } from "zod"
import { redis as defaultRedis } from "../../../../infrastructure/redis/index.js"
import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
} from "@synapse/shared/types"

/** Minimal Redis surface; tests inject an in-memory stub (DI seam). */
export interface LoginSessionRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
}

let redis: LoginSessionRedis = defaultRedis as unknown as LoginSessionRedis

/** Test seam: swap the redis client. Returns a restore fn. */
export function setRedisForTest(client: LoginSessionRedis): () => void {
  const prev = redis
  redis = client
  return () => {
    redis = prev
  }
}

const KEY_PREFIX = "im:whatsapp_unofficial:qr-session:"
const SESSION_TTL_SECONDS = 6 * 60 // 6 minutes

export const WHATSAPP_LOGIN_STATUSES = [
  "pending", // socket opened, no QR yet
  "qr", // QR data-URL available to scan
  "pairing", // pairing code issued
  "linked", // paired + account persisted
  "expired", // QR/pairing window lapsed
  "error", // login failed
] as const
export type WhatsappLoginStatus = (typeof WHATSAPP_LOGIN_STATUSES)[number]

const timestampMsSchema = z.number().int().nonnegative()

export interface WhatsappLoginSession {
  sessionId: string
  workspaceId: string
  status: WhatsappLoginStatus
  /** data-URL PNG of the QR (when status === "qr"). */
  qrDataUrl?: string
  /** pairing code (when status === "pairing"). */
  pairingCode?: string
  /** E.164 number for pairing-code login (no plus). */
  phoneNumberE164?: string
  displayName?: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
  /** Set once linked. */
  transportAccountId?: string
  errorMessage?: string
  createdAt: number
  updatedAt: number
  expiresAt: number
}

const sessionSchema = z
  .object({
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1),
    status: z.enum(WHATSAPP_LOGIN_STATUSES),
    qrDataUrl: z.string().optional(),
    pairingCode: z.string().optional(),
    phoneNumberE164: z.string().optional(),
    displayName: z.string().optional(),
    ownerScope: z.string().optional(),
    ownerWorkspaceMemberId: z.string().nullable().optional(),
    inboundActorMode: z.string().optional(),
    inboundActorId: z.string().nullable().optional(),
    transportAccountId: z.string().optional(),
    errorMessage: z.string().optional(),
    createdAt: timestampMsSchema,
    updatedAt: timestampMsSchema,
    expiresAt: timestampMsSchema,
  })
  .strict()

function key(workspaceId: string, sessionId: string): string {
  return `${KEY_PREFIX}${workspaceId}:${sessionId}`
}

export function parseWhatsappLoginSession(
  raw: string | null
): WhatsappLoginSession | null {
  if (!raw) return null
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? (parsed.data as WhatsappLoginSession) : null
  } catch {
    return null
  }
}

export async function getLoginSession(
  workspaceId: string,
  sessionId: string
): Promise<WhatsappLoginSession | null> {
  const raw = await redis.get(key(workspaceId, sessionId))
  return parseWhatsappLoginSession(raw)
}

export async function setLoginSession(
  session: WhatsappLoginSession
): Promise<void> {
  await redis.set(
    key(session.workspaceId, session.sessionId),
    JSON.stringify(session),
    "EX",
    SESSION_TTL_SECONDS
  )
}

export async function deleteLoginSession(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await redis.del(key(workspaceId, sessionId))
}
