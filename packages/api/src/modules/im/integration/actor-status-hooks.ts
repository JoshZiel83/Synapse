/**
 * Wire actor turn lifecycle events to per-session StatusReactionController
 * AND TypingController.
 *
 * Subscribes to the existing event bus (packages/api/src/infrastructure/events)
 * for actor.thinking / actor.action / runtime.updated and dispatches to
 * whichever connector matches the originating inbound IM message. No
 * transport-specific imports here; the connector layer owns the specifics.
 *
 * NOTE on the event set: session.thinking + session.status.changed were
 * deleted in S13 (worktree-im-api-refactor). runtime.updated, emitted by
 * publishSessionRuntime() with a full ActorRuntimeState snapshot, now
 * carries both signals (phase transitions and lane/health terminal
 * transitions). The runtime.updated handler dispatches through the pure
 * decideRuntimeUpdateAction() in ./status-resolver.ts.
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
 * actor.thinking / actor.action / runtime.updated are delivered through
 * Redis pub/sub fan-out (see infrastructure/events/index.ts:onEvent), so
 * every replica subscribed to the bus runs this hook in parallel. Without
 * coordination they'd each try to create/delete the same Feishu reaction
 * or weixin typing — duplicate platform calls + a race on
 * `external_emoji_reactions`.
 *
 * The hook resolves this by grabbing a per-(account, externalMessageId)
 * Redis claim before constructing the controllers. The first replica
 * to call ensureControllersForSession for a given inbound message wins
 * the claim and proceeds; everyone else returns null and silently
 * skips. The claim is renewed on each subsequent event for that
 * session and released on terminal events / shutdown.
 */

import { sql, type SqlBool } from "kysely"
import { db } from "../../../infrastructure/database/kysely.js"
import { onEvent } from "../../../infrastructure/events/index.js"
import { redis } from "../../../infrastructure/redis/index.js"
import { createLogger } from "../../../infrastructure/logger/index.js"
import {
  getTransportAccountById,
  loadTransportEmojiReactions,
  saveTransportEmojiReactions,
} from "../service.js"
import { tryGetConnector } from "../connectors/registry.js"
import { unwrapTypingAdapterResult } from "../connectors/types.js"
import {
  createStatusClaimClient,
  type ClaimRedisLike,
} from "../status-reaction/claim.js"
import {
  createStatusReactionController,
  type StatusReactionController,
} from "../status-reaction/controller.js"
import {
  createTypingController,
  type TypingController,
} from "../typing/controller.js"
import {
  decideRuntimeUpdateAction,
  resolveActorActionStatus,
} from "./status-resolver.js"

// One claim client per process, bound to the application-wide Redis.
// The claim itself is per-(account, externalMessageId), so a single
// client is enough.
const statusClaim = createStatusClaimClient(redis as unknown as ClaimRedisLike)

const log = createLogger("im.status")

interface ActiveStatusSession {
  reaction: StatusReactionController
  typing: TypingController
  externalMessageId: string
  transportAccountId: string
  claimToken: string
  startedAt: number
}

const activeSessions = new Map<string, ActiveStatusSession>()

const STARVATION_WINDOW_MS = 5 * 60 * 1000 // 5 min fallback window

interface InboundLinkLookup {
  externalMessageId: string
  endpointExternalId: string
  endpointType: "direct" | "group"
  transportKind: string
  transportAccountId: string
}

interface InboundLinkLookupWithCreatedAt extends InboundLinkLookup {
  createdAt: string
}

/**
 * Snapshot of the most recent RUNNING turn for a session. Used by both the
 * primary trigger-item lookup AND the fallback cutoff so the two see the
 * same state.
 *
 * `started_at` is nullable in schema (`turns.started_at`, see
 * generated/db.ts). `createTurn` writes NOW() in practice, but legacy /
 * dirty rows could still be null. We return ISO strings (or null) so
 * downstream string-based comparisons don't go through JS Date coercion.
 */
interface RunningTurnRow {
  trigger_item_id: string | null
  started_at: string | null
}

// Re-export the types the test file needs to type its fixtures. The
// underlying interfaces stay module-private so they can evolve without
// becoming part of a wider public surface.
export type {
  InboundLinkLookup as StatusInboundLinkLookup,
  InboundLinkLookupWithCreatedAt as StatusFallbackInboundLink,
  RunningTurnRow as StatusRunningTurnRow,
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
 * Most recent RUNNING turn for a session.
 *
 * Does NOT fall back to completed turns — the prior lookup at this site
 * picked the most recent turn regardless of status, which let a stale
 * completed turn's `started_at` extend the fallback cutoff far into the
 * past.
 *
 * `ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 1`: a dirty row
 * with `started_at = NULL` must not eclipse a real running turn (Postgres
 * default `NULLS FIRST` on DESC would put nulls at the top). `id DESC` is
 * the deterministic tiebreaker. The returned `started_at` is the ISO
 * string form so the decide helper does string-vs-string comparisons.
 *
 * Exported for tests (`im-status-loaders.test.ts`).
 */
export async function loadCurrentRunningTurnRow(
  sessionId: string
): Promise<RunningTurnRow | null> {
  const row = await db
    .selectFrom("turns")
    .select(["trigger_item_id", "started_at", "id"])
    .where("session_id", "=", sessionId)
    .where("status", "=", "running")
    .orderBy(sql`started_at DESC NULLS LAST`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    trigger_item_id: row.trigger_item_id,
    started_at:
      row.started_at instanceof Date
        ? row.started_at.toISOString()
        : row.started_at
          ? String(row.started_at)
          : null,
  }
}

/**
 * Resolve the inbound link for a given trigger item id (the conversation
 * item that started the current actor turn).
 *
 * Adds `NULLIF(BTRIM(external_message_id), '') IS NOT NULL` to the SQL so
 * a link row with a null / empty / whitespace external id is treated as
 * "no link" by the loader and the caller falls through to the fallback
 * path. The schema allows empty strings (see schema.sql for
 * transport_message_links) and a `LIMIT 1` without this predicate could
 * silently use a placeholder id downstream.
 *
 * Exported for tests.
 */
export async function findInboundLinkForTriggerItem(
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
    .where(
      sql<SqlBool>`NULLIF(BTRIM(transport_message_links.external_message_id), '') IS NOT NULL`
    )
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

/**
 * Most recent inbound link in the conversation, filtered to rows whose
 * `created_at >= cutoffIso`. Returns `createdAt` alongside the link so
 * the decide helper can verify the cutoff lexicographically.
 *
 * Same `NULLIF(BTRIM(...), '') IS NOT NULL` predicate as the trigger-item
 * loader so a newer row with an empty external_message_id can't hide an
 * older valid row via `ORDER BY created_at DESC LIMIT 1`.
 *
 * Caller supplies the cutoff so all observability flows through one
 * formula (`computeStatusFallbackCutoffIso`).
 *
 * Exported for tests.
 */
export async function findRecentInboundLinkForConversation(
  conversationId: string,
  cutoffIso: string
): Promise<InboundLinkLookupWithCreatedAt | null> {
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
      "transport_message_links.created_at as createdAt",
    ])
    .where("transport_message_links.conversation_id", "=", conversationId)
    .where("transport_message_links.direction", "=", "inbound")
    .where(
      sql<SqlBool>`NULLIF(BTRIM(transport_message_links.external_message_id), '') IS NOT NULL`
    )
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
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  }
}

/**
 * Cutoff for the fallback inbound-link query.
 *
 *   - If a running turn exists AND has a non-null `started_at`: use
 *     `started_at`. The fallback cannot reach back before this turn
 *     began — preventing the silent misattribution where a recent IM
 *     message from before the current turn's start gets reactions.
 *   - Otherwise (no running turn, or running turn with null
 *     `started_at`): fall back to `now - starvationWindowMs`. Preserves
 *     the legacy 5-minute starvation window for cases where the
 *     runtime hasn't written the turn row yet (the early
 *     `actor.thinking` race).
 *
 * Exported so both `ensureControllersForSession` (deriving cutoffIso for
 * the SQL query) and `decideStatusLookupSource` (deriving cutoff for the
 * in-helper comparison) share one formula and can't drift.
 */
export function computeStatusFallbackCutoffIso(
  runningTurn: RunningTurnRow | null,
  now: number,
  starvationWindowMs: number = STARVATION_WINDOW_MS
): string {
  return (
    runningTurn?.started_at ?? new Date(now - starvationWindowMs).toISOString()
  )
}

/**
 * Pure decision helper for which inbound link the status controllers
 * should attach to.
 *
 *   - `primary` → trigger-item lookup succeeded; use it. Independent of
 *     `started_at` (a dirty null started_at on the running turn does
 *     NOT prevent the primary path).
 *   - `fallback` → trigger-item lookup returned null AND the fallback
 *     link's `createdAt` is within the cutoff window. The `reason`
 *     reflects why we fell back so logs surface the underlying state.
 *   - `none` → no usable link.
 *
 * `>=` on the cutoff includes the boundary. Both sides are normalized
 * ISO-8601 with `Z` suffix (Postgres TIMESTAMPTZ → `.toISOString()`),
 * so lexicographic comparison is correct.
 */
export function decideStatusLookupSource(input: {
  primaryLink: InboundLinkLookup | null
  runningTurn: RunningTurnRow | null
  fallbackLink: InboundLinkLookupWithCreatedAt | null
  now: number
  starvationWindowMs?: number
}): {
  kind: "primary" | "fallback" | "none"
  link?: InboundLinkLookup
  reason?:
    | "no-running-turn"
    | "running-turn-without-trigger-item"
    | "trigger-item-without-link"
} {
  if (input.primaryLink) {
    return { kind: "primary", link: input.primaryLink }
  }
  if (!input.fallbackLink) {
    return { kind: "none" }
  }
  const cutoff = computeStatusFallbackCutoffIso(
    input.runningTurn,
    input.now,
    input.starvationWindowMs
  )
  if (input.fallbackLink.createdAt < cutoff) {
    return { kind: "none" }
  }
  let reason:
    | "no-running-turn"
    | "running-turn-without-trigger-item"
    | "trigger-item-without-link"
  if (!input.runningTurn) {
    reason = "no-running-turn"
  } else if (input.runningTurn.trigger_item_id) {
    // Running turn references a trigger item, but findInboundLinkForTriggerItem
    // returned null (no inbound link for that item, e.g. non-IM origin).
    reason = "trigger-item-without-link"
  } else {
    reason = "running-turn-without-trigger-item"
  }
  return { kind: "fallback", link: input.fallbackLink, reason }
}

async function ensureControllersForSession(input: {
  sessionId: string
  workspaceId: string
  conversationId: string
}): Promise<ActiveStatusSession | null> {
  // Single running-turn snapshot drives both the primary trigger-item
  // lookup AND the fallback cutoff. Reading it twice would risk
  // observing two different snapshots and logging a fallback `reason`
  // that doesn't match the actual primary-lookup state.
  const runningTurn = await loadCurrentRunningTurnRow(input.sessionId)
  const primaryLink = runningTurn?.trigger_item_id
    ? await findInboundLinkForTriggerItem(runningTurn.trigger_item_id)
    : null
  const now = Date.now()
  const cutoffIso = computeStatusFallbackCutoffIso(runningTurn, now)
  const fallbackLink = primaryLink
    ? null
    : await findRecentInboundLinkForConversation(
        input.conversationId,
        cutoffIso
      )
  const decision = decideStatusLookupSource({
    primaryLink,
    runningTurn,
    fallbackLink,
    now,
  })
  if (decision.kind === "fallback" && decision.link) {
    // Surface every fallback hit so misattribution doesn't stay silent.
    // The reason field tells operators whether the fallback fired because
    // the runtime hadn't written a turn row yet (no-running-turn — the
    // early actor.thinking starvation case, expected), because the turn
    // had no trigger item (autonomous / actor-initiated), or because the
    // trigger item existed but had no inbound IM link (non-IM trigger).
    log.warn(
      {
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        externalMessageId: decision.link.externalMessageId,
        reason: decision.reason,
      },
      "[im:status] fallback inbound-link used"
    )
  }
  if (decision.kind === "none" || !decision.link) {
    return null
  }
  const link = decision.link

  const existing = activeSessions.get(input.sessionId)
  if (existing && existing.externalMessageId === link.externalMessageId) {
    // Same message as before — extend the claim so a long turn doesn't
    // expire mid-stream and let another replica steal in. Best-effort:
    // if renew fails, the next event will surface that via a missing
    // claim and tear down cleanly.
    void statusClaim
      .renew(
        {
          transportAccountId: existing.transportAccountId,
          externalMessageId: existing.externalMessageId,
        },
        existing.claimToken
      )
      .catch(() => undefined)
    return existing
  }
  if (existing) {
    await destroyControllersForSession(input.sessionId)
  }

  const connector = tryGetConnector(link.transportKind as any)
  if (!connector) return null

  const account = await getTransportAccountById(link.transportAccountId)
  if (!account || account.workspaceId !== input.workspaceId) return null

  // Multi-replica claim: only the replica that wins this SETNX runs the
  // controllers for this (account, externalMessageId). Everyone else
  // returns null and silently drops the event.
  const accountId = account.id
  const externalMessageId = link.externalMessageId
  const claimToken = await statusClaim.acquire({
    transportAccountId: accountId,
    externalMessageId,
  })
  if (!claimToken) {
    return null
  }

  // Reaction adapter — connector wires the onPersist callback into its own
  // tracking. No platform-specific code here.

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
    log.warn({ err }, "[im:status] failed to load persisted reactions")
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
        log.warn({ err }, "[im:status] failed to save reactions")
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
      log.error(
        { err },
        `[im:status] reaction adapter error for session=${input.sessionId}`
      )
    },
  })

  // Typing adapter — separate controller, separate lifecycle. Adapter
  // is null on platforms without typing capability (e.g. Feishu).
  // Connectors that need controller config overrides (e.g. QQ
  // input_notify wants 50s heartbeat) return `{ adapter, config }`;
  // unwrap to keep both shapes working.
  const typingAdapterResult = connector.createTypingAdapter({
    account,
    endpointRef: {
      endpointType: link.endpointType,
      externalId: link.endpointExternalId,
      metadata: {},
    },
    // The current claim is anchored on the last inbound message that
    // produced this turn; some platforms (QQ C2C `input_notify`) need
    // the inbound msg_id to construct a valid typing request.
    lastInboundMessageRef: {
      externalMessageId,
      endpointExternalId: link.endpointExternalId,
    },
  })
  const typingUnwrapped = unwrapTypingAdapterResult(typingAdapterResult)
  const typingController = createTypingController({
    adapter: typingUnwrapped?.adapter ?? null,
    config: typingUnwrapped?.config,
    onError: (err) => {
      log.error(
        { err },
        `[im:status] typing adapter error for session=${input.sessionId}`
      )
    },
  })

  const entry: ActiveStatusSession = {
    reaction: reactionController,
    typing: typingController,
    externalMessageId,
    transportAccountId: accountId,
    claimToken,
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
  // Release the claim so a subsequent inbound message on the same
  // account can be handled by whatever replica wins next, including
  // ones that didn't see this round of events.
  await statusClaim
    .release(
      {
        transportAccountId: entry.transportAccountId,
        externalMessageId: entry.externalMessageId,
      },
      entry.claimToken
    )
    .catch(() => undefined)
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
      // self-stops on the first runtime.updated phase transition (via
      // the handler below) or at terminal events.
      entry.typing.start()
    })
  )

  unsubscribers.push(
    onEvent("runtime.updated", async (event) => {
      // Replaces the removed session.thinking + session.status.changed
      // handlers. publishSessionRuntime() now drives all phase / lane /
      // health transitions via this single event, carrying a full
      // ActorRuntimeState snapshot.
      const snapshot = (event.payload as { snapshot?: unknown })?.snapshot as
        | {
            sessionId?: unknown
            laneState?: unknown
            health?: unknown
            phase?: unknown
          }
        | undefined
      if (!snapshot || typeof snapshot !== "object") return
      const sessionId = String(snapshot.sessionId || "")
      if (!sessionId) return
      const entry = activeSessions.get(sessionId)
      if (!entry) return

      const decision = decideRuntimeUpdateAction(snapshot)
      switch (decision.kind) {
        case "terminal-error":
          entry.reaction.error()
          entry.typing.stop()
          setTimeout(() => {
            void destroyControllersForSession(sessionId)
          }, 5_000)
          return
        case "terminal-done":
          entry.reaction.done()
          entry.typing.stop()
          setTimeout(() => {
            void destroyControllersForSession(sessionId)
          }, 5_000)
          return
        case "set-level":
          // The reaction controller debounces same-level sets, so duplicate
          // runtime.updated events from unrelated snapshot churn (turn
          // previews, wakeup count changes) are safe.
          entry.reaction.set(decision.level)
          entry.typing.stop()
          return
        case "noop":
          return
      }
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
