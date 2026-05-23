/**
 * Wire actor turn lifecycle events to per-session StatusReactionController.
 *
 * Subscribes to the existing event bus (packages/api/src/infrastructure/events)
 * for actor.thinking / session.thinking / actor.action and translates them
 * into set()/done()/error() calls on a StatusReactionController scoped per
 * (sessionId × originating inbound transport message).
 *
 * Per-conversation lookup: when a session starts thinking, find the most
 * recent inbound transport_message_link in that conversation (within a few
 * minutes). If present, build a StatusReactionAdapter via the registered
 * connector and create a controller. All subsequent events for the session
 * drive that controller. On terminal events, the controller schedules its
 * own destroy.
 */

import { sql } from "kysely"
import { db } from "../../../infrastructure/database/kysely.js"
import { onEvent } from "../../../infrastructure/events/index.js"
import {
  getTransportAccountById,
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
} from "../service.js"
import { tryGetConnector } from "../connectors/registry.js"
import { feishuConnector } from "../connectors/feishu/index.js"
import { createFeishuClient } from "../connectors/feishu/client.js"
import { createFeishuReactionAdapter } from "../connectors/feishu/reactions.js"
import {
  createStatusReactionController,
  type StatusReactionController,
} from "../status-reaction/controller.js"
import {
  resolveActorActionStatus,
  resolveSessionThinkingStatus,
} from "./status-resolver.js"

interface ActiveStatusSession {
  controller: StatusReactionController
  externalMessageId: string
  startedAt: number
}

const activeSessions = new Map<string, ActiveStatusSession>()

const RECENT_INBOUND_WINDOW_MS = 5 * 60 * 1000 // 5 min fallback window

interface InboundLinkLookup {
  externalMessageId: string
  endpointExternalId: string
  transportKind: string
  transportAccountId: string
}

async function resolveConversationIdForSession(
  sessionId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("sessions")
    .select("conversation_id")
    .where("id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  return row?.conversation_id || null
}

/**
 * Precise binding: look up the inbound transport_message_link via the
 * currently-running turn's trigger_item_id, so we react on the exact
 * message that woke this turn instead of "most recent in conversation
 * within an hour".
 */
async function findInboundLinkForSessionTurn(
  sessionId: string
): Promise<InboundLinkLookup | null> {
  const turnRow = await db
    .selectFrom("turns")
    .select(["trigger_item_id"])
    .where("session_id", "=", sessionId)
    .where("status", "=", "running")
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst()
  const itemId = turnRow?.trigger_item_id
  if (!itemId) {
    // Turn might not yet have transitioned to running (race) or already
    // completed. Try the most-recent-by-started-at as fallback.
    const fallback = await db
      .selectFrom("turns")
      .select(["trigger_item_id"])
      .where("session_id", "=", sessionId)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst()
    if (!fallback?.trigger_item_id) return null
    return findInboundLinkByItemId(fallback.trigger_item_id)
  }
  return findInboundLinkByItemId(itemId)
}

async function findInboundLinkByItemId(
  itemId: string
): Promise<InboundLinkLookup | null> {
  const row = await db
    .selectFrom("transport_message_links")
    .innerJoin(
      "transport_endpoints",
      "transport_endpoints.id",
      "transport_message_links.transport_endpoint_id"
    )
    .innerJoin(
      "transport_accounts",
      "transport_accounts.id",
      "transport_message_links.transport_account_id"
    )
    .select([
      "transport_message_links.external_message_id as externalMessageId",
      "transport_endpoints.external_id as endpointExternalId",
      "transport_accounts.transport_kind as transportKind",
      "transport_accounts.id as transportAccountId",
    ])
    .where("transport_message_links.item_id", "=", itemId)
    .where("transport_message_links.direction", "=", "inbound")
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.externalMessageId) return null
  return {
    externalMessageId: row.externalMessageId,
    endpointExternalId: row.endpointExternalId,
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
  }
}

/**
 * Fallback used when no turn is found yet (event arrived before turn row
 * persisted). Wider lookup by conversation + last hour. NEVER blindly
 * react on this lookup — it's a best-effort grace path.
 */
async function findRecentInboundLinkForConversation(
  conversationId: string
): Promise<InboundLinkLookup | null> {
  const cutoff = new Date(Date.now() - RECENT_INBOUND_WINDOW_MS).toISOString()
  const row = await db
    .selectFrom("transport_message_links")
    .innerJoin(
      "transport_endpoints",
      "transport_endpoints.id",
      "transport_message_links.transport_endpoint_id"
    )
    .innerJoin(
      "transport_accounts",
      "transport_accounts.id",
      "transport_message_links.transport_account_id"
    )
    .select([
      "transport_message_links.external_message_id as externalMessageId",
      "transport_endpoints.external_id as endpointExternalId",
      "transport_accounts.transport_kind as transportKind",
      "transport_accounts.id as transportAccountId",
    ])
    .where("transport_message_links.conversation_id", "=", conversationId)
    .where("transport_message_links.direction", "=", "inbound")
    .where(
      sql<boolean>`transport_message_links.created_at >= ${cutoff}::timestamptz`
    )
    .orderBy("transport_message_links.created_at", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.externalMessageId) return null
  return {
    externalMessageId: row.externalMessageId,
    endpointExternalId: row.endpointExternalId,
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
  }
}

async function ensureControllerForSession(input: {
  sessionId: string
  workspaceId: string
  conversationId: string
}): Promise<StatusReactionController | null> {
  // Prefer precise binding via the current turn's trigger_item_id.
  // Fall back to the conversation+time window heuristic only if no
  // turn row exists yet (race) — never as the steady-state path.
  let link = await findInboundLinkForSessionTurn(input.sessionId)
  if (!link) {
    link = await findRecentInboundLinkForConversation(input.conversationId)
    if (link) {
      console.log(
        `[im:status] precise turn lookup failed for sid=${input.sessionId.slice(0, 8)}; using fallback window`
      )
    }
  }
  if (!link) {
    console.log(
      `[im:status] no inbound link found for sid=${input.sessionId.slice(0, 8)}`
    )
    return null
  }

  // If we have a cached controller for this session but it's for a different
  // (older) inbound message, destroy it first so the new message gets its own.
  const existing = activeSessions.get(input.sessionId)
  if (existing) {
    if (existing.externalMessageId === link.externalMessageId) {
      return existing.controller
    }
    activeSessions.delete(input.sessionId)
    void existing.controller.destroy()
  }
  console.log(
    `[im:status] link found: kind=${link.transportKind} externalMsgId=${link.externalMessageId.slice(0, 12)} acct=${link.transportAccountId.slice(0, 8)}`
  )
  const connector = tryGetConnector(link.transportKind as any)
  if (!connector) {
    console.log(`[im:status] no connector registered for ${link.transportKind}`)
    return null
  }

  const account = await getTransportAccountById(link.transportAccountId)
  if (!account || account.workspaceId !== input.workspaceId) {
    console.log(
      `[im:status] account mismatch: acct=${account?.id?.slice(0, 8)} acct.ws=${account?.workspaceId?.slice(0, 8)} ev.ws=${input.workspaceId.slice(0, 8)}`
    )
    return null
  }

  const adapter =
    link.transportKind === "feishu"
      ? await buildFeishuAdapterWithPersistence({
          account,
          externalMessageId: link.externalMessageId,
          endpointExternalId: link.endpointExternalId,
        })
      : connector.createStatusReactionAdapter({
          account,
          messageRef: {
            externalMessageId: link.externalMessageId,
            endpointExternalId: link.endpointExternalId,
          },
        })
  if (!adapter) {
    console.log(`[im:status] connector returned null adapter`)
    return null
  }
  console.log(`[im:status] adapter created, registering controller`)

  const controller = createStatusReactionController({
    adapter,
    onError: (err) => {
      console.error(
        `[im:status] adapter error for session=${input.sessionId}:`,
        err
      )
    },
  })
  activeSessions.set(input.sessionId, {
    controller,
    externalMessageId: link.externalMessageId,
    startedAt: Date.now(),
  })
  return controller
}

async function destroyControllerForSession(sessionId: string): Promise<void> {
  const entry = activeSessions.get(sessionId)
  if (!entry) return
  activeSessions.delete(sessionId)
  await entry.controller.destroy()
}

/**
 * Build a Feishu StatusReactionAdapter pre-loaded with persisted reaction_id
 * state. Whenever the in-memory state changes, persist it back so a process
 * restart can read it and DELETE orphan reactions instead of leaking them.
 */
async function buildFeishuAdapterWithPersistence(input: {
  account: Awaited<ReturnType<typeof getTransportAccountById>>
  externalMessageId: string
  endpointExternalId: string
}) {
  if (!input.account) return null
  const account = input.account
  // Best-effort: load previously persisted reaction ids (silent on failure)
  let initial: Record<string, string> = {}
  try {
    initial = await loadTransportEmojiReactions({
      transportAccountId: account.id,
      externalMessageId: input.externalMessageId,
    })
  } catch (err) {
    console.warn("[im:status] failed to load persisted reactions:", err)
  }
  const client = createFeishuClient(account)
  const adapter = createFeishuReactionAdapter({
    client,
    messageRef: {
      externalMessageId: input.externalMessageId,
      endpointExternalId: input.endpointExternalId,
    },
    onReactionTracked: ({ reactionIdsByEmoji }) => {
      // Fire-and-forget persistence; no need to await in the hot path
      void saveTransportEmojiReactions({
        transportAccountId: account.id,
        externalMessageId: input.externalMessageId,
        reactionIdsByEmoji,
      }).catch((err) => {
        console.warn("[im:status] failed to save reactions:", err)
      })
    },
  })
  // If we restored prior state, replay it onto the adapter's bookkeeping so
  // setReaction("same emoji") becomes a no-op and clearReaction can delete.
  if (Object.keys(initial).length > 0) {
    for (const [emoji, reactionId] of Object.entries(initial)) {
      // Adapter exposes no setter for prior state; the reactionIdsByEmoji map
      // lives in the adapter closure. The pragmatic recovery here is to
      // immediately delete any orphan reactions left by a prior process.
      try {
        await client.im.messageReaction.delete({
          path: {
            message_id: input.externalMessageId,
            reaction_id: reactionId,
          },
        })
      } catch {
        // ignored: maybe already deleted or stale id
      }
      void emoji // emoji is consulted by the deletion call's logging path only
    }
    // Persist the now-cleared state so we don't try this again next restart
    try {
      await saveTransportEmojiReactions({
        transportAccountId: account.id,
        externalMessageId: input.externalMessageId,
        reactionIdsByEmoji: {},
      })
    } catch {}
  }
  return adapter
}

/**
 * Idempotent install. Call once during API startup. Returns a function that
 * unsubscribes (for graceful shutdown / tests).
 */
let installed = false
const unsubscribers: Array<() => void> = []

export function installActorStatusHooks(): () => void {
  if (installed) {
    return () => {}
  }
  installed = true

  unsubscribers.push(
    onEvent("actor.thinking", async (event) => {
      const payload = event.payload as Record<string, unknown>
      const sessionId = String(payload.sessionId || "")
      let conversationId = String(payload.conversationId || "")
      if (!sessionId) return
      if (!conversationId) {
        const looked = await resolveConversationIdForSession(sessionId)
        if (!looked) {
          console.log(
            `[im:status] no conversationId for sid=${sessionId.slice(0, 8)}`
          )
          return
        }
        conversationId = looked
      }
      console.log(
        `[im:status] actor.thinking sid=${sessionId.slice(0, 8)} cid=${conversationId.slice(0, 8)} ws=${event.workspaceId.slice(0, 8)}`
      )
      const controller = await ensureControllerForSession({
        sessionId,
        workspaceId: event.workspaceId,
        conversationId,
      })
      if (!controller) {
        console.log(
          `[im:status] no controller for sid=${sessionId.slice(0, 8)}`
        )
        return
      }
      console.log(
        `[im:status] dispatching queued → thinking for sid=${sessionId.slice(0, 8)}`
      )
      controller.set("queued")
      controller.set("thinking")
    })
  )

  unsubscribers.push(
    onEvent("session.thinking", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const existing = activeSessions.get(sessionId)
      if (!existing) return
      const level = resolveSessionThinkingStatus(event.payload)
      existing.controller.set(level)
    })
  )

  unsubscribers.push(
    onEvent("actor.action", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const existing = activeSessions.get(sessionId)
      if (!existing) return
      const level = resolveActorActionStatus(event.payload)
      if (level === null) {
        // No actions → treat as turn completion
        existing.controller.done()
        // Schedule destroy after a beat to let terminal hold work
        setTimeout(() => {
          void destroyControllerForSession(sessionId)
        }, 5_000)
      } else {
        existing.controller.set(level)
      }
    })
  )

  unsubscribers.push(
    onEvent("session.status.changed", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const status = String(event.payload.status || "")
      const existing = activeSessions.get(sessionId)
      if (!existing) return
      if (status === "error" || status === "failed") {
        existing.controller.error()
        setTimeout(() => {
          void destroyControllerForSession(sessionId)
        }, 5_000)
      } else if (status === "idle" || status === "completed") {
        existing.controller.done()
        setTimeout(() => {
          void destroyControllerForSession(sessionId)
        }, 5_000)
      }
    })
  )

  return () => {
    for (const u of unsubscribers) {
      try {
        u()
      } catch {}
    }
    unsubscribers.length = 0
    installed = false
  }
}

export async function shutdownActorStatusHooks(): Promise<void> {
  const ids = Array.from(activeSessions.keys())
  for (const id of ids) {
    await destroyControllerForSession(id)
  }
}
