// IM presentation layer: domain/session records → app-facing views. Owns the
// outward Date/ms → IsoInstantString serialization so controllers/services
// don't call serializeInstant directly (guard-layering r3). round-6 P1-9.

import type {
  DingtalkDeviceFlowSessionSummary,
  TransportAccountSummary,
  WeixinQrLoginSessionSummary,
} from "@synapse/shared"
import { serializeInstant } from "../../infrastructure/datetime.js"

/** The session fields the dingtalk device-flow presenter reads (ms epochs). */
export type DingtalkDeviceFlowSessionRecord = {
  sessionId: string
  workspaceId: string
  status: DingtalkDeviceFlowSessionSummary["status"]
  message?: string
  verificationUriComplete: string
  verificationUri?: string
  userCode?: string
  expiresInSeconds: number
  intervalSeconds: number
  createdAt: number
  updatedAt: number
  expiresAt: number
}

/**
 * Present a DingTalk device-flow registration session as its app-facing view.
 * `transportAccount` is resolved by the caller (it needs a DB read) and injected
 * so this stays a pure synchronous presentation transform — the ms→ISO instant
 * serialization is the presenter's job, not the controller's.
 */
export function presentDingtalkDeviceFlowSession(
  session: DingtalkDeviceFlowSessionRecord,
  transportAccount: TransportAccountSummary | undefined
): DingtalkDeviceFlowSessionSummary {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    status: session.status,
    message: session.message,
    verificationUriComplete: session.verificationUriComplete,
    verificationUri: session.verificationUri,
    userCode: session.userCode,
    expiresInSeconds: session.expiresInSeconds,
    intervalSeconds: session.intervalSeconds,
    createdAt: serializeInstant(new Date(session.createdAt)),
    updatedAt: serializeInstant(new Date(session.updatedAt)),
    expiresAt: serializeInstant(new Date(session.expiresAt)),
    transportAccount,
  }
}

/** The session fields the weixin QR-login presenter reads (ms epochs). */
export type WeixinQrLoginSessionRecord = {
  sessionId: string
  workspaceId: string
  status: WeixinQrLoginSessionSummary["status"]
  message: string
  qrCodeUrl?: string
  baseUrl?: string
  botId?: string
  scannerUserId?: string
  createdAt: number
  updatedAt: number
  expiresAt: number
}

/**
 * Present a Weixin QR-login session as its app-facing view. `transportAccount`
 * is resolved by the caller (DB read) and injected so this stays a pure
 * synchronous ms→ISO transform (guard-layering r3).
 */
export function presentWeixinQrLoginSession(
  session: WeixinQrLoginSessionRecord,
  transportAccount: TransportAccountSummary | undefined
): WeixinQrLoginSessionSummary {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    status: session.status,
    message: session.message,
    qrCodeUrl: session.qrCodeUrl,
    baseUrl: session.baseUrl,
    botId: session.botId,
    scannerUserId: session.scannerUserId,
    createdAt: serializeInstant(new Date(session.createdAt)),
    updatedAt: serializeInstant(new Date(session.updatedAt)),
    expiresAt: serializeInstant(new Date(session.expiresAt)),
    transportAccount,
  }
}
