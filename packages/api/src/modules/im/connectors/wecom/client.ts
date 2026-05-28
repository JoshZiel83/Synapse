/**
 * WeCom (Enterprise WeChat) AI-Bot WebSocket client thin adapter.
 *
 * v1 uses the official `@wecom/aibot-node-sdk` directly — the adapter only
 * supplies (a) a configured constructor that pins both reconnect / auth
 * failure limits to infinite, and (b) a `waitForAuthenticated` helper used
 * by inbound.ts during start-up.
 *
 * The SDK already handles: exponential-backoff reconnect, heartbeat,
 * ack queue, message normalization, media AES decryption, and the full
 * event surface (`authenticated` / `disconnected` / `reconnecting` /
 * `error` / `message[.text|.image|...]` / `event[.enter_chat|...]`).
 */

import AiBot, { type WSClientOptions } from "@wecom/aibot-node-sdk"
import type { WecomCredentials, WecomConfig } from "./credentials.js"

const { WSClient } = AiBot

export type WecomClient = InstanceType<typeof WSClient>

export interface CreateWecomClientInput {
  credentials: WecomCredentials
  config?: WecomConfig
}

/**
 * Build a WSClient with v1 invariants applied:
 *   - `maxReconnectAttempts: -1` — never give up on network reconnects
 *   - `maxAuthFailureAttempts: -1` — never give up on auth retries
 *     (a separate SDK limit; without it a revoked secret would stop the
 *     client silently and runtime.ts would not notice)
 */
export function createWecomClient(input: CreateWecomClientInput): WecomClient {
  const options: WSClientOptions = {
    botId: input.credentials.botId,
    secret: input.credentials.secret,
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: -1,
  }
  if (input.config?.baseWsUrl) {
    options.wsUrl = input.config.baseWsUrl
  }
  return new WSClient(options)
}

/**
 * Resolve when the SDK fires `'authenticated'` for the first time. Rejects
 * if `timeoutMs` elapses OR the supplied `AbortSignal` aborts (whichever
 * comes first). **We intentionally do NOT listen for `'error'`** — the SDK
 * auto-reconnects with exponential backoff, and a transient network flap
 * should not terminate startup. Only a real timeout (bad credentials, or
 * the WeCom edge being completely unreachable) terminates from the timer
 * branch; aborts come from `stop()` cancelling the wait so lease release
 * isn't held hostage by a hung auth window.
 */
export function waitForAuthenticated(
  client: WecomClient,
  timeoutMs = 30_000,
  options?: { signal?: AbortSignal }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const signal = options?.signal
    if (signal?.aborted) {
      reject(new Error("wecom auth aborted"))
      return
    }
    let timer: NodeJS.Timeout | null = null
    let abortListener: (() => void) | null = null
    const cleanup = () => {
      client.off("authenticated", onAuth)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener)
        abortListener = null
      }
    }
    const onAuth = () => {
      cleanup()
      resolve()
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`wecom auth timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    if (signal) {
      abortListener = () => {
        cleanup()
        reject(new Error("wecom auth aborted"))
      }
      signal.addEventListener("abort", abortListener, { once: true })
    }
    client.once("authenticated", onAuth)
  })
}
