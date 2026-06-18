/**
 * QR + pairing-code login (mirror weixin/qr-login.ts + qr-session-store.ts).
 *
 * Unlike weixin (which polls an upstream HTTP QR API), Baileys login is driven
 * by a TRANSIENT socket: `connection.update` emits a `qr` string we render to a
 * data-URL; for pairing-code login we call `requestPairingCode(e164NoPlus)`
 * after the socket starts connecting. When the socket reaches `open` the device
 * is paired — we then:
 *
 *   1. RE-READ the persisted creds (defeats the open-but-not-flushed race —
 *      Baileys fires `open` slightly before the final `creds.update` flush; we
 *      wait for `creds.registered === true` and `me` to be present).
 *   2. `persistAccount` → create/update `transport_accounts` with the encrypted
 *      auth blob, `connectionMode:"long_connection"`, `status:"active"`.
 *   3. `ensureTransportAddress` for the logged-in number.
 *   4. `refreshTransportRuntimeManager()` so the reconcile loop starts the real
 *      long-connection driver immediately.
 *
 * The transient login socket is then closed; the durable socket is owned by
 * the runtime (one per number, lease-guarded).
 *
 * NO top-level IO — all sockets/timers live inside the exported functions.
 */

import crypto from "node:crypto"
import QRCode from "qrcode"
import makeWASocket, { type ConnectionState, type WASocket } from "baileys"
import type {
  TransportAccountInboundActorMode,
  TransportAccountOwnerScope,
} from "@synapse/shared/types"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { refreshTransportRuntimeManager } from "../../runtime.js"
import {
  createTransportAccount,
  ensureTransportAddress,
  getTransportAccountByWorkspaceKindAndKey,
  updateTransportAccount,
} from "../../service.js"
import { buildManagedAuthState } from "./auth-state.js"
import {
  encryptAuthBlob,
  freshAuthSnapshot,
  serializeAuthSnapshot,
  AUTH_BLOB_CREDENTIAL_KEY,
  type AuthSnapshot,
} from "./creds-persistence.js"
import {
  deleteLoginSession,
  getLoginSession,
  setLoginSession,
  type WhatsappLoginSession,
} from "./qr-session-store.js"
import { e164ForPairing, jidUser, normalizeJid } from "./types.js"

const LOGIN_TTL_MS = 5 * 60_000

/** Live login sockets, keyed by sessionId (cannot live in Redis). */
const liveLoginSockets = new Map<string, WASocket>()

export interface StartLoginParams {
  workspaceId: string
  displayName?: string
  /** When set, use pairing-code login for this E.164 number (else QR). */
  phoneNumberE164?: string
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
}

/** DI seam so the login flow is unit-testable without a real Baileys socket. */
export interface LoginDeps {
  socketFactory?: (snapshot: AuthSnapshot) => {
    socket: WASocket
    managedAuth: ReturnType<typeof buildManagedAuthState>
  }
  renderQr?: (qr: string) => Promise<string>
  persistAccount?: typeof persistLinkedAccount
  refreshRuntime?: typeof refreshTransportRuntimeManager
}

function defaultLoginSocketFactory(snapshot: AuthSnapshot): {
  socket: WASocket
  managedAuth: ReturnType<typeof buildManagedAuthState>
} {
  const managedAuth = buildManagedAuthState(snapshot)
  const socket = makeWASocket({
    auth: managedAuth.state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  return { socket, managedAuth }
}

/**
 * Begin a login session. Returns immediately with a `pending` session; the QR
 * (or pairing code) lands asynchronously and the controller polls
 * `getWhatsappLoginSession` until `qr`/`pairing` then `linked`.
 */
export async function startWhatsappLoginSession(
  params: StartLoginParams,
  deps: LoginDeps = {}
): Promise<WhatsappLoginSession> {
  const socketFactory = deps.socketFactory ?? defaultLoginSocketFactory
  const renderQr = deps.renderQr ?? ((qr: string) => QRCode.toDataURL(qr))
  const persistAccount = deps.persistAccount ?? persistLinkedAccount
  const refreshRuntime = deps.refreshRuntime ?? refreshTransportRuntimeManager

  const now = Date.now()
  const sessionId = crypto.randomUUID()
  const session: WhatsappLoginSession = {
    sessionId,
    workspaceId: params.workspaceId,
    status: "pending",
    phoneNumberE164: params.phoneNumberE164
      ? e164ForPairing(params.phoneNumberE164)
      : undefined,
    displayName: params.displayName,
    ownerScope: params.ownerScope,
    ownerWorkspaceMemberId: params.ownerWorkspaceMemberId ?? null,
    inboundActorMode: params.inboundActorMode,
    inboundActorId: params.inboundActorId ?? null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + LOGIN_TTL_MS,
  }
  await setLoginSession(session)

  const snapshot = freshAuthSnapshot()
  const { socket, managedAuth } = socketFactory(snapshot)
  liveLoginSockets.set(sessionId, socket)

  let pairingRequested = false

  socket.ev.on("connection.update", (update: Partial<ConnectionState>) => {
    void handleLoginUpdate({
      sessionId,
      workspaceId: params.workspaceId,
      update,
      socket,
      managedAuth,
      renderQr,
      persistAccount,
      refreshRuntime,
    })

    // Pairing-code login: request the code once connecting begins (and no QR).
    if (
      session.phoneNumberE164 &&
      !pairingRequested &&
      update.connection === "connecting"
    ) {
      pairingRequested = true
      void requestPairing(
        sessionId,
        params.workspaceId,
        socket,
        session.phoneNumberE164
      )
    }
  })

  return session
}

async function requestPairing(
  sessionId: string,
  workspaceId: string,
  socket: WASocket,
  e164: string
): Promise<void> {
  try {
    const code = await socket.requestPairingCode(e164)
    const existing = await getLoginSession(workspaceId, sessionId)
    if (!existing || existing.status === "linked") return
    await setLoginSession({
      ...existing,
      status: "pairing",
      pairingCode: code,
      updatedAt: Date.now(),
    })
  } catch {
    await failSession(workspaceId, sessionId, "failed to request pairing code")
  }
}

interface HandleLoginUpdateInput {
  sessionId: string
  workspaceId: string
  update: Partial<ConnectionState>
  socket: WASocket
  managedAuth: ReturnType<typeof buildManagedAuthState>
  renderQr: (qr: string) => Promise<string>
  persistAccount: typeof persistLinkedAccount
  refreshRuntime: typeof refreshTransportRuntimeManager
}

async function handleLoginUpdate(input: HandleLoginUpdateInput): Promise<void> {
  const { update, sessionId, workspaceId } = input
  const session = await getLoginSession(workspaceId, sessionId)
  if (!session || session.status === "linked") return

  if (update.qr) {
    try {
      const dataUrl = await input.renderQr(update.qr)
      await setLoginSession({
        ...session,
        status: "qr",
        qrDataUrl: dataUrl,
        updatedAt: Date.now(),
      })
    } catch {
      await failSession(workspaceId, sessionId, "failed to render QR")
    }
    return
  }

  if (update.connection === "open") {
    await onPaired(input)
    return
  }

  if (update.connection === "close") {
    // A close before "open" during login = expired/failed (e.g. QR lapsed,
    // restartRequired comes AFTER pair so it's handled by onPaired flow).
    const session2 = await getLoginSession(workspaceId, sessionId)
    if (session2 && session2.status !== "linked") {
      await failSession(workspaceId, sessionId, "login connection closed")
      closeLoginSocket(sessionId)
    }
  }
}

async function onPaired(input: HandleLoginUpdateInput): Promise<void> {
  const { sessionId, workspaceId, managedAuth } = input
  const session = await getLoginSession(workspaceId, sessionId)
  if (!session || session.status === "linked") return

  // Defeat the open-but-not-flushed race: wait until creds are registered + me
  // is present (the snapshot is held by reference, so this re-reads live state).
  const ok = await waitForRegisteredCreds(managedAuth, 8_000)
  if (!ok) {
    await failSession(workspaceId, sessionId, "creds not flushed after pairing")
    closeLoginSocket(sessionId)
    return
  }

  const snapshot = managedAuth.getSnapshot()
  const me = snapshot.creds.me
  const selfJid = normalizeJid(me?.id)
  const accountKey = jidUser(selfJid) || sessionId

  try {
    const account = await input.persistAccount({
      workspaceId,
      accountKey,
      displayName: session.displayName || me?.name || `WhatsApp ${accountKey}`,
      selfJid,
      snapshot,
      ownerScope: session.ownerScope,
      ownerWorkspaceMemberId: session.ownerWorkspaceMemberId ?? null,
      inboundActorMode: session.inboundActorMode,
      inboundActorId: session.inboundActorId ?? null,
    })

    await setLoginSession({
      ...session,
      status: "linked",
      transportAccountId: account.id,
      qrDataUrl: undefined,
      pairingCode: undefined,
      updatedAt: Date.now(),
    })

    // Hand the durable socket to the runtime; close the transient login socket.
    closeLoginSocket(sessionId)
    await input.refreshRuntime()
  } catch (err) {
    await failSession(
      workspaceId,
      sessionId,
      `failed to persist account: ${(err as Error).message}`
    )
    closeLoginSocket(sessionId)
  }
}

async function waitForRegisteredCreds(
  managedAuth: ReturnType<typeof buildManagedAuthState>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const creds = managedAuth.getSnapshot().creds
    if (creds.registered && creds.me?.id) return true
    await delay(150)
  }
  const creds = managedAuth.getSnapshot().creds
  return Boolean(creds.registered && creds.me?.id)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function closeLoginSocket(sessionId: string): void {
  const socket = liveLoginSockets.get(sessionId)
  if (socket) {
    try {
      socket.end(undefined)
    } catch {
      /* ignore */
    }
    liveLoginSockets.delete(sessionId)
  }
}

async function failSession(
  workspaceId: string,
  sessionId: string,
  message: string
): Promise<void> {
  const session = await getLoginSession(workspaceId, sessionId)
  if (!session || session.status === "linked") return
  await setLoginSession({
    ...session,
    status: "error",
    errorMessage: message,
    updatedAt: Date.now(),
  })
}

export async function getWhatsappLoginSession(params: {
  workspaceId: string
  sessionId: string
}): Promise<WhatsappLoginSession | null> {
  const session = await getLoginSession(params.workspaceId, params.sessionId)
  if (!session) return null
  // Lazily flip to expired if the window lapsed and we never linked.
  if (
    session.status !== "linked" &&
    session.status !== "error" &&
    Date.now() >= session.expiresAt
  ) {
    closeLoginSocket(params.sessionId)
    const expired: WhatsappLoginSession = {
      ...session,
      status: "expired",
      updatedAt: Date.now(),
    }
    await setLoginSession(expired)
    return expired
  }
  return session
}

export async function cancelWhatsappLoginSession(params: {
  workspaceId: string
  sessionId: string
}): Promise<void> {
  closeLoginSocket(params.sessionId)
  await deleteLoginSession(params.workspaceId, params.sessionId)
}

// ───────────────────────── persistence seam ─────────────────────────

export interface PersistLinkedAccountParams {
  workspaceId: string
  accountKey: string
  displayName: string
  selfJid: string
  snapshot: AuthSnapshot
  ownerScope?: TransportAccountOwnerScope
  ownerWorkspaceMemberId?: string | null
  inboundActorMode?: TransportAccountInboundActorMode
  inboundActorId?: string | null
}

/**
 * Create-or-update the `transport_accounts` row with the ENCRYPTED auth blob.
 * Mirrors weixin's `persistWeixinAccount` (lookup-then-branch, runtime refresh
 * is done by the caller). Encryption happens here (OD-NEW-C) so the raw
 * identity blob never reaches the service/DB layer.
 */
export async function persistLinkedAccount(
  params: PersistLinkedAccountParams
): Promise<{ id: string }> {
  const blob = encryptAuthBlob(serializeAuthSnapshot(params.snapshot))
  const metadata = {
    source: "qr_login",
    selfJid: params.selfJid,
    linkedAt: nowIsoInstant(),
  }

  const existing = await getTransportAccountByWorkspaceKindAndKey({
    workspaceId: params.workspaceId,
    transportKind: "whatsapp_unofficial",
    accountKey: params.accountKey,
  })

  let account: { id: string }
  if (existing) {
    account = await updateTransportAccount({
      workspaceId: params.workspaceId,
      accountId: existing.id,
      expectedTransportKind: "whatsapp_unofficial",
      displayName: params.displayName,
      ownerScope: params.ownerScope,
      ownerWorkspaceMemberId: params.ownerWorkspaceMemberId ?? null,
      inboundActorMode: params.inboundActorMode,
      inboundActorId: params.inboundActorId ?? null,
      connectionMode: "long_connection",
      status: "active",
      credentials: { [AUTH_BLOB_CREDENTIAL_KEY]: blob },
      config: { ...(existing.config || {}) },
      metadata: { ...(existing.metadata || {}), ...metadata },
    })
  } else {
    account = await createTransportAccount({
      workspaceId: params.workspaceId,
      transportKind: "whatsapp_unofficial",
      accountKey: params.accountKey,
      displayName: params.displayName,
      ownerScope: params.ownerScope,
      ownerWorkspaceMemberId: params.ownerWorkspaceMemberId ?? null,
      inboundActorMode: params.inboundActorMode,
      inboundActorId: params.inboundActorId ?? null,
      connectionMode: "long_connection",
      status: "active",
      credentials: { [AUTH_BLOB_CREDENTIAL_KEY]: blob },
      config: {},
      metadata,
    })
  }

  if (params.selfJid) {
    await ensureTransportAddress({
      workspaceId: params.workspaceId,
      transportAccountId: account.id,
      transportKind: "whatsapp_unofficial",
      addressType: "user",
      externalId: params.selfJid,
      displayName: params.displayName,
      metadata: { self: true },
    })
  }

  return account
}
