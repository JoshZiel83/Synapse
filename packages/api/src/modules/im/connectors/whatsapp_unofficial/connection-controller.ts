/**
 * `startAccount` driver for the Baileys long-connection.
 *
 * Mirrors dingtalk/stream.ts (reconnect loop + computeBackoff + stability gate
 * + abort on ctx.signal) and weixin/session-guard (pause on dead session). One
 * socket per number is guaranteed by the runtime's per-account Redis lease, so
 * we never fight `connectionReplaced`.
 *
 * Lifecycle per connect cycle:
 *   1. load (or create) the auth snapshot from the account credentials
 *   2. makeWASocket({ auth }) and persist on EVERY creds.update / key change
 *   3. on connection.update:
 *        - qr            → forwarded to the login store (handled in login-qr;
 *                          here we just log — login sessions own the QR)
 *        - open          → mark connected, reset backoff after MIN_STABLE
 *        - close         → run the DisconnectReason policy (restart/wipe/reconnect/stop)
 *   4. messages.upsert (type==='notify')  → normalize → media → emitInbound
 *
 * NO top-level IO — everything is inside startWhatsappAccount.
 */

import { computeBackoff } from "@synapse/shared"
import makeWASocket, {
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from "baileys"
import { sleep } from "../../../../infrastructure/async/index.js"
import type { AccountStartContext, RunningAccount } from "../types.js"
import { buildManagedAuthState } from "./auth-state.js"
import {
  clearAuthSnapshot,
  freshAuthSnapshot,
  loadAuthSnapshotFromCredentials,
  persistAuthSnapshot,
  type AuthSnapshot,
} from "./creds-persistence.js"
import { decideDisconnect, statusCodeFromError } from "./disconnect-policy.js"
import { processUpsertBatch } from "./inbound.js"
import {
  registerHandle,
  unregisterHandle,
  type RunningWhatsappHandle,
} from "./running-registry.js"
import {
  clearSessionPause,
  isSessionPaused,
  pauseSession,
} from "./session-guard.js"
import {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER_MS,
  BACKOFF_MAX_MS,
  DEDUP_MAX_ENTRIES,
  MIN_STABLE_CONNECTION_MS,
} from "./types.js"

/** Minimal slice of the socket surface the driver uses (for DI/mocking). */
export interface WhatsappSocketLike {
  ev: {
    on<E extends "connection.update" | "creds.update" | "messages.upsert">(
      event: E,
      listener: (arg: unknown) => void
    ): void
  }
  end(error?: Error): void
  logout(msg?: string): Promise<void>
}

export type WhatsappSocketFactory = (snapshot: AuthSnapshot) => {
  socket: WhatsappSocketLike & Partial<WASocket>
  /** Wires the auth-state's persist callback into this socket's events. */
  managedAuth: ReturnType<typeof buildManagedAuthState>
}

/** Default factory: a real Baileys socket bound to a managed DB-backed auth state. */
export function defaultSocketFactory(snapshot: AuthSnapshot): {
  socket: WASocket
  managedAuth: ReturnType<typeof buildManagedAuthState>
} {
  const managedAuth = buildManagedAuthState(snapshot)
  const socket = makeWASocket({
    auth: managedAuth.state,
    // Never print QR to terminal; the login store owns the QR string.
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })
  return { socket, managedAuth }
}

export interface StartWhatsappOptions {
  socketFactory?: WhatsappSocketFactory
  persist?: typeof persistAuthSnapshot
  wipe?: typeof clearAuthSnapshot
  /** Test seam: download decrypted media bytes from a raw message. */
  downloadMedia?: (raw: WAMessage) => Promise<Buffer>
  minStableMs?: number
}

function backoffDelay(attempts: number): number {
  return computeBackoff(attempts, {
    baseMs: BACKOFF_BASE_MS,
    maxMs: BACKOFF_MAX_MS,
    minMs: 0,
    jitterMode: "additive",
    jitterMs: BACKOFF_JITTER_MS,
  })
}

/** Default decrypted-media downloader (real Baileys). */
async function defaultDownloadMedia(raw: WAMessage): Promise<Buffer> {
  const baileys = await import("baileys")
  return baileys.downloadMediaMessage(
    raw,
    "buffer",
    {},
    {
      // ctx is only needed for the re-upload path; inbound notify doesn't use it.
      reuploadRequest: (async (m: WAMessage) => m) as never,
      logger: noopBaileysLogger() as never,
    }
  )
}

function noopBaileysLogger(): unknown {
  const noop = (): void => {}
  return {
    level: "silent",
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    child: () => noopBaileysLogger(),
  }
}

export async function startWhatsappAccount(
  ctx: AccountStartContext,
  options: StartWhatsappOptions = {}
): Promise<RunningAccount> {
  const accountId = ctx.account.id
  const workspaceId = ctx.account.workspaceId
  const socketFactory =
    options.socketFactory ?? (defaultSocketFactory as WhatsappSocketFactory)
  const persist = options.persist ?? persistAuthSnapshot
  const wipe = options.wipe ?? clearAuthSnapshot
  const downloadMedia = options.downloadMedia ?? defaultDownloadMedia
  const minStableMs = options.minStableMs ?? MIN_STABLE_CONNECTION_MS

  let stopped = false
  let attempts = 0
  const handle: RunningWhatsappHandle = { socket: null, connected: false }
  registerHandle(accountId, handle)

  // The live auth snapshot, carried ACROSS connect cycles. Loaded once from the
  // account credentials; thereafter the managed auth-state mutates this same
  // object in place (creds by reference + key buckets), so a restart/reconnect
  // reuses the freshly-paired creds instead of the stale `ctx.account` blob
  // (reloading from ctx.account every cycle would re-request the QR after pair).
  let currentSnapshot: AuthSnapshot =
    loadAuthSnapshotFromCredentials(ctx.account.credentials) ??
    freshAuthSnapshot()

  const dedup = new Map<string, true>()
  function seen(id: string): boolean {
    if (dedup.has(id)) return true
    dedup.set(id, true)
    if (dedup.size > DEDUP_MAX_ENTRIES) {
      const oldest = dedup.keys().next().value
      if (oldest !== undefined) dedup.delete(oldest)
    }
    return false
  }

  const internalStop = new AbortController()
  const onCtxAbort = (): void => {
    stopped = true
    internalStop.abort()
  }
  ctx.signal.addEventListener("abort", onCtxAbort, { once: true })

  // A connect cycle resolves its `cycleEnd` promise when the socket closes.
  let resolveCycle: (() => void) | null = null

  async function flushSnapshot(snapshot: AuthSnapshot): Promise<void> {
    try {
      await persist({ workspaceId, accountId, snapshot })
    } catch (err) {
      ctx.logger.error(
        "whatsapp_unofficial: failed to persist auth snapshot",
        err,
        {
          accountId,
        }
      )
    }
  }

  async function emitFromUpsert(messages: WAMessage[]): Promise<void> {
    await processUpsertBatch(messages, {
      workspaceId,
      emitInbound: ctx.emitInbound,
      download: downloadMedia,
      logger: ctx.logger,
      seen: (id) => seen(`${accountId}:${id}`),
    })
  }

  /** One connect cycle. Resolves when the socket closes (or restart/stop). */
  async function connectOnce(): Promise<{
    action: "restart" | "wipe" | "reconnect" | "stop"
  }> {
    const { socket, managedAuth } = socketFactory(currentSnapshot)
    // Track the live snapshot the new socket mutates so the next cycle reuses it.
    currentSnapshot = managedAuth.getSnapshot()
    handle.socket = socket as unknown as WASocket
    let establishedAt: number | undefined
    let outcome: { action: "restart" | "wipe" | "reconnect" | "stop" } = {
      action: "reconnect",
    }

    // Persist on every creds.update AND on key-store mutation.
    socket.ev.on("creds.update", () => {
      void flushSnapshot(managedAuth.getSnapshot())
    })
    managedAuth.onKeysChanged(() => {
      void flushSnapshot(managedAuth.getSnapshot())
    })

    socket.ev.on("messages.upsert", (arg) => {
      const upsert = arg as { messages?: WAMessage[]; type?: string }
      if (upsert?.type !== "notify" || !Array.isArray(upsert.messages)) return
      void emitFromUpsert(upsert.messages)
    })

    const cycleDone = new Promise<void>((resolve) => {
      resolveCycle = resolve
    })

    socket.ev.on("connection.update", (arg) => {
      const update = arg as Partial<ConnectionState>
      if (update.connection === "open") {
        establishedAt = Date.now()
        handle.connected = true
        attempts = 0
        void clearSessionPause(accountId)
        ctx.logger.info("whatsapp_unofficial: connection open", { accountId })
      } else if (update.connection === "close") {
        const statusCode = statusCodeFromError(update.lastDisconnect?.error)
        const decision = decideDisconnect(statusCode, stopped)
        outcome = { action: decision.action }
        ctx.logger.warn("whatsapp_unofficial: connection closed", {
          accountId,
          statusCode,
          action: decision.action,
        })
        if (decision.action === "wipe") {
          // Dead session: drop the in-memory creds so any later re-link starts clean.
          currentSnapshot = freshAuthSnapshot()
          void (async () => {
            await pauseSession(
              accountId,
              decision.pauseReason ?? "logged_out"
            ).catch(() => undefined)
            await wipe({ workspaceId, accountId }).catch(() => undefined)
            ctx.logger.error(
              "whatsapp_unofficial: session ended — re-link required",
              undefined,
              { accountId, statusCode }
            )
          })()
        }
        resolveCycle?.()
      }
    })

    await cycleDone

    // Tear the socket down before deciding next step.
    try {
      ;(socket as WhatsappSocketLike).end(undefined)
    } catch {
      /* ignore */
    }
    handle.socket = null

    // Stability gate: only reset attempts if the connection lived long enough.
    if (outcome.action === "reconnect") {
      const lifetime = establishedAt ? Date.now() - establishedAt : 0
      if (lifetime >= minStableMs) attempts = 0
      else attempts += 1
    }
    return outcome
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      // Honor an operator/auto session-guard pause: don't fight for the socket.
      if (await isSessionPaused(accountId).catch(() => false)) {
        ctx.logger.warn(
          "whatsapp_unofficial: session paused — not connecting",
          {
            accountId,
          }
        )
        await sleep(30_000, internalStop.signal)
        continue
      }

      let outcome: { action: "restart" | "wipe" | "reconnect" | "stop" }
      try {
        outcome = await connectOnce()
      } catch (err) {
        attempts += 1
        const delay = backoffDelay(attempts)
        ctx.logger.warn(
          `whatsapp_unofficial: connect cycle threw: ${(err as Error).message}; retry in ${Math.round(delay)}ms`,
          { accountId, attempts }
        )
        await sleep(delay, internalStop.signal)
        continue
      }

      if (stopped || outcome.action === "stop") return
      if (outcome.action === "wipe") {
        // Dead session: the pause flag is set; loop will sleep on the pause check.
        continue
      }
      if (outcome.action === "restart") {
        // Expected right after first pair — reconnect immediately, no backoff.
        continue
      }
      // reconnect (transient)
      const delay = backoffDelay(attempts)
      ctx.logger.warn(
        `whatsapp_unofficial: reconnecting in ${Math.round(delay)}ms`,
        { accountId, attempts }
      )
      await sleep(delay, internalStop.signal)
    }
  }

  const loop = runLoop()

  return {
    stop: async () => {
      stopped = true
      internalStop.abort()
      ctx.signal.removeEventListener("abort", onCtxAbort)
      resolveCycle?.()
      try {
        handle.socket?.end?.(undefined)
      } catch {
        /* ignore */
      }
      unregisterHandle(accountId)
      await loop.catch(() => undefined)
    },
  }
}
