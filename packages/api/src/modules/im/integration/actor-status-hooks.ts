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
import { getTransportAccountById } from "../service.js"
import { tryGetConnector } from "../connectors/registry.js"
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

const RECENT_INBOUND_WINDOW_MS = 60 * 60 * 1000 // 1 hour — wide enough for delayed turns

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
  const link = await findRecentInboundLinkForConversation(input.conversationId)
  if (!link) {
    console.log(
      `[im:status] no inbound link found for cid=${input.conversationId.slice(0, 8)}`
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

  const adapter = connector.createStatusReactionAdapter({
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
