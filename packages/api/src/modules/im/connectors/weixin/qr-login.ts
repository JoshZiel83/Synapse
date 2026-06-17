/**
 * Personal-WeChat (ilinkai) QR-code login flow.
 *
 * Migrated from modules/im/weixin-qr.ts so the QR-scan path lives inside
 * the weixin connector boundary alongside the runtime, outbound, typing,
 * etc. Sessions are now stored in Redis (qr-session-store.ts), so
 * multi-replica deployments share QR state and a restart mid-scan doesn't
 * orphan the user.
 */

import crypto from "node:crypto"
import { serializeNowInstant } from "../../../../infrastructure/datetime.js"
import { presentWeixinQrLoginSession } from "../../presenter.js"
import { WEIXIN_QR_LOGIN_STATUS } from "@synapse/shared"
import type {
  TransportAccountInboundActorMode,
  TransportAccountSummary,
  TransportAccountOwnerScope,
  WeixinQrLoginSessionSummary,
  WeixinQrLoginStatus,
} from "@synapse/shared/types"
import {
  createTransportAccount,
  ensureTransportAddress,
  getTransportAccountById,
  getTransportAccountByWorkspaceKindAndKey,
  updateTransportAccount,
} from "../../service.js"
import { refreshTransportRuntimeManager } from "../../runtime.js"
import {
  deleteQrSession,
  getQrSession,
  setQrSession,
  type ActiveWeixinQrLogin,
} from "./qr-session-store.js"
import {
  parseWeixinQrStatusResponseText,
  type WeixinQrStatusResponse,
} from "./qr-login-codec.js"
import { buildWeixinGetHeaders, postWeixinJson } from "./client.js"
import { WEIXIN_ENDPOINTS } from "./protocol.js"

const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com"
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 25_000
const DEFAULT_BOT_TYPE = "3"

function nowIso() {
  return serializeNowInstant()
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeBaseUrl(baseUrl?: string) {
  return nonEmptyString(baseUrl) || DEFAULT_WEIXIN_BASE_URL
}

function isFresh(session: ActiveWeixinQrLogin) {
  return Date.now() < session.expiresAt
}

async function fetchWeixinText(params: {
  url: string
  timeoutMs: number
  headers?: Record<string, string>
}): Promise<string | null> {
  try {
    const response = await fetch(params.url, {
      headers: params.headers,
      signal: AbortSignal.timeout(params.timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Weixin QR API failed with ${response.status}: ${text || response.statusText}`
      )
    }
    return text
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return null
    }
    throw error
  }
}

async function fetchWeixinQrCode(params: { baseUrl: string; botType: string }) {
  // Upstream uses POST with a `local_token_list` body (used by the gateway to
  // detect an already-bound bot). We have no locally-stored bot tokens in this
  // multi-tenant server, so we send an empty list.
  const resp = await postWeixinJson({
    baseUrl: params.baseUrl,
    endpoint: `${WEIXIN_ENDPOINTS.GET_BOT_QRCODE}?bot_type=${encodeURIComponent(params.botType)}`,
    timeoutMs: 10_000,
    body: { local_token_list: [] },
  })
  return {
    qrcode: nonEmptyString(resp.qrcode),
    qrcode_img_content: nonEmptyString(resp.qrcode_img_content),
  }
}

async function pollWeixinQrStatus(params: {
  baseUrl: string
  qrcode: string
  verifyCode?: string
}) {
  let endpoint = `${WEIXIN_ENDPOINTS.GET_QRCODE_STATUS}?qrcode=${encodeURIComponent(params.qrcode)}`
  if (params.verifyCode) {
    endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
  }
  const url = new URL(
    endpoint,
    params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`
  )
  const text = await fetchWeixinText({
    url: url.toString(),
    timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    headers: buildWeixinGetHeaders(),
  })
  if (text === null) return {}
  const parsed = parseWeixinQrStatusResponseText(text)
  if (!parsed) {
    throw new Error("Weixin QR API returned invalid status response")
  }
  return parsed
}

function mapStatus(
  status?: WeixinQrStatusResponse["status"]
): WeixinQrLoginStatus {
  switch (status) {
    case "scaned":
      return WEIXIN_QR_LOGIN_STATUS.SCANNED
    case "need_verifycode":
      return WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE
    case "confirmed":
      return WEIXIN_QR_LOGIN_STATUS.CONFIRMED
    case "expired":
      return WEIXIN_QR_LOGIN_STATUS.EXPIRED
    case "wait":
    default:
      return WEIXIN_QR_LOGIN_STATUS.WAITING
  }
}

async function persistWeixinAccount(params: {
  session: ActiveWeixinQrLogin
  botToken: string
  botId?: string
  scannerUserId?: string
  baseUrl?: string
}): Promise<TransportAccountSummary> {
  const accountKey =
    nonEmptyString(params.botId) ||
    nonEmptyString(params.scannerUserId) ||
    params.session.sessionId
  const displayName =
    nonEmptyString(params.session.displayName) ||
    (nonEmptyString(params.scannerUserId)
      ? `WeChat ${params.scannerUserId}`
      : "WeChat Bot")
  const resolvedBaseUrl = normalizeBaseUrl(
    params.baseUrl || params.session.baseUrl
  )
  const metadata = {
    source: "qr_login",
    ilinkBotId: params.botId || null,
    scannerUserId: params.scannerUserId || null,
    qrConfirmedAt: nowIso(),
  }

  const existing = await getTransportAccountByWorkspaceKindAndKey({
    workspaceId: params.session.workspaceId,
    transportKind: "weixin",
    accountKey,
  })

  let account: TransportAccountSummary
  if (existing) {
    account = await updateTransportAccount({
      workspaceId: params.session.workspaceId,
      accountId: existing.id,
      displayName,
      ownerScope: params.session.ownerScope,
      ownerWorkspaceMemberId: params.session.ownerWorkspaceMemberId ?? null,
      inboundActorMode: params.session.inboundActorMode,
      inboundActorId: params.session.inboundActorId ?? null,
      connectionMode: "long_connection",
      status: "active",
      credentials: {
        ...(existing.credentials || {}),
        token: params.botToken,
      },
      config: {
        ...(existing.config || {}),
        baseUrl: resolvedBaseUrl,
      },
      metadata: {
        ...(existing.metadata || {}),
        ...metadata,
      },
    })
  } else {
    try {
      account = await createTransportAccount({
        workspaceId: params.session.workspaceId,
        transportKind: "weixin",
        accountKey,
        displayName,
        ownerScope: params.session.ownerScope,
        ownerWorkspaceMemberId: params.session.ownerWorkspaceMemberId ?? null,
        inboundActorMode: params.session.inboundActorMode,
        inboundActorId: params.session.inboundActorId ?? null,
        connectionMode: "long_connection",
        credentials: { token: params.botToken },
        config: { baseUrl: resolvedBaseUrl },
        metadata,
      })
    } catch (error: any) {
      if (error?.code !== "23505") throw error
      const concurrent = await getTransportAccountByWorkspaceKindAndKey({
        workspaceId: params.session.workspaceId,
        transportKind: "weixin",
        accountKey,
      })
      if (!concurrent) throw error
      account = await updateTransportAccount({
        workspaceId: params.session.workspaceId,
        accountId: concurrent.id,
        displayName,
        ownerScope: params.session.ownerScope,
        ownerWorkspaceMemberId: params.session.ownerWorkspaceMemberId ?? null,
        inboundActorMode: params.session.inboundActorMode,
        inboundActorId: params.session.inboundActorId ?? null,
        connectionMode: "long_connection",
        status: "active",
        credentials: {
          ...(concurrent.credentials || {}),
          token: params.botToken,
        },
        config: {
          ...(concurrent.config || {}),
          baseUrl: resolvedBaseUrl,
        },
        metadata: { ...(concurrent.metadata || {}), ...metadata },
      })
    }
  }

  if (params.scannerUserId) {
    await ensureTransportAddress({
      workspaceId: params.session.workspaceId,
      transportAccountId: account.id,
      transportKind: "weixin",
      addressType: "user",
      externalId: params.scannerUserId,
      displayName: params.scannerUserId,
      metadata: {
        source: "qr_login",
        scannerUserId: params.scannerUserId,
        qrConfirmedAt: nowIso(),
      },
    })
  }

  // Wake the reconcile loop so the new account's runtime starts immediately
  await refreshTransportRuntimeManager()
  return account
}

export function getWeixinQrLoginSessionOwner(params: {
  workspaceId: string
  sessionId: string
}): Promise<{
  ownerScope: TransportAccountOwnerScope
  ownerWorkspaceMemberId: string | null
} | null> {
  return getQrSession(params.workspaceId, params.sessionId).then((existing) => {
    if (!existing) return null
    return {
      ownerScope: existing.ownerScope,
      ownerWorkspaceMemberId: existing.ownerWorkspaceMemberId || null,
    }
  })
}

async function buildSummary(
  session: ActiveWeixinQrLogin
): Promise<WeixinQrLoginSessionSummary> {
  const transportAccount = session.transportAccountId
    ? await getTransportAccountById(session.transportAccountId)
    : null
  // Pure ms→ISO presentation lives in the im presenter (guard-layering r3).
  return presentWeixinQrLoginSession(session, transportAccount || undefined)
}

export async function startWeixinQrLoginSession(params: {
  workspaceId: string
  displayName?: string
  baseUrl?: string
  botType?: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
}): Promise<WeixinQrLoginSessionSummary> {
  const baseUrl = normalizeBaseUrl(params.baseUrl)
  const botType = nonEmptyString(params.botType) || DEFAULT_BOT_TYPE
  const qr = await fetchWeixinQrCode({ baseUrl, botType })
  const qrcode = nonEmptyString(qr.qrcode)
  const qrCodeUrl = nonEmptyString(qr.qrcode_img_content)
  if (!qrcode || !qrCodeUrl) {
    throw new Error("Weixin QR login did not return a valid QR code")
  }

  const now = Date.now()
  const session: ActiveWeixinQrLogin = {
    sessionId: crypto.randomUUID(),
    workspaceId: params.workspaceId,
    qrcode,
    qrCodeUrl,
    baseUrl,
    botType,
    displayName: nonEmptyString(params.displayName),
    ownerScope: params.ownerScope || "workspace",
    ownerWorkspaceMemberId: params.ownerWorkspaceMemberId || null,
    inboundActorMode: params.inboundActorMode || "none",
    inboundActorId: params.inboundActorId || null,
    status: WEIXIN_QR_LOGIN_STATUS.WAITING,
    message: "Scan the QR code with WeChat to finish connecting.",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ACTIVE_LOGIN_TTL_MS,
  }
  await setQrSession(session)
  return buildSummary(session)
}

export async function getWeixinQrLoginSession(params: {
  workspaceId: string
  sessionId: string
}): Promise<WeixinQrLoginSessionSummary | null> {
  const existing = await getQrSession(params.workspaceId, params.sessionId)
  if (!existing) return null

  if (
    !isFresh(existing) &&
    existing.status !== WEIXIN_QR_LOGIN_STATUS.CONFIRMED
  ) {
    const expired: ActiveWeixinQrLogin = {
      ...existing,
      status: WEIXIN_QR_LOGIN_STATUS.EXPIRED,
      message: "QR code expired. Generate a new one.",
      updatedAt: Date.now(),
    }
    await setQrSession(expired)
    return buildSummary(expired)
  }

  if (
    existing.status === WEIXIN_QR_LOGIN_STATUS.CONFIRMED ||
    existing.status === WEIXIN_QR_LOGIN_STATUS.ERROR
  ) {
    return buildSummary(existing)
  }

  try {
    const statusResponse = await pollWeixinQrStatus({
      baseUrl: existing.baseUrl,
      qrcode: existing.qrcode,
      verifyCode: existing.pendingVerifyCode,
    })
    const raw = statusResponse.status

    // IDC redirect: switch the polling host and keep waiting — not client-visible.
    if (raw === "scaned_but_redirect") {
      const redirectHost = nonEmptyString(statusResponse.redirect_host)
      const redirected: ActiveWeixinQrLogin = {
        ...existing,
        baseUrl: redirectHost ? `https://${redirectHost}` : existing.baseUrl,
        status: WEIXIN_QR_LOGIN_STATUS.SCANNED,
        message: "QR code scanned. Confirm the login in WeChat.",
        updatedAt: Date.now(),
      }
      await setQrSession(redirected)
      return buildSummary(redirected)
    }

    // Bot already bound to this OpenClaw/workspace — no new token is issued.
    if (raw === "binded_redirect") {
      const bound: ActiveWeixinQrLogin = {
        ...existing,
        status: WEIXIN_QR_LOGIN_STATUS.ERROR,
        message: "This WeChat is already connected; no need to reconnect.",
        updatedAt: Date.now(),
      }
      await setQrSession(bound)
      return buildSummary(bound)
    }

    // Too many wrong pairing codes — make the user restart with a fresh QR.
    if (raw === "verify_code_blocked") {
      const blocked: ActiveWeixinQrLogin = {
        ...existing,
        status: WEIXIN_QR_LOGIN_STATUS.ERROR,
        message:
          "Too many incorrect codes. Generate a new QR code and try again.",
        pendingVerifyCode: undefined,
        updatedAt: Date.now(),
      }
      await setQrSession(blocked)
      return buildSummary(blocked)
    }

    const nextStatus = mapStatus(raw)
    const nextBaseUrl = normalizeBaseUrl(
      nonEmptyString(statusResponse.baseurl) || existing.baseUrl
    )
    // A pending code the server has moved past was accepted — drop it.
    const clearVerifyCode = Boolean(
      existing.pendingVerifyCode && raw !== "need_verifycode"
    )
    let nextSession: ActiveWeixinQrLogin = {
      ...existing,
      status: nextStatus,
      baseUrl: nextBaseUrl,
      botId: nonEmptyString(statusResponse.ilink_bot_id) || existing.botId,
      scannerUserId:
        nonEmptyString(statusResponse.ilink_user_id) || existing.scannerUserId,
      pendingVerifyCode: clearVerifyCode
        ? undefined
        : existing.pendingVerifyCode,
      updatedAt: Date.now(),
      message:
        nextStatus === WEIXIN_QR_LOGIN_STATUS.NEED_VERIFYCODE
          ? "Enter the number shown in WeChat on your phone to continue."
          : nextStatus === WEIXIN_QR_LOGIN_STATUS.SCANNED
            ? "QR code scanned. Confirm the login in WeChat."
            : nextStatus === WEIXIN_QR_LOGIN_STATUS.EXPIRED
              ? "QR code expired. Generate a new one."
              : existing.message,
    }

    const confirmedToken = nonEmptyString(statusResponse.bot_token)
    if (nextStatus === WEIXIN_QR_LOGIN_STATUS.CONFIRMED && confirmedToken) {
      const account = await persistWeixinAccount({
        session: nextSession,
        botToken: confirmedToken,
        botId: nextSession.botId,
        scannerUserId: nextSession.scannerUserId,
        baseUrl: nextBaseUrl,
      })
      nextSession = {
        ...nextSession,
        transportAccountId: account.id,
        status: WEIXIN_QR_LOGIN_STATUS.CONFIRMED,
        message: "WeChat account connected.",
      }
    }

    await setQrSession(nextSession)
    return buildSummary(nextSession)
  } catch (error) {
    const failed: ActiveWeixinQrLogin = {
      ...existing,
      status: WEIXIN_QR_LOGIN_STATUS.ERROR,
      message:
        error instanceof Error
          ? error.message
          : "WeChat QR login failed. Try again.",
      updatedAt: Date.now(),
    }
    await setQrSession(failed)
    return buildSummary(failed)
  }
}

/**
 * Stash a user-entered pairing code on the session. It is carried into the
 * next status poll (`get_qrcode_status?verify_code=…`); the server then either
 * advances the login or returns `need_verifycode` again (wrong code).
 */
export async function submitWeixinQrVerifyCode(params: {
  workspaceId: string
  sessionId: string
  code: string
}): Promise<WeixinQrLoginSessionSummary | null> {
  const existing = await getQrSession(params.workspaceId, params.sessionId)
  if (!existing) return null
  const updated: ActiveWeixinQrLogin = {
    ...existing,
    pendingVerifyCode: params.code.trim(),
    updatedAt: Date.now(),
    message: "Verifying the code…",
  }
  await setQrSession(updated)
  return buildSummary(updated)
}

export { deleteQrSession }
