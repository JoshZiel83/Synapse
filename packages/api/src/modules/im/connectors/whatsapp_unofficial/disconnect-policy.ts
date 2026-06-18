/**
 * PURE DisconnectReason → action policy.
 *
 * Codes verified against the INSTALLED baileys@6.7.23
 * (`node_modules/baileys/lib/Types/index.d.ts`):
 *
 *   connectionClosed      = 428
 *   connectionLost        = 408   (NOTE: `timedOut` is ALSO 408 — same value)
 *   connectionReplaced    = 440
 *   timedOut              = 408
 *   loggedOut             = 401
 *   badSession            = 500
 *   restartRequired       = 515
 *   multideviceMismatch   = 411
 *   forbidden             = 403
 *   unavailableService    = 503
 *
 * Actions:
 *   - "restart"   : dispose the socket + open a NEW one immediately (no backoff).
 *                   EXPECTED right after the first successful pair (515).
 *   - "wipe"      : session is dead/forbidden (401/403/411). Wipe creds, set the
 *                   session-guard pause flag, emit "needs re-link". Do NOT loop.
 *   - "reconnect" : transient (408/428/440/500/503/unknown). Backoff + retry.
 *   - "stop"      : intentional local stop (ctx.signal) — no reconnect.
 */

import { DisconnectReason } from "baileys"

export type DisconnectAction = "restart" | "wipe" | "reconnect" | "stop"

export interface DisconnectDecision {
  action: DisconnectAction
  /** Pause reason for the session-guard when action === "wipe". */
  pauseReason?: "logged_out" | "forbidden"
}

/**
 * Decide what to do given the numeric status code from the Boom error that
 * closed the connection. `intentionalStop` short-circuits to "stop".
 */
export function decideDisconnect(
  statusCode: number | undefined,
  intentionalStop: boolean
): DisconnectDecision {
  if (intentionalStop) return { action: "stop" }

  switch (statusCode) {
    case DisconnectReason.restartRequired: // 515
      return { action: "restart" }

    case DisconnectReason.loggedOut: // 401
      return { action: "wipe", pauseReason: "logged_out" }
    case DisconnectReason.forbidden: // 403
      return { action: "wipe", pauseReason: "forbidden" }
    case DisconnectReason.multideviceMismatch: // 411
      return { action: "wipe", pauseReason: "logged_out" }

    case DisconnectReason.connectionClosed: // 428
    case DisconnectReason.connectionLost: // 408 (=== timedOut)
    case DisconnectReason.connectionReplaced: // 440
    case DisconnectReason.badSession: // 500
    case DisconnectReason.unavailableService: // 503
      return { action: "reconnect" }

    default:
      // Unknown / undefined → be conservative and retry.
      return { action: "reconnect" }
  }
}

/** Extract the numeric status code from a Boom-or-Error disconnect error. */
export function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const output = (error as { output?: { statusCode?: unknown } }).output
  const code = output?.statusCode
  if (typeof code === "number") return code
  // Some errors carry it directly.
  const direct = (error as { statusCode?: unknown }).statusCode
  return typeof direct === "number" ? direct : undefined
}
