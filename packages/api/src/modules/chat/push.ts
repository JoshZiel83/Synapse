import type { SystemEvent } from "@synapse/shared"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("chat-push")

/**
 * WI-4 — Mobile/web push delivery. RESERVED ENTRY POINT, NOT IMPLEMENTED.
 *
 * Decision (locked): push is out of scope for this change; we only reserve the
 * seam so the durable-event pipeline already has the call site and a presence
 * interface to grow into, without re-plumbing later.
 *
 * The token store (`chat_push_tokens`) and its CRUD already exist
 * (registerChatPushToken / listChatPushTokens / deleteChatPushToken in
 * service.ts). What is intentionally absent is the SEND side:
 *   - a presence check (is any of the recipient's devices currently connected
 *     over /ws? — model on auth-session-registry's Redis control channel),
 *   - per-platform adapters (web: Web Push/VAPID; ios/android: Expo Push or
 *     APNs+FCM — route undecided),
 *   - the web service-worker `push`/`notificationclick` handlers.
 *
 * When implemented, the natural trigger is here: a durable chat.sync.event
 * carrying a user-visible `conversation.item.created` (not authored by the
 * recipient, conversation not muted) whose recipient has NO live socket.
 */

/** Presence oracle placeholder — returns true if the member has a live socket. */
export interface ChatPresenceProbe {
  hasLiveSocket(workspaceMemberId: string): Promise<boolean>
}

/**
 * Reserved hook invoked once per dispatched durable realtime event. No-op until
 * push is implemented. Deliberately swallows nothing and does nothing — kept
 * side-effect-free so the dispatcher hot path is unaffected.
 */
export async function maybeEnqueuePush(_event: SystemEvent): Promise<void> {
  // TODO(WI-4): when a recipient has no live socket and the event is a
  // user-visible inbound message, resolve their chat_push_tokens and dispatch
  // via the platform adapter. Intentionally a no-op today.
  if (process.env.SYNAPSE_DEBUG_PUSH_HOOK === "1") {
    log.debug({ type: _event.type }, "[push] maybeEnqueuePush no-op")
  }
}
