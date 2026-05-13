import crypto from "node:crypto"
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
} from "./service.js"
import { refreshTransportRuntimeManager } from "./runtime.js"

const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com"
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 25_000
const DEFAULT_BOT_TYPE = "3"

type ActiveWeixinQrLogin = {
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

type WeixinQrCodeResponse = {
  qrcode?: string
  qrcode_img_content?: string
}

type WeixinQrStatusResponse = {
  status?: "wait" | "scaned" | "confirmed" | "expired"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

const activeWeixinQrLogins = new Map<string, ActiveWeixinQrLogin>()

function nowIso() {
  return new Date().toISOString()
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function normalizeBaseUrl(baseUrl?: string) {
  return nonEmptyString(baseUrl) || DEFAULT_WEIXIN_BASE_URL
}

function buildSessionKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}:${sessionId}`
}

function isFresh(session: ActiveWeixinQrLogin) {
  return Date.now() < session.expiresAt
}

function purgeExpiredSessions() {
  const now = Date.now()
  for (const [key, session] of activeWeixinQrLogins.entries()) {
    if (session.expiresAt > now) continue
    if (session.status === "confirmed") continue
    activeWeixinQrLogins.set(key, {
      ...session,
      status: "expired",
      message: "QR code expired. Generate a new one.",
      updatedAt: now,
    })
  }
}

async function fetchWeixinJson<T>(params: {
  url: string
  timeoutMs: number
  headers?: Record<string, string>
}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), params.timeoutMs)
  try {
    const response = await fetch(params.url, {
      headers: params.headers,
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `Weixin QR API failed with ${response.status}: ${text || response.statusText}`
      )
    }
    return (text ? JSON.parse(text) : {}) as T
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {} as T
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWeixinQrCode(params: { baseUrl: string; botType: string }) {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType)}`,
    params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`
  )
  return fetchWeixinJson<WeixinQrCodeResponse>({
    url: url.toString(),
    timeoutMs: 10_000,
  })
}

async function pollWeixinQrStatus(params: { baseUrl: string; qrcode: string }) {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
    params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`
  )
  return fetchWeixinJson<WeixinQrStatusResponse>({
    url: url.toString(),
    timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
    headers: {
      "iLink-App-ClientVersion": "1",
    },
  })
}

function mapStatus(
  status?: WeixinQrStatusResponse["status"]
): WeixinQrLoginStatus {
  switch (status) {
    case "scaned":
      return "scanned"
    case "confirmed":
      return "confirmed"
    case "expired":
      return "expired"
    case "wait":
    default:
      return "waiting"
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
        credentials: {
          token: params.botToken,
        },
        config: {
          baseUrl: resolvedBaseUrl,
        },
        metadata,
      })
    } catch (error: any) {
      if (error?.code !== "23505") {
        throw error
      }
      const concurrent = await getTransportAccountByWorkspaceKindAndKey({
        workspaceId: params.session.workspaceId,
        transportKind: "weixin",
        accountKey,
      })
      if (!concurrent) {
        throw error
      }
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
        metadata: {
          ...(concurrent.metadata || {}),
          ...metadata,
        },
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

  await refreshTransportRuntimeManager().catch((error) => {
    console.error("[im] Failed to refresh transport runtime manager:", error)
  })

  return account
}

export function getWeixinQrLoginSessionOwner(params: {
  workspaceId: string
  sessionId: string
}) {
  purgeExpiredSessions()
  const existing = activeWeixinQrLogins.get(
    buildSessionKey(params.workspaceId, params.sessionId)
  )
  if (!existing) {
    return null
  }
  return {
    ownerScope: existing.ownerScope,
    ownerWorkspaceMemberId: existing.ownerWorkspaceMemberId || null,
  }
}

async function buildSummary(session: ActiveWeixinQrLogin) {
  const transportAccount = session.transportAccountId
    ? await getTransportAccountById(session.transportAccountId)
    : null
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    status: session.status,
    message: session.message,
    qrCodeUrl: session.qrCodeUrl,
    baseUrl: session.baseUrl,
    botId: session.botId,
    scannerUserId: session.scannerUserId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    transportAccount: transportAccount || undefined,
  } satisfies WeixinQrLoginSessionSummary
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
}) {
  purgeExpiredSessions()

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
    status: "waiting",
    message: "Scan the QR code with WeChat to finish connecting.",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ACTIVE_LOGIN_TTL_MS,
  }
  activeWeixinQrLogins.set(
    buildSessionKey(params.workspaceId, session.sessionId),
    session
  )
  return buildSummary(session)
}

export async function getWeixinQrLoginSession(params: {
  workspaceId: string
  sessionId: string
}) {
  purgeExpiredSessions()
  const key = buildSessionKey(params.workspaceId, params.sessionId)
  const existing = activeWeixinQrLogins.get(key)
  if (!existing) {
    return null
  }

  if (!isFresh(existing) && existing.status !== "confirmed") {
    const expired: ActiveWeixinQrLogin = {
      ...existing,
      status: "expired",
      message: "QR code expired. Generate a new one.",
      updatedAt: Date.now(),
    }
    activeWeixinQrLogins.set(key, expired)
    return buildSummary(expired)
  }

  if (existing.status === "confirmed" || existing.status === "error") {
    return buildSummary(existing)
  }

  try {
    const statusResponse = await pollWeixinQrStatus({
      baseUrl: existing.baseUrl,
      qrcode: existing.qrcode,
    })
    const nextStatus = mapStatus(statusResponse.status)
    const nextBaseUrl = normalizeBaseUrl(
      nonEmptyString(statusResponse.baseurl) || existing.baseUrl
    )
    let nextSession: ActiveWeixinQrLogin = {
      ...existing,
      status: nextStatus,
      baseUrl: nextBaseUrl,
      botId: nonEmptyString(statusResponse.ilink_bot_id) || existing.botId,
      scannerUserId:
        nonEmptyString(statusResponse.ilink_user_id) || existing.scannerUserId,
      updatedAt: Date.now(),
      message:
        nextStatus === "scanned"
          ? "QR code scanned. Confirm the login in WeChat."
          : nextStatus === "expired"
            ? "QR code expired. Generate a new one."
            : existing.message,
    }

    const confirmedToken = nonEmptyString(statusResponse.bot_token)
    if (nextStatus === "confirmed" && confirmedToken) {
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
        status: "confirmed",
        message: "WeChat account connected.",
      }
    }

    activeWeixinQrLogins.set(key, nextSession)
    return buildSummary(nextSession)
  } catch (error) {
    const failed: ActiveWeixinQrLogin = {
      ...existing,
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "WeChat QR login failed. Try again.",
      updatedAt: Date.now(),
    }
    activeWeixinQrLogins.set(key, failed)
    return buildSummary(failed)
  }
}
