/**
 * Wire actor turn lifecycle events to per-session StatusReactionController
 * AND TypingController.
 *
 * Subscribes to the existing event bus (packages/api/src/infrastructure/events)
 * for actor.thinking / session.thinking / actor.action / session.status.changed
 * and dispatches to whichever connector matches the originating inbound IM
 * message. No transport-specific imports here; the connector layer owns the
 * specifics.
 *
 * Per-(sessionId × externalMessageId) the hook creates two controllers:
 *   - StatusReactionController (for platforms with canReact, e.g. Feishu)
 *   - TypingController         (for platforms with canTyping, e.g. WeChat)
 * Either may be a null-controller if the connector returns null for that
 * platform.
 *
 * Reaction persistence (orphan cleanup on restart) is handled generically:
 * the hook loads the persisted glyph → reaction_id map, seeds the adapter
 * with it (so removeReaction actually has ids to delete), then runs the
 * orphan-delete pass. onPersist walks the DB row down to {} as deletes
 * land, so the next restart finds a clean slate.
 *
 * ─── Multi-replica safety ───
 * Events are delivered via Redis pub/sub fan-out (see
 * infrastructure/events/index.ts:onEvent), so every replica that has
 * subscribed will fire this hook. In a multi-replica deployment that
 * means N replicas will each try to create/delete reactions for the
 * same inbound message — duplicate platform calls + races.
 *
 * V1 deployments run a single API replica, which is correct by
 * construction. Before adding a second replica, the plan calls for
 * extracting this hook into dedicated `workers/im-status-reaction.ts`
 * and `workers/im-typing.ts` BullMQ workers (one consumer per queue)
 * so only one replica processes each event. See
 * docs/im-transport-design.md for the contract.
 */

import { db } from "../../../infrastructure/database/kysely.js"
import { onEvent } from "../../../infrastructure/events/index.js"
import {
  getTransportAccountById,
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
} from "../service.js"
import { tryGetConnector } from "../connectors/registry.js"
import {
  createStatusReactionController,
  type StatusReactionController,
} from "../status-reaction/controller.js"
import {
  createTypingController,
  type TypingController,
} from "../typing/controller.js"
import {
  resolveActorActionStatus,
  resolveSessionThinkingStatus,
} from "./status-resolver.js"

interface ActiveStatusSession {
  reaction: StatusReactionController
  typing: TypingController
  externalMessageId: string
  startedAt: number
}

const activeSessions = new Map<string, ActiveStatusSession>()

const RECENT_INBOUND_WINDOW_MS = 5 * 60 * 1000 // 5 min fallback window

interface InboundLinkLookup {
  externalMessageId: string
  endpointExternalId: string
  endpointType: "direct" | "group"
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
      "transport_endpoints.endpoint_type as endpointType",
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
    endpointType: row.endpointType as "direct" | "group",
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
  }
}

async function findRecentInboundLinkForConversation(
  conversationId: string
): Promise<InboundLinkLookup | null> {
  const cutoffIso = new Date(
    Date.now() - RECENT_INBOUND_WINDOW_MS
  ).toISOString()
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
      "transport_endpoints.endpoint_type as endpointType",
      "transport_accounts.transport_kind as transportKind",
      "transport_accounts.id as transportAccountId",
    ])
    .where("transport_message_links.conversation_id", "=", conversationId)
    .where("transport_message_links.direction", "=", "inbound")
    .where("transport_message_links.created_at", ">=", cutoffIso as any)
    .orderBy("transport_message_links.created_at", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.externalMessageId) return null
  return {
    externalMessageId: row.externalMessageId,
    endpointExternalId: row.endpointExternalId,
    endpointType: row.endpointType as "direct" | "group",
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
  }
}

async function ensureControllersForSession(input: {
  sessionId: string
  workspaceId: string
  conversationId: string
}): Promise<ActiveStatusSession | null> {
  let link = await findInboundLinkForSessionTurn(input.sessionId)
  if (!link) {
    link = await findRecentInboundLinkForConversation(input.conversationId)
  }
  if (!link) {
    return null
  }

  const existing = activeSessions.get(input.sessionId)
  if (existing && existing.externalMessageId === link.externalMessageId) {
    return existing
  }
  if (existing) {
    activeSessions.delete(input.sessionId)
    void existing.reaction.destroy()
    void existing.typing.destroy()
  }

  const connector = tryGetConnector(link.transportKind as any)
  if (!connector) return null

  const account = await getTransportAccountById(link.transportAccountId)
  if (!account || account.workspaceId !== input.workspaceId) return null

  // Reaction adapter — connector wires the onPersist callback into its own
  // tracking. No platform-specific code here.
  const accountId = account.id
  const externalMessageId = link.externalMessageId

  // Load any reaction ids the previous process persisted on this inbound
  // message, so we can both (a) seed the new adapter's id map so
  // removeReaction has something to delete, and (b) walk that map to clean
  // them up before we draw the new status sequence.
  let persistedReactions: Record<string, string> = {}
  try {
    persistedReactions = await loadTransportEmojiReactions({
      transportAccountId: accountId,
      externalMessageId,
    })
  } catch (err) {
    console.warn("[im:status] failed to load persisted reactions:", err)
  }

  const reactionAdapter = connector.createStatusReactionAdapter({
    account,
    messageRef: {
      externalMessageId,
      endpointExternalId: link.endpointExternalId,
    },
    initialReactionIdsByEmoji: persistedReactions,
    onPersist: ({ reactionIdsByEmoji }) => {
      void saveTransportEmojiReactions({
        transportAccountId: accountId,
        externalMessageId,
        reactionIdsByEmoji,
      }).catch((err) => {
        console.warn("[im:status] failed to save reactions:", err)
      })
    },
  })

  // Reaction state recovery: ask the connector to delete any orphan
  // reactions left by a previous process. The adapter was seeded with
  // `persistedReactions` above, so removeReaction(glyph) now has the
  // platform reaction_id to actually delete. The onPersist callback
  // fires after each delete and walks the saved map down to {}, so we
  // don't need a separate clearing write.
  if (reactionAdapter && Object.keys(persistedReactions).length > 0) {
    for (const glyph of Object.keys(persistedReactions)) {
      try {
        await reactionAdapter.removeReaction?.(glyph)
      } catch {
        // best-effort
      }
    }
  }

  const reactionController = createStatusReactionController({
    adapter: reactionAdapter,
    onError: (err) => {
      console.error(
        `[im:status] reaction adapter error for session=${input.sessionId}:`,
        err
      )
    },
  })

  // Typing adapter — separate controller, separate lifecycle. Adapter is
  // null on platforms without typing capability (e.g. Feishu).
  const typingAdapter = connector.createTypingAdapter({
    account,
    endpointRef: {
      endpointType: link.endpointType,
      externalId: link.endpointExternalId,
      metadata: {},
    },
  })
  const typingController = createTypingController({
    adapter: typingAdapter,
    onError: (err) => {
      console.error(
        `[im:status] typing adapter error for session=${input.sessionId}:`,
        err
      )
    },
  })

  const entry: ActiveStatusSession = {
    reaction: reactionController,
    typing: typingController,
    externalMessageId,
    startedAt: Date.now(),
  }
  activeSessions.set(input.sessionId, entry)
  return entry
}

async function destroyControllersForSession(sessionId: string): Promise<void> {
  const entry = activeSessions.get(sessionId)
  if (!entry) return
  activeSessions.delete(sessionId)
  await entry.reaction.destroy()
  await entry.typing.destroy()
}

let installed = false
const unsubscribers: Array<() => void> = []

export function installActorStatusHooks(): () => void {
  if (installed) return () => {}
  installed = true

  unsubscribers.push(
    onEvent("actor.thinking", async (event) => {
      const payload = event.payload as Record<string, unknown>
      const sessionId = String(payload.sessionId || "")
      let conversationId = String(payload.conversationId || "")
      if (!sessionId) return
      if (!conversationId) {
        const looked = await resolveConversationIdForSession(sessionId)
        if (!looked) return
        conversationId = looked
      }
      const entry = await ensureControllersForSession({
        sessionId,
        workspaceId: event.workspaceId,
        conversationId,
      })
      if (!entry) return
      entry.reaction.set("queued")
      entry.reaction.set("thinking")
      // Typing starts when the actor begins thinking; the controller
      // self-stops after first model output via session.thinking handler
      // below, or at terminal events.
      entry.typing.start()
    })
  )

  unsubscribers.push(
    onEvent("session.thinking", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const entry = activeSessions.get(sessionId)
      if (!entry) return
      const level = resolveSessionThinkingStatus(event.payload)
      entry.reaction.set(level)
      // First sign of real model activity → stop the typing indicator so
      // the user sees text arriving instead of an ever-present "typing…".
      entry.typing.stop()
    })
  )

  unsubscribers.push(
    onEvent("actor.action", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const entry = activeSessions.get(sessionId)
      if (!entry) return
      const level = resolveActorActionStatus(event.payload)
      if (level === null) {
        entry.reaction.done()
        entry.typing.stop()
        setTimeout(() => {
          void destroyControllersForSession(sessionId)
        }, 5_000)
      } else {
        entry.reaction.set(level)
      }
    })
  )

  unsubscribers.push(
    onEvent("session.status.changed", async (event) => {
      const sessionId = String(event.payload.sessionId || "")
      const status = String(event.payload.status || "")
      const entry = activeSessions.get(sessionId)
      if (!entry) return
      if (status === "error" || status === "failed") {
        entry.reaction.error()
        entry.typing.stop()
        setTimeout(() => {
          void destroyControllersForSession(sessionId)
        }, 5_000)
      } else if (status === "idle" || status === "completed") {
        entry.reaction.done()
        entry.typing.stop()
        setTimeout(() => {
          void destroyControllersForSession(sessionId)
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
    await destroyControllersForSession(id)
  }
}
