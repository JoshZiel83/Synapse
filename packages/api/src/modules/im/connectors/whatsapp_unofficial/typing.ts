/**
 * REAL typing adapter: `sendPresenceUpdate("composing"|"paused", jid)`.
 *
 * WhatsApp's composing indicator lapses after ~10s, so we return a heartbeat
 * config of ~8s (< 10s) to keep it alive between turns. The live socket is
 * resolved from the running-registry at call time (so a reconnect that swaps
 * the socket is transparent).
 */

import type { WASocket } from "baileys"
import type { TransportAccountSummary } from "@synapse/shared/types"
import type { TypingAdapter } from "../../typing/controller.js"
import type { EndpointRef } from "../types.js"
import { getHandle } from "./running-registry.js"
import { normalizeJid, TYPING_HEARTBEAT_MS } from "./types.js"

export interface WhatsappTypingDeps {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  /** Test seam: resolve the live socket. Defaults to the running-registry. */
  resolveSocket?: (accountId: string) => WASocket | null
}

function defaultResolveSocket(accountId: string): WASocket | null {
  const handle = getHandle(accountId)
  if (!handle || !handle.connected || !handle.socket) return null
  return handle.socket
}

export interface WhatsappTypingResult {
  adapter: TypingAdapter
  config: { heartbeatMs: number }
}

export function createWhatsappTypingAdapter(
  deps: WhatsappTypingDeps
): WhatsappTypingResult {
  const accountId = deps.account.id
  const jid = normalizeJid(deps.endpointRef.externalId)
  const resolveSocket = deps.resolveSocket ?? defaultResolveSocket

  async function send(presence: "composing" | "paused"): Promise<void> {
    const socket = resolveSocket(accountId)
    if (!socket || !jid) return
    try {
      await socket.sendPresenceUpdate(presence, jid)
    } catch {
      // typing is best-effort; never surface an error from the indicator.
    }
  }

  return {
    adapter: {
      start: () => send("composing"),
      stop: () => send("paused"),
    },
    config: { heartbeatMs: TYPING_HEARTBEAT_MS },
  }
}
