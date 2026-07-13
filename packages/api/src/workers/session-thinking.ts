import { tracedWorker, withRootTrace } from "./job-tracing.js"
import { redis } from "../infrastructure/redis/index.js"
import {
  acquireLock,
  renewLock,
  releaseLock,
  type AcquiredLock,
} from "../infrastructure/redis/lock.js"
import { emitEvent } from "../infrastructure/events/index.js"
import {
  ACTOR_RUNTIME_HEALTH,
  QUEUE_NAMES,
  SESSION_LOCK_TTL,
  REDIS_CHANNELS,
  CONVERSATION_MESSAGE_SUBTYPE,
  isThreadConversationKind,
  textBlocks,
  CONVERSATION_PARTICIPANT_TYPE,
} from "@synapse/shared"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { isPlanCollaborationMode } from "@synapse/shared/utils"
import type {
  ConversationParticipantEntry,
  ProviderContextManifest,
  ProviderContextWindow,
} from "@synapse/shared"
import type { CanonicalContextItem } from "@synapse/shared/types"
import { actorThink } from "../modules/ai/index.js"
import {
  provisionSandbox,
  refreshSpaces,
  commitSpaces,
  teardownSandbox,
  peekPendingCommitConflicts,
  clearPendingCommitConflicts,
  peekPendingRefreshConflicts,
  clearPendingRefreshConflicts,
  mergePendingRefreshConflicts,
} from "../modules/sandbox/index.js"
import {
  partitionSidecars,
  formatRestoredPair,
  transientUnrestoredSentence,
  permanentUnrestoredSentence,
} from "../modules/sandbox/conflict-notice.js"
import type { SidecarRestoreFailureReason } from "../modules/sandbox/model.js"
import { config } from "../config/index.js"
import { buildActorPrompt } from "../modules/ai/prompt-builder.js"
import {
  buildConversationContextItems,
  buildSessionContextItems,
  loadExecutionToolResultsForSession,
  conversationItemToContextItem,
} from "../modules/ai/context-builder.js"
import { buildProviderContextWindow } from "../modules/context/service.js"
import { executeActorActions } from "../modules/orchestrator/service.js"
import { resolveModelPlan } from "../modules/model-groups/resolver.js"
import { shutdownSessionInstances } from "../modules/mcp-plugins/instance-manager.js"
import { getActor } from "../modules/organization/service.js"
import {
  getSession,
  getSessionMessages,
  updateSessionStatus,
  addSessionMessage,
  consumeInterrupts,
  hasPendingInterrupt,
} from "../modules/session/service.js"
import { getContextConversationItemsForParticipant } from "../modules/chat/conversation-item-read.js"
import {
  getConversationParticipantUseCase as getConversationParticipant,
  listConversationParticipantsUseCase as listConversationParticipants,
} from "../modules/chat/participant-roster.js"
import {
  attachPendingWakeupsToTurn,
  getPendingWakeupCount,
  getPendingWakeups,
  markTurnWakeupsDropped,
  markTurnWakeupsProcessed,
  publishSessionRuntime,
  restoreTurnWakeupsToPending,
} from "../modules/session/runtime.js"
import { createTurn, updateTurnStatus } from "../modules/execution/service.js"
import {
  buildMemoryRecallQuery,
  recallMemories,
} from "../modules/memory/service.js"
import { resolveActorCapabilitySurface } from "../modules/capabilities/surface.js"
import { sessionThinkingQueue } from "./queues.js"
import { registerWorker } from "./registry.js"
import { getAssistantSessionMessagePersistence } from "./session-message-persistence.js"
import { createLogger } from "../infrastructure/logger/index.js"
import {
  getActorMaxSessions,
  markSessionMemoryBootstrapCompleted,
} from "./session-thinking-repo.js"

const log = createLogger("session-thinking")

/**
 * Delay before re-attempting a session whose lock was held by another worker
 * while wakeups were still pending. Long enough to let a normal turn's
 * post-model side-effects finish, short enough that a user's queued message
 * isn't left waiting noticeably.
 */
const LOCK_CONTENDED_RETRY_DELAY_MS = 2_000

type ThinkingPhase = "thinking" | "tool"

function deriveThinkingPhase(status: string): ThinkingPhase {
  const normalized = status.trim().toLowerCase()

  if (
    normalized.startsWith("searching ") ||
    normalized.startsWith("fetching ")
  ) {
    return "tool"
  }

  if (
    normalized.startsWith("calling ") &&
    normalized !== "calling ai model..."
  ) {
    return "tool"
  }

  return "thinking"
}

// Opt-in file sandbox (device-runtime + content-addressed mounts).
const sandboxEnabled = config.sandbox.provider !== "none"

async function runCleanupStep(
  label: string,
  operation: () => Promise<unknown>
) {
  try {
    await operation()
  } catch (err: any) {
    log.error({ err }, `Cleanup step failed for ${label}`)
  }
}

async function loadNewContextItems(params: {
  conversationId: string
  participantId: string
  actorId: string
  sinceSequence: number
}) {
  const visibleItems = await getContextConversationItemsForParticipant({
    conversationId: params.conversationId,
    participantId: params.participantId,
    limit: 200,
  })

  const newItems = visibleItems.filter(
    (item: any) => item.sequence > params.sinceSequence
  )
  const items: CanonicalContextItem[] = []
  let maxSequence = params.sinceSequence

  for (const item of newItems) {
    maxSequence = Math.max(maxSequence, item.sequence)
    if (item.authorParticipant?.actorId === params.actorId) continue
    const contextItem = conversationItemToContextItem(item, params.actorId)
    if (contextItem) {
      items.push(contextItem)
    }
  }

  return { items, maxSequence }
}

async function putSessionToIdle(sessionId: string) {
  const session = await getSession(sessionId)
  if (!session || session.status !== "running") {
    return
  }

  // Tear down the file sandbox on the clean running→idle transition: commit all
  // dirty spaces, stop the daemon, delete live dirs, revoke grants, delete the
  // sandbox runtime. Best-effort — a teardown failure must not block the idle
  // transition.
  if (sandboxEnabled) {
    try {
      await teardownSandbox(sessionId)
    } catch (err) {
      console.error(
        `[session-thinking] sandbox teardown failed for ${sessionId}:`,
        err
      )
    }
  }

  await updateSessionStatus(sessionId, "idle", { errorMessage: null })
  await publishSessionRuntime(session.workspaceId, sessionId, {
    laneState: "idle",
    phase: "idle",
    // A clean idle transition. Clear any cached statusText/lastError
    // explicitly so a runtime snapshot from an earlier failure cannot
    // leak through buildSessionRuntimeSnapshot's inherit-from-cache
    // fallback into this terminal snapshot.
    statusText: null,
    lastError: null,
  })

  // session.status.changed event emit removed (S13): no subscribers.
}

function isTurnInterruptedError(error: unknown) {
  return error instanceof Error && error.name === "TurnInterruptedError"
}

/**
 * Thrown when this worker loses the session lock mid-turn (TTL lapsed and
 * another worker took over, or the lock was force-released). We throw rather
 * than return so the normal catch-block cleanup runs (drop attached wakeups,
 * mark the running turn cancelled) — otherwise the session would be left with a
 * dangling `running` turn + attached wakeups until external recovery. We do NOT
 * touch session status or requeue: the new lock owner now drives the session.
 */
class SessionLockLostError extends Error {
  constructor(sessionId: string) {
    super(`session lock for ${sessionId} lost mid-turn`)
    this.name = "SessionLockLostError"
  }
}

function isSessionLockLostError(error: unknown) {
  return error instanceof Error && error.name === "SessionLockLostError"
}

/**
 * Pure decision for how a lock-loss turn recovers its wakeups. Extracted so the
 * (subtle, concurrency-critical) policy is unit-testable without standing up
 * the whole worker:
 *
 *  - replayUnsafe=false → restore the turn's attached wakeups to pending (the
 *    new owner re-drives them; nothing non-idempotent ran).
 *  - replayUnsafe=true  → drop the turn's attached wakeups (re-running would
 *    replay a committed action/message).
 *
 * In BOTH cases, requeue iff wakeups remain pending afterward — these are late,
 * independent wakeups not attached to this turn, so requeuing never replays it.
 */
export type LockLossWakeupAction = "restore" | "drop"

export function decideLockLossRecovery(params: {
  replayUnsafeStarted: boolean
  /** Pending-wakeup count AFTER the restore/drop is applied. */
  pendingAfterRecovery: number
}): { wakeupAction: LockLossWakeupAction; requeue: boolean } {
  return {
    wakeupAction: params.replayUnsafeStarted ? "drop" : "restore",
    requeue: params.pendingAfterRecovery > 0,
  }
}

export function startSessionThinkingWorker() {
  const worker = tracedWorker(
    QUEUE_NAMES.SESSION_THINKING,
    async (job) => {
      const { sessionId, actorId, workspaceId, trigger, userId } = job.data
      const sessionLockKey = `${REDIS_CHANNELS.SESSION_LOCK_PREFIX}${sessionId}`
      const actorSessionsKey = `${REDIS_CHANNELS.ACTOR_SESSIONS_PREFIX}${actorId}`

      const acquired = await acquireLock(
        redis,
        sessionLockKey,
        SESSION_LOCK_TTL
      )
      if (!acquired) {
        // Another worker holds the lock. Normally fine — that worker drives the
        // session. But if there are PENDING wakeups, we must guarantee a future
        // driver: the current owner may have already read 0 pending (and be
        // heading to idle) before these wakeups were enqueued/restored. Without
        // a retry the wakeups would be stranded (these jobs are added with no
        // BullMQ attempts, so returning here = job done, no retry). Re-enqueue a
        // DELAYED job so it re-claims after the current owner releases.
        const pending = await getPendingWakeupCount(sessionId).catch(() => 0)
        if (pending > 0) {
          log.info(
            `Session ${sessionId} locked but ${pending} wakeup(s) pending; ` +
              `re-enqueuing a delayed retry`
          )
          // The re-enqueue IS the only driver for these wakeups, so a failure
          // must NOT be swallowed-and-reported-as-scheduled. Let it throw: this
          // worker's job then fails, which surfaces in monitoring and (with job
          // attempts) gets retried, rather than silently stranding the wakeups.
          //
          // Root it (like the end-of-turn requeue): this job carries the trace
          // of whoever enqueued IT, but the retry re-drives the session for ALL
          // pending wakeups — which in a multi-participant session belong to
          // OTHER users. Inheriting this job's trace would cross-attribute the
          // re-driven turn; a fresh root + per-wakeup LINKS (getPendingWakeups)
          // is correct. Same session ≠ same user.
          await withRootTrace(() =>
            sessionThinkingQueue.add(
              "think",
              { sessionId, actorId, workspaceId, trigger, userId },
              { delay: LOCK_CONTENDED_RETRY_DELAY_MS }
            )
          )
          return {
            success: false,
            reason: "session locked",
            retryScheduled: true,
          }
        }
        log.info(`Session ${sessionId} is already being processed, skipping`)
        return { success: false, reason: "session locked" }
      }
      const sessionLock: AcquiredLock = acquired

      const currentCount = await redis.incr(actorSessionsKey)
      await redis.pexpire(actorSessionsKey, SESSION_LOCK_TTL * 2)

      const maxSessions = await getActorMaxSessions(actorId)
      if (currentCount > maxSessions) {
        await redis.decr(actorSessionsKey)
        await releaseLock(redis, sessionLock)
        throw new Error(
          `Actor ${actorId} concurrent limit (${maxSessions}) reached, will retry`
        )
      }

      let turn: any = null
      let thinkingActorDisplayName = "Unknown"
      let requeueAfterUnlock = false
      let requeueTrigger = trigger
      // Set true by the lock-refresh interval if we lose the session lock
      // mid-turn. Hoisted to handler scope so the catch block can branch on it
      // (the cooperative abort surfaces as a generic TurnInterruptedError, so
      // the error TYPE alone can't tell us the turn was aborted for lock loss).
      let lockLost = false
      // Flips true once this turn performs a NON-idempotent write — i.e. it
      // executed at least one action (create_memory / rename_self /
      // change_avatar / …) OR persisted an assistant message. A pure-reasoning
      // turn (no actions, no message) stays false. On a lock loss we restore+
      // requeue ONLY while this is false; once a non-idempotent write has run, a
      // re-run would replay it, so we drop the turn's wakeups instead.
      let replayUnsafeStarted = false
      // Fenced lock-renew timer. Hoisted to handler scope and cleared in the
      // OUTER finally so renewal covers the WHOLE critical section — not just
      // actorThink, but executeActorActions + message persistence + turn/wakeup
      // status + runtime/audit emits — until the lock is released. Otherwise a
      // long side-effect phase could outlast the TTL and let another worker
      // concurrently take over the session.
      let lockRefreshInterval: ReturnType<typeof setInterval> | undefined
      let currentStatusText: string | undefined
      let currentPhase: ThinkingPhase | "error" = "thinking"
      let threadConversationId: string | undefined
      let pendingWakeups: Awaited<ReturnType<typeof getPendingWakeups>> = []
      let availableSkills: Awaited<
        ReturnType<typeof resolveActorCapabilitySurface>
      >["availableSkills"] = []
      let mcpTools: Awaited<
        ReturnType<typeof resolveActorCapabilitySurface>
      >["mcpTools"] = {
        tools: [],
        executor: async () => ({
          content: [],
          origin: { kind: "system", registryKey: "empty_mcp_tools" },
        }),
        mcpVersion: 0,
        refresh: async () => ({ tools: [], mcpVersion: 0 }),
        setTurnId: () => {},
        shutdown: async () => {},
      }

      try {
        let session = await getSession(sessionId)
        if (!session || session.status === "closed") {
          log.info(
            `Session ${sessionId} is ${session?.status ?? "not found"}, skipping`
          )
          return { success: false, reason: "session closed or missing" }
        }

        const pendingWakeupsAtStart = await getPendingWakeupCount(sessionId)
        if (pendingWakeupsAtStart === 0 && session.status !== "running") {
          if (session.status !== "idle") {
            await updateSessionStatus(sessionId, "idle", { errorMessage: null })
          }
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: "idle",
            health: ACTOR_RUNTIME_HEALTH.OK,
            phase: "idle",
            // Idle early-return: another worker already handled the wakeup,
            // or there's nothing to do. Clear any cached statusText/lastError
            // from a prior blocked snapshot — same defense as putSessionToIdle.
            // Without this the dashboard would keep showing the previous
            // failure even though the session is now demonstrably idle.
            statusText: null,
            lastError: null,
          })
          return { success: true, reason: "no pending wakeups" }
        }

        const previousStatus = session.status
        if (session.status !== "running") {
          const conversationId = isThreadConversationKind(
            session.conversationKind
          )
            ? session.conversationId
            : undefined
          await updateSessionStatus(sessionId, "running", {
            errorMessage: null,
          })
          // session.status.changed event emit removed (S13).
          void previousStatus
          session = await getSession(sessionId)
          if (!session) {
            return {
              success: false,
              reason: "session disappeared after status update",
            }
          }
        }
        const conversationId = isThreadConversationKind(
          session.conversationKind
        )
          ? session.conversationId
          : undefined
        threadConversationId = conversationId

        await emitEvent({
          type: "actor.thinking",
          workspaceId,
          payload: { actorId, sessionId, conversationId },
          timestamp: nowIsoInstant(),
        })

        const emitThinkingStatus = async (status: string) => {
          currentStatusText = status
          currentPhase = deriveThinkingPhase(status)
          const thinkingPayload = {
            conversationId,
            sessionId,
            actorId,
            actorDisplayName:
              thinkingActorDisplayName || session.actorDisplayName || "Unknown",
            status,
            phase: currentPhase,
          }
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: "running",
            health: ACTOR_RUNTIME_HEALTH.OK,
            phase: currentPhase,
            statusText: status,
            activeTurnId: turn?.id,
            // Defense in depth: if the previous run ended in "blocked" and
            // the requeue path that brought us here didn't clear the
            // cached lastError (e.g. a future bypass that doesn't go
            // through enqueueSessionWakeup), the snapshot builder would
            // otherwise inherit it and the dashboard would keep showing
            // the previous failure's message even though the session is
            // now healthily running. This `null` is cheap and stays
            // correct even when there was nothing to clear.
            lastError: null,
          })
          // session.thinking event emit removed (S13).
          void thinkingPayload
        }

        thinkingActorDisplayName = session.actorDisplayName || "Unknown"
        await emitThinkingStatus("Analyzing message...")

        const actor = await getActor(actorId, workspaceId)
        if (!actor) throw new Error(`Actor ${actorId} not found`)

        const sessionMessages = await getSessionMessages(sessionId)
        const interrupts = await consumeInterrupts(sessionId)
        pendingWakeups = await getPendingWakeups(sessionId)
        if (pendingWakeups.length === 0) {
          await putSessionToIdle(sessionId)
          return { success: true, reason: "wakeup already handled" }
        }

        let conversationParticipants: any[] | undefined
        let promptConversationParticipants: any[] | undefined
        const participantEntries: ConversationParticipantEntry[] = []
        let contextManifest: ProviderContextManifest | undefined
        let actorParticipantId: string | undefined
        let lastKnownConversationSequence = 0
        let contextItems: CanonicalContextItem[]
        if (conversationId) {
          conversationParticipants =
            await listConversationParticipants(conversationId)
          promptConversationParticipants = await listConversationParticipants(
            conversationId,
            {
              useProfileSnapshot: true,
            }
          )
          actorParticipantId = conversationParticipants.find(
            (member: any) =>
              member.actorId === actorId && member.state === "active"
          )?.id
          if (!actorParticipantId) {
            throw new Error(
              `Actor ${actorId} is not an active participant of conversation ${conversationId}`
            )
          }
          const selfParticipant = conversationParticipants.find(
            (member: any) =>
              member.actorId === actorId && member.state === "active"
          )
          if (selfParticipant) {
            participantEntries.push({
              participantType: "actor",
              id: actorId,
              participantId: selfParticipant.id,
              name:
                selfParticipant.participantName ||
                selfParticipant.displayName ||
                actor.displayName ||
                session.actorDisplayName ||
                "Unknown actor",
              title:
                selfParticipant.participantTitle ||
                selfParticipant.participantRole ||
                "Actor",
              role: selfParticipant.participantRole || undefined,
            })
          }

          for (const member of conversationParticipants) {
            if (
              member.actorId &&
              member.actorId !== actorId &&
              member.state === "active"
            ) {
              participantEntries.push({
                participantType: "actor",
                id: member.actorId,
                participantId: member.id,
                name:
                  member.participantName ||
                  member.displayName ||
                  "Unknown actor",
                title: member.participantTitle,
                role: member.participantRole || undefined,
              })
            } else if (member.userId && member.state === "active") {
              const workspaceMemberId =
                typeof member.workspaceMemberId === "string" &&
                member.workspaceMemberId.trim().length > 0
                  ? member.workspaceMemberId
                  : null
              if (!workspaceMemberId) {
                throw new Error(
                  `Conversation ${conversationId} has workspace participant ${member.id} without workspace_member_id`
                )
              }
              participantEntries.push({
                participantType: "workspace_member",
                id: workspaceMemberId,
                participantId: member.id,
                name: member.userName || "User",
                role: "Workspace member",
              })
            } else if (
              member.participantType ===
                CONVERSATION_PARTICIPANT_TYPE.EXTERNAL &&
              member.state === "active"
            ) {
              const linkedUserName = member.linkedUserName || undefined
              participantEntries.push({
                participantType: "external",
                id:
                  member.linkedUserId ||
                  member.transportExternalId ||
                  member.id,
                participantId: member.id,
                name:
                  member.transportDisplayName ||
                  member.displayName ||
                  linkedUserName ||
                  "External participant",
                title: linkedUserName
                  ? `Linked workspace user: ${linkedUserName}`
                  : "External participant",
                role: "External participant",
                linkedWorkspaceMemberId: member.linkedUserId || undefined,
                linkedWorkspaceMemberName: linkedUserName,
                externalUserKey: member.transportExternalId || undefined,
              })
            }
          }
          contextManifest = {
            conversationId,
            conversationKind: session.conversationKind,
            isImConversation: session.isImConversation,
            selfParticipantId: actorParticipantId,
            selfActorId: actorId,
            participants: participantEntries,
          }

          const visibleItems = await getContextConversationItemsForParticipant({
            conversationId,
            participantId: actorParticipantId,
            limit: 200,
          })
          // Phase 10: pre-load the canonical tool result map from the
          // execution tables so context-builder uses them as source of
          // truth rather than reconstructing from session_message.metadata.
          const executionToolResults =
            await loadExecutionToolResultsForSession(sessionId)
          const built = buildConversationContextItems({
            visibleItems,
            actorId,
            sessionMessages,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
            executionToolResults,
          })
          contextItems = built.items
          lastKnownConversationSequence = built.lastSequence
        } else {
          const executionToolResults =
            await loadExecutionToolResultsForSession(sessionId)
          contextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: false,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
            executionToolResults,
          })
        }

        const recallType = session.memoryBootstrapCompleted
          ? "turn_recall"
          : "bootstrap"
        const recallQuery = buildMemoryRecallQuery({
          actorDisplayName: actor.displayName || actor.definition.displayName,
          conversationTitle: session.conversationTitle,
          contextItems,
        })
        const recallResult = await recallMemories(workspaceId, {
          actorId,
          conversationId: session.conversationId,
          recallType,
          queryText: recallQuery,
          queryBlocks: recallQuery ? textBlocks(recallQuery) : [],
          limit: 6,
          metadata: {
            sessionId,
            trigger,
          },
        })
        const recalledMemories = recallResult.memories
        if (recalledMemories.length > 0) {
          contextItems = [
            {
              kind: "memory_recall",
              scope: "private",
              surface: "internal",
              recallType,
              memories: recalledMemories,
              metadata: {
                recallRunId: recallResult.run.id,
              },
            },
            ...contextItems,
          ]
        }
        if (recallType === "bootstrap" && !session.memoryBootstrapCompleted) {
          await markSessionMemoryBootstrapCompleted(sessionId)
        }

        const resolvedModelPlan = await resolveModelPlan(actorId, workspaceId, {
          conversationId: session.conversationId,
        })
        const primaryModel = resolvedModelPlan?.candidates[0] || null

        // File sandbox lifecycle (opt-in via SANDBOX_PROVIDER!=none). Runs
        // BEFORE the context window is built so (a) the agent's file view
        // reflects other writers' new commits this turn, and (b) any merge
        // conflict is injected as a system notice the agent actually sees.
        let sandboxConflictNotice: CanonicalContextItem | null = null
        // Pending commit conflicts are cleared only AFTER actorThink succeeds
        // (at-least-once delivery — see below), so remember whether we surfaced
        // any this turn.
        let surfacedPendingCommitConflicts = false
        // Subpaths whose turn-start refresh FAILED (helper threw) — their live
        // dir is partially synced + base unadvanced. Skip committing them at
        // turn-end so a half-synced tree isn't snapshotted; next turn re-runs the
        // refresh from the same base and self-heals (round-8 follow-up).
        let refreshFailedSubpaths = new Set<string>()
        // Whether we surfaced persisted refresh conflicts this turn (cleared only
        // after actorThink returns — at-least-once delivery, round-10 #1).
        let surfacedPendingRefreshConflicts = false
        // R12-3 / P3: whether a pending sidecar failed restore in a way that is
        // still RETRYABLE (transient). Only a transient failure should block
        // clearing the pending store after actorThink — a transient sidecar's
        // copy may re-materialize on a later provision, so keep the notice alive.
        // A PERMANENT failure (corrupt/missing payload) will NEVER restore, so
        // its notice is delivered once (the unrecoverable wording) and then the
        // store is cleared — otherwise the agent would re-receive the same dead
        // notice every turn forever (the blob is unprotectable regardless).
        let hasTransientSidecarFailure = false
        // P2 fail-closed: provision reported restore NOT-ok but produced an EMPTY
        // failed-sidecar list (the failure-collection in provisionSandbox itself
        // threw). We then cannot trust that any sidecar made it to disk, so every
        // pending sidecar must be treated as (transiently) unrestored — none gets
        // a "read it" and the pending store is NOT cleared. Distinct from the
        // normal case where an empty failed list means "all restored".
        let restoreStatusUnknown = false
        // P2/P3: agent-visible sidecar path → WHY it failed restore this
        // provision ("transient" = retry later; "permanent" = unrecoverable).
        // The notice uses this to avoid "read it" for missing paths and to word
        // transient vs permanent failures differently. Absent from the map =
        // restored (readable).
        let failedSidecarReasons = new Map<
          string,
          SidecarRestoreFailureReason
        >()
        if (sandboxEnabled) {
          try {
            const provision = await provisionSandbox(sessionId)
            failedSidecarReasons = new Map(
              provision.failedSidecars.map((f) => [f.sidecar, f.reason])
            )
            // P2 fail-closed: ok=false with no per-sidecar detail → unknown.
            restoreStatusUnknown =
              !provision.sidecarRestoreOk &&
              provision.failedSidecars.length === 0
            // Block clearing the pending store when ANY sidecar may still need a
            // retry: a transient per-sidecar failure, OR the unknown state above
            // (we can't prove any sidecar was delivered). Permanent failures do
            // NOT block (delivered once then cleared).
            hasTransientSidecarFailure =
              restoreStatusUnknown ||
              provision.failedSidecars.some((f) => f.reason === "transient")
            const refresh = await refreshSpaces(sessionId)
            // Record any spaces whose refresh FAILED so turn-end commit skips
            // them (their live tree is half-synced; committing it could entangle
            // this turn's edits with partially-applied head bytes). Next turn
            // re-runs the refresh from the same base and self-heals.
            refreshFailedSubpaths = new Set(
              Object.keys(refresh.syncFailuresBySubpath)
            )
            // Commit conflicts recorded by a PREVIOUS turn's turn-end commit
            // (which ran after the actor already replied). READ but do NOT clear
            // yet — clearing happens post-actorThink so a crash before the model
            // sees the notice doesn't drop it.
            const pendingCommitConflicts =
              await peekPendingCommitConflicts(sessionId)
            // Refresh conflicts persisted across turns for at-least-once delivery
            // (round-10 #1). refreshSpaces already stashed THIS turn's conflicts;
            // peek returns them merged with any still-undelivered from a prior
            // interrupted turn. UNION with this turn's in-memory result too, so a
            // swallowed persist failure (base may already have advanced for synced
            // subpaths) can't drop this turn's conflict from the notice. Cleared
            // only after actorThink returns.
            const persistedRefresh =
              await peekPendingRefreshConflicts(sessionId)
            const displayRefresh = mergePendingRefreshConflicts(
              persistedRefresh,
              {
                deferredConflictsBySubpath: refresh.deferredConflictsBySubpath,
                sidecarsBySubpath: refresh.sidecarsBySubpath,
              }
            )

            const refreshEntries = Object.entries(
              displayRefresh.deferredConflictsBySubpath
            )
            // Subpaths that did NOT fully sync THIS turn — for them we must not
            // promise "head LIVES at the path" (round-10 #4: the live path may be
            // only half-synced). Their conflicts/sidecars are still surfaced, but
            // under a "view may be half-synced" caveat below.
            const syncFailureEntries = Object.entries(
              refresh.syncFailuresBySubpath
            )
            const failedSet = new Set(syncFailureEntries.map(([sp]) => sp))
            const commitEntries = Object.entries(pendingCommitConflicts)
            // Head-wins refresh lines cover ONLY subpaths that fully synced (head
            // genuinely LIVES at the path). Incomplete subpaths get the
            // half-synced caveat instead (round-10 #4).
            const syncedRefreshEntries = refreshEntries.filter(
              ([sp]) => !failedSet.has(sp)
            )
            const incompleteRefreshEntries = refreshEntries.filter(([sp]) =>
              failedSet.has(sp)
            )
            const refreshLines = syncedRefreshEntries.map(
              ([sp, paths]) =>
                `/${sp}: ${paths.map((p) => `/${sp}${p}`).join(", ")}`
            )
            const commitLines = commitEntries.map(
              ([sp, c]) =>
                `/${sp}: ${c.paths.map((p) => `/${sp}${p}`).join(", ")}`
            )
            // Sidecars to surface = the merged refresh sidecars (persisted ∪ this
            // turn, round-10 #1). `kind` distinguishes a readable-bytes file
            // sidecar from a readable-JSON symlink sidecar (round-10 #3). These
            // are ALWAYS listed when present — independent of whether their
            // subpath fully synced — so an incomplete subpath's preserved copy is
            // never orphaned before the persisted store is cleared (round-10
            // follow-up: the sidecar listing must not hide behind the head-wins
            // line).
            const refreshSidecars = Object.values(
              displayRefresh.sidecarsBySubpath
            ).flat()
            // P2/P3: split restored (leaf exists, "read it") from unrestored,
            // and unrestored further into transient (retry later) vs permanent
            // (unrecoverable). Failed sidecars never get a "read it".
            const {
              restored: restoredRefreshSidecars,
              transient: transientRefreshSidecars,
              permanent: permanentRefreshSidecars,
            } = partitionSidecars(
              refreshSidecars,
              failedSidecarReasons,
              restoreStatusUnknown
            )
            const sidecarPairs = restoredRefreshSidecars.map(formatRestoredPair)
            // Per-path coverage (round-7 #D), restricted to fully-synced subpaths:
            // a deferred conflict path is "covered" iff some sidecar's original IS
            // that path or sits under it.
            const sidecarOriginals = refreshSidecars.map((s) => s.original)
            const hasUncoveredRefreshConflict = syncedRefreshEntries.some(
              ([sp, paths]) =>
                paths.some((p) => {
                  const abs = `/${sp}${p}`
                  return !sidecarOriginals.some(
                    (o) => o === abs || o.startsWith(`${abs}/`)
                  )
                })
            )
            // We surfaced (and may clear) persisted refresh conflicts iff there
            // were any deferred paths OR any sidecars to show.
            surfacedPendingRefreshConflicts =
              refreshEntries.length > 0 || refreshSidecars.length > 0

            if (
              refreshLines.length > 0 ||
              commitLines.length > 0 ||
              syncFailureEntries.length > 0 ||
              surfacedPendingRefreshConflicts
            ) {
              if (refreshLines.length > 0) {
                console.warn(
                  `[session-thinking] sandbox refresh conflicts for ${sessionId}: ${refreshLines.join("; ")}`
                )
              }
              if (commitLines.length > 0) {
                console.warn(
                  `[session-thinking] sandbox prior-turn commit conflicts for ${sessionId}: ${commitLines.join("; ")}`
                )
              }
              if (syncFailureEntries.length > 0) {
                console.warn(
                  `[session-thinking] sandbox refresh sync failures for ${sessionId}: ${syncFailureEntries
                    .map(([sp, msg]) => `/${sp}: ${msg}`)
                    .join("; ")}`
                )
              }
              const sections: string[] = []
              if (refreshLines.length > 0) {
                const noSidecarNote = hasUncoveredRefreshConflict
                  ? " Some conflict paths have NO sidecar — for any conflict path without a listed sidecar (below), re-read the live path: it now holds the other writer's version."
                  : ""
                sections.push(
                  `Another writer's change to these paths was applied and now LIVES at the path (head wins): ${refreshLines.join("; ")}.${noSidecarNote}`
                )
              }
              // The preserved-copy listing is its OWN sentence, emitted whenever
              // ANY refresh sidecar exists — even if every conflicting subpath was
              // incomplete this turn (so refreshLines is empty). This guarantees a
              // preserved copy is named before the persisted store is cleared
              // post-actorThink (round-10 follow-up: no orphaned sidecar).
              if (sidecarPairs.length > 0) {
                sections.push(
                  `Your pre-conflict copy of each preserved FILE/SYMLINK was saved to a sidecar (read it — file sidecars hold the bytes verbatim, symlink sidecars hold JSON {"kind":"symlink","target":...} — reconcile with the live/head version, then write the merged result back to the original path): ${sidecarPairs.join("; ")}.`
                )
              }
              // P2/P3: sidecars that FAILED to re-materialize are listed WITHOUT
              // a "read it" — transient ones promise a later-turn restore,
              // permanent ones (corrupt/missing payload) are flagged as
              // unrecoverable so the agent redoes the work instead of waiting.
              const transientRefreshSentence = transientUnrestoredSentence(
                transientRefreshSidecars
              )
              if (transientRefreshSentence) {
                sections.push(transientRefreshSentence)
              }
              const permanentRefreshSentence = permanentUnrestoredSentence(
                permanentRefreshSidecars
              )
              if (permanentRefreshSentence) {
                sections.push(permanentRefreshSentence)
              }
              if (commitEntries.length > 0) {
                // round-7 #C: the post-commit reconcile preserved the agent's
                // pre-conflict copy at a sidecar — point at it instead of
                // claiming the work was simply lost. P2/P3: split restored ("read
                // it") from transient (retry later) and permanent (unrecoverable).
                const commitSidecars = commitEntries.flatMap(
                  ([, c]) => c.sidecars
                )
                const {
                  restored: restoredCommitSidecars,
                  transient: transientCommitSidecars,
                  permanent: permanentCommitSidecars,
                } = partitionSidecars(
                  commitSidecars,
                  failedSidecarReasons,
                  restoreStatusUnknown
                )
                const commitSidecarPairs =
                  restoredCommitSidecars.map(formatRestoredPair)
                const commitSidecarNote =
                  commitSidecarPairs.length > 0
                    ? ` Your pre-conflict copy of each preserved FILE/SYMLINK was saved to a sidecar — read it (symlink sidecars hold JSON metadata), reconcile with the current saved version, and save the merged result back to the original path: ${commitSidecarPairs.join("; ")}.`
                    : ""
                const transientCommitSentence = transientUnrestoredSentence(
                  transientCommitSidecars
                )
                const permanentCommitSentence = permanentUnrestoredSentence(
                  permanentCommitSidecars
                )
                const unrestoredCommitNote = [
                  transientCommitSentence,
                  permanentCommitSentence,
                ]
                  .filter(Boolean)
                  .map((s) => ` ${s}`)
                  .join("")
                sections.push(
                  `Your previous turn's save to these paths LOST to a concurrent writer (${commitLines.join("; ")}); the current saved version is the other writer's.${commitSidecarNote}${unrestoredCommitNote} Re-read each path and re-apply your change if it's still needed.`
                )
                surfacedPendingCommitConflicts = true
              }
              if (syncFailureEntries.length > 0) {
                // round-8 follow-up + round-10 #4: a space failed to FULLY merge
                // in the latest head this turn. Its view may be HALF-SYNCED — head
                // is NOT guaranteed to be at the path — and it will NOT be
                // committed at turn-end (avoids snapshotting a half-synced tree);
                // the platform retries the merge next turn. Any conflict paths +
                // sidecars already preserved for it ARE listed above and remain
                // valid; surface those paths here too so the agent re-reads them.
                const incompleteLines = incompleteRefreshEntries.map(
                  ([sp, paths]) =>
                    `/${sp}: ${paths.map((p) => `/${sp}${p}`).join(", ")}`
                )
                const incompletePathsNote =
                  incompleteLines.length > 0
                    ? ` Conflicting paths there (re-read carefully; your preserved copies are in the sidecar list above): ${incompleteLines.join("; ")}.`
                    : ""
                sections.push(
                  `These spaces could NOT be fully refreshed to the latest version this turn and may show a HALF-SYNCED view — do NOT assume the other writer's version is at the path there; re-read carefully and avoid large edits until they recover: ${syncFailureEntries
                    .map(([sp]) => `/${sp}`)
                    .join(", ")}.${incompletePathsNote}`
                )
              }
              sandboxConflictNotice = {
                kind: "system_notice",
                noticeType: "generic",
                scope: "private",
                surface: "internal",
                parts: textBlocks(`File merge conflict. ${sections.join(" ")}`),
                metadata: {
                  refreshConflicts: displayRefresh.deferredConflictsBySubpath,
                  priorCommitConflicts: pendingCommitConflicts,
                  refreshSyncFailures: refresh.syncFailuresBySubpath,
                },
              }
            }
          } catch (sandboxErr) {
            console.error(
              `[session-thinking] sandbox provision/refresh failed for ${sessionId}:`,
              sandboxErr
            )
            // P1.5: a REQUESTED sandbox (SANDBOX_PROVIDER!=none) failed to
            // provision. Owner policy = run the turn UNSANDBOXED but surface a
            // VISIBLE degraded-turn notice (vs the previous total silence) so the
            // actor + operator know isolation is off. sandboxEnabled gates it so
            // provider=none never emits it. Reuses the prepended notice channel;
            // provision throwing means the conflict-notice path above did not run.
            if (sandboxEnabled) {
              sandboxConflictNotice = {
                kind: "system_notice",
                noticeType: "generic",
                scope: "private",
                surface: "internal",
                parts: textBlocks(
                  "Sandbox unavailable — this turn is running WITHOUT filesystem/command isolation. Provisioning failed; retry once the sandbox backend is healthy."
                ),
                metadata: { sandboxDegraded: true },
              }
            }
          }
        }

        let finalContextItems = sandboxConflictNotice
          ? [sandboxConflictNotice, ...contextItems]
          : contextItems
        if (primaryModel?.crossTurnToolHistory && !conversationId) {
          const executionToolResults =
            await loadExecutionToolResultsForSession(sessionId)
          finalContextItems = buildSessionContextItems(sessionMessages, {
            crossTurnToolHistory: true,
            interrupts: interrupts.length > 0 ? interrupts : undefined,
            wakeups: pendingWakeups,
            executionToolResults,
          })
          if (recalledMemories.length > 0) {
            finalContextItems = [
              {
                kind: "memory_recall",
                scope: "private",
                surface: "internal",
                recallType,
                memories: recalledMemories,
                metadata: {
                  recallRunId: recallResult.run.id,
                },
              },
              ...finalContextItems,
            ]
          }
          // Preserve the sandbox conflict notice (the rebuild above replaced
          // finalContextItems wholesale).
          if (sandboxConflictNotice) {
            finalContextItems = [sandboxConflictNotice, ...finalContextItems]
          }
        }

        const contextWindow = await buildProviderContextWindow({
          conversationId: session.conversationId,
          sessionId,
          items: finalContextItems,
          manifest: contextManifest,
        })

        const capabilitySurface = await resolveActorCapabilitySurface({
          workspaceId,
          actorId,
          sessionId,
          conversationId: session.conversationId,
          conversationKind: session.conversationKind,
          isImConversation: session.isImConversation,
          userId,
        })
        availableSkills = capabilitySurface.availableSkills
        mcpTools = capabilitySurface.mcpTools
        if (mcpTools.tools.length > 0) {
          log.info(
            `Resolved ${mcpTools.tools.length} MCP tools for actor ${actorId}`
          )
        }

        const actorPromptSource = (() => {
          if (!promptConversationParticipants) return actor
          const selfMember = promptConversationParticipants.find(
            (member: any) =>
              member.actorId === actorId && member.state === "active"
          )
          if (!selfMember) return actor
          return {
            ...actor,
            currentVersion:
              selfMember.actorCurrentVersion || actor.currentVersion,
            displayName:
              selfMember.participantName ||
              selfMember.displayName ||
              actor.displayName,
            definition: {
              ...actor.definition,
              displayName:
                selfMember.participantName ||
                selfMember.displayName ||
                actor.displayName ||
                actor.definition.displayName,
              title: selfMember.participantTitle || actor.definition.title,
              role: selfMember.participantRole || actor.definition.role,
              docs: selfMember.actorDocs || actor.definition.docs,
              canRepresentUser:
                typeof selfMember.actorCanRepresentUser === "boolean"
                  ? selfMember.actorCanRepresentUser
                  : actor.definition.canRepresentUser,
              specialties: Array.isArray(selfMember.actorSpecialties)
                ? selfMember.actorSpecialties
                : actor.definition.specialties,
              config:
                selfMember.actorConfig &&
                typeof selfMember.actorConfig === "object"
                  ? selfMember.actorConfig
                  : actor.definition.config,
            },
          }
        })()

        const buildSystemPrompt = (currentSession: any) => {
          const planMode = isPlanCollaborationMode(
            currentSession.collaborationMode || "default"
          )
          const promptMcpTools =
            !planMode && mcpTools.tools.length > 0 ? mcpTools.tools : undefined
          return buildActorPrompt(
            actorPromptSource,
            undefined,
            undefined,
            promptMcpTools,
            promptConversationParticipants || conversationParticipants,
            currentSession.conversationKind,
            availableSkills,
            currentSession.collaborationMode || "default"
          ).system
        }

        const system = buildSystemPrompt(session)

        turn = await createTurn({
          sessionId,
          conversationId: session.conversationId,
          actorId,
          triggerType: pendingWakeups[0]!.sourceType,
          triggerItemId: pendingWakeups[0]!.sourceItemId,
          metadata: {
            triggerUserId: userId || null,
            wakeupIds: pendingWakeups.map((wakeup) => wakeup.wakeupId),
            wakeupCount: pendingWakeups.length,
          },
        })
        await attachPendingWakeupsToTurn(sessionId, turn.id)
        await publishSessionRuntime(workspaceId, sessionId, {
          laneState: "running",
          health: ACTOR_RUNTIME_HEALTH.OK,
          phase: currentPhase,
          statusText: currentStatusText,
          activeTurnId: turn.id,
        })

        lockRefreshInterval = setInterval(
          async () => {
            try {
              // Fenced refresh: only extend the TTL while we still hold the
              // lock token. A bare PEXPIRE could resurrect a lock another
              // worker has since taken over.
              const stillHeld = await renewLock(
                redis,
                sessionLock,
                SESSION_LOCK_TTL
              )
              if (!stillHeld) {
                // We lost the lock (TTL lapsed and another worker took over, or
                // it was force-released). Stop this turn cooperatively so we
                // don't double-execute actions / send messages / emit events as
                // a second worker runs the same session.
                lockLost = true
                log.warn(`lost session lock for ${sessionId}; aborting turn`)
              }
            } catch {
              // Treat a renew error as a lost lock too — safer to bail than to
              // keep acting while unsure we still hold it.
              lockLost = true
            }
          },
          Math.floor(SESSION_LOCK_TTL / 2)
        )

        let result

        await emitThinkingStatus("Calling AI model...")

        try {
          result = await actorThink(
            actor,
            contextWindow,
            undefined,
            resolvedModelPlan,
            workspaceId,
            {
              sessionId,
              turnId: turn.id,
              collaborationMode: session.collaborationMode || "default",
              conversationId: session.conversationId,
              conversationKind: session.conversationKind,
              isImConversation: session.isImConversation,
              conversationParticipants: participantEntries,
              userId,
              availableSkills,
              onStatus: emitThinkingStatus,
              mcpTools: mcpTools.tools.length > 0 ? mcpTools.tools : undefined,
              mcpExecutor: mcpTools.executor,
              mcpVersion: mcpTools.mcpVersion,
              mcpRefresh: mcpTools.refresh,
              mcpSetTurnId: mcpTools.setTurnId,
              shouldAbortTurn: async () =>
                lockLost ||
                (await hasPendingInterrupt(
                  sessionId,
                  "remote_control_terminated"
                )),
              system,
              refreshCollaborationContext: async () => {
                const refreshedSession = await getSession(sessionId)
                if (refreshedSession) {
                  session = refreshedSession
                }
                return {
                  collaborationMode: session?.collaborationMode || "default",
                  system: session ? buildSystemPrompt(session) : system,
                }
              },
              checkNewMessages:
                conversationId && actorParticipantId
                  ? async () => {
                      const update = await loadNewContextItems({
                        conversationId,
                        participantId: actorParticipantId!,
                        actorId,
                        sinceSequence: lastKnownConversationSequence,
                      })
                      lastKnownConversationSequence = update.maxSequence
                      if (update.items.length > 0) {
                        await attachPendingWakeupsToTurn(sessionId, turn.id)
                        await publishSessionRuntime(workspaceId, sessionId, {
                          laneState: "running",
                          health: ACTOR_RUNTIME_HEALTH.OK,
                          phase:
                            currentPhase === "error"
                              ? "thinking"
                              : currentPhase,
                          statusText: currentStatusText,
                          activeTurnId: turn.id,
                        })
                      }
                      return update.items.length > 0 ? update.items : null
                    }
                  : undefined,
            }
          )

          // actorThink returned: the model has now consumed the conflict notice
          // that was injected into its context window. Clear the persisted
          // pending commit conflicts ONLY now (at-least-once delivery — if the
          // job had crashed before here, the next turn would re-surface them).
          //
          // R12-3 / P3: do NOT clear if a sidecar failed restore TRANSIENTLY
          // this provision — the agent couldn't read the preserved copy and it
          // may re-materialize next provision, so keep the record retryable. A
          // PERMANENT failure does NOT block clearing: it can never restore, so
          // we deliver the (unrecoverable) notice once and then clear, instead of
          // re-surfacing a dead notice every turn forever.
          if (
            sandboxEnabled &&
            !hasTransientSidecarFailure &&
            surfacedPendingCommitConflicts
          ) {
            await clearPendingCommitConflicts(sessionId).catch((err) =>
              log.error(
                { err },
                `[session-thinking] failed to clear pending commit conflicts for ${sessionId}`
              )
            )
          }
          // Same at-least-once contract for refresh conflicts (round-10 #1):
          // clear the persisted refresh notice ONLY after the model consumed it
          // AND no sidecar failed TRANSIENTLY (R12-3 / P3).
          if (
            sandboxEnabled &&
            !hasTransientSidecarFailure &&
            surfacedPendingRefreshConflicts
          ) {
            await clearPendingRefreshConflicts(sessionId).catch((err) =>
              log.error(
                { err },
                `[session-thinking] failed to clear pending refresh conflicts for ${sessionId}`
              )
            )
          }
        } finally {
          // Turn-end: commit the multi-writer spaces (/conversation, /actor) so
          // the next turn — and other actors — see this turn's file writes.
          // (/actor-conversation is single-writer; committed at teardown.)
          // Best-effort: a commit failure must not abort action execution.
          // NOTE: the lock-renew interval is intentionally NOT cleared here — it
          // is cleared in the OUTER finally so the fenced renew covers the whole
          // critical section (model + all side-effects), not just actorThink.
          if (sandboxEnabled) {
            try {
              // Skip spaces whose turn-start refresh FAILED: their live tree is
              // half-synced (base unadvanced), so committing now could entangle
              // this turn's edits with partially-applied head bytes. They
              // self-heal on the next turn's refresh (round-8 follow-up).
              const commitSubpaths = (
                ["conversation", "actor"] as const
              ).filter((sp) => !refreshFailedSubpaths.has(sp))
              if (commitSubpaths.length === 0) {
                log.warn(
                  `[session-thinking] skipping turn-end commit for ${sessionId}: all multi-writer spaces failed to refresh this turn`
                )
              }
              const commit =
                commitSubpaths.length > 0
                  ? await commitSpaces(sessionId, [...commitSubpaths])
                  : {
                      snapshotIdBySubpath: {},
                      conflictsBySubpath: {},
                      sidecarsBySubpath: {},
                    }
              // Surface per-file commit conflicts (a path this session changed
              // that another writer committed first — head kept, local dropped)
              // so they aren't silently swallowed.
              const commitConflicts = Object.entries(commit.conflictsBySubpath)
              if (commitConflicts.length > 0) {
                log.warn(
                  `[session-thinking] sandbox commit conflicts for ${sessionId}: ${commitConflicts
                    .map(([sp, paths]) => `${sp}: ${paths.join(", ")}`)
                    .join("; ")}`
                )
              }
            } catch (err) {
              log.error(
                { err },
                `[session-thinking] sandbox commit failed for ${sessionId}`
              )
            }
          }
        }

        // Bail before EACH side-effect / terminal write if we've lost the lock
        // (the renew interval sets lockLost). Throwing routes through the catch
        // cleanup; checking at every boundary shrinks the window in which the
        // old worker and the new owner could both write.
        const assertStillHoldLock = () => {
          if (lockLost) throw new SessionLockLostError(sessionId)
        }

        assertStillHoldLock()

        // Mark the turn "replay-unsafe" ONLY when it actually performs a
        // non-idempotent write. A pure-reasoning turn with no actions runs
        // executeActorActions as a no-op (and persists no message), so it stays
        // replay-SAFE — losing the lock there must still restore+requeue its
        // wakeups rather than drop them.
        if (result.actions.length > 0) {
          replayUnsafeStarted = true
        }
        await executeActorActions(workspaceId, actorId, result.actions, {
          sessionId,
          turnId: turn.id,
          userId,
          conversationId: session.conversationId,
        })

        assertStillHoldLock()

        const msgMetadata: Record<string, unknown> = {}
        if (result.toolsUsed && result.toolsUsed.length > 0)
          msgMetadata.toolsUsed = result.toolsUsed
        if (result.serverToolCalls && result.serverToolCalls.length > 0)
          msgMetadata.serverToolCalls = result.serverToolCalls
        if (
          result.citationSources &&
          Object.keys(result.citationSources).length > 0
        )
          msgMetadata.citationSources = result.citationSources
        if (result.toolHistory) msgMetadata.toolHistory = result.toolHistory
        const hasMeta =
          Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined
        const messagePersistence = getAssistantSessionMessagePersistence(result)
        // Persisting an assistant message is also a non-idempotent write.
        if (messagePersistence.kind !== "none") {
          replayUnsafeStarted = true
        }

        assertStillHoldLock()

        if (messagePersistence.kind === "respond") {
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: "running",
            health: ACTOR_RUNTIME_HEALTH.OK,
            phase: "responding",
            statusText: "Responding...",
            activeTurnId: turn.id,
          })
          for (const action of messagePersistence.actions) {
            await addSessionMessage({
              sessionId,
              workspaceId,
              role: "assistant",
              contentBlocks:
                action.contentBlocks && action.contentBlocks.length > 0
                  ? action.contentBlocks
                  : textBlocks(action.content),
              fromActorId: actorId,
              metadata: hasMeta,
            })
          }
        } else if (messagePersistence.kind === "silent_actions") {
          const actionNames = messagePersistence.actionNames.join(", ")
          await addSessionMessage({
            sessionId,
            workspaceId,
            role: "assistant",
            contentBlocks: textBlocks(`[executed: ${actionNames}]`),
            fromActorId: actorId,
            metadata: { ...hasMeta, silentActions: true },
          })
        }
        assertStillHoldLock()
        await markTurnWakeupsProcessed(turn.id)
        await updateTurnStatus(turn.id, "completed")

        await emitEvent({
          type: "actor.action",
          workspaceId,
          payload: {
            actorId,
            sessionId,
            conversationId,
            actions: result.actions,
            turnId: turn.id,
          },
          timestamp: nowIsoInstant(),
        })

        turn = null
        assertStillHoldLock()
        const remainingPendingWakeups = await getPendingWakeupCount(sessionId)
        if (remainingPendingWakeups > 0) {
          requeueAfterUnlock = true
          await updateSessionStatus(sessionId, "queued", { errorMessage: null })
          await publishSessionRuntime(workspaceId, sessionId, {
            laneState: "queued",
            health: ACTOR_RUNTIME_HEALTH.OK,
            phase: "idle",
            statusText: "Queued follow-up messages",
          })
          // session.status.changed event emit removed (S13).
        } else {
          await putSessionToIdle(sessionId)
        }

        await mcpTools.shutdown().catch(() => {})
        return {
          success: true,
          actions: result.actions.length,
          requeued: requeueAfterUnlock,
        }
      } catch (err: any) {
        const errorMessage = err?.message || "Unknown error"
        // Branch on the hoisted lockLost flag, NOT the error type: the
        // cooperative abort surfaces as a generic TurnInterruptedError, so the
        // type alone would misroute a lock-loss into the normal interrupt path
        // (which mutates session status / requeues as if WE still own it).
        const lockLostError = lockLost || isSessionLockLostError(err)
        const turnInterrupted = !lockLostError && isTurnInterruptedError(err)
        if (!turnInterrupted && !lockLostError) {
          log.error({ err }, `Session ${sessionId} failed: ${errorMessage}`)
        } else if (lockLostError) {
          log.warn(`Session ${sessionId} turn aborted: lock lost mid-turn`)
        }
        const failedSession = await getSession(sessionId).catch(() => null)

        // A lost lock or an interrupt cancels (not fails) the turn.
        const cancelled = turnInterrupted || lockLostError

        // Lock lost: another worker now owns this session. How we recover
        // depends on whether we had begun applying side-effects:
        //
        //  - replay-SAFE (no non-idempotent write yet): RESTORE this turn's
        //    attached wakeups to `pending` (dropping them would silently lose
        //    user-triggered wakeups — the new owner only reads `pending`).
        //
        //  - replay-UNSAFE (already ran an action / persisted a message):
        //    Restoring+requeuing the turn's OWN wakeups would REPLAY those
        //    non-idempotent writes under the new owner. So we DROP this turn's
        //    attached wakeups — the work it already did stands.
        //
        // In BOTH cases we then check for PENDING wakeups (these are LATE,
        // independent wakeups that arrived during the turn and were never
        // attached to it — enqueueSessionWakeup skips enqueuing a job while the
        // session is running, relying on the owner to re-check at the end). If
        // any remain pending we requeue so they get a driver. This never
        // replays the current turn: in the unsafe case its own wakeups were
        // dropped (not pending), so only the genuinely-unprocessed ones drive a
        // re-run.
        //
        // Either way: mark the turn cancelled, do NOT write a terminal session
        // status (the new owner drives that).
        if (lockLostError) {
          const wakeupAction: LockLossWakeupAction = replayUnsafeStarted
            ? "drop"
            : "restore"
          if (turn?.id) {
            if (wakeupAction === "drop") {
              log.warn(
                `Session ${sessionId} lost lock AFTER a non-idempotent write; ` +
                  `dropping this turn's wakeups (no replay)`
              )
              await runCleanupStep(
                `drop wakeups for turn ${turn.id} (lock lost, replay-unsafe)`,
                () => markTurnWakeupsDropped(turn.id)
              )
            } else {
              await runCleanupStep(
                `restore wakeups for turn ${turn.id} (lock lost, replay-safe)`,
                () => restoreTurnWakeupsToPending(turn.id)
              )
            }
            await runCleanupStep(`mark turn ${turn.id} cancelled`, () =>
              updateTurnStatus(turn.id, "cancelled", {
                metadata: { errorMessage },
              })
            )
          }
          // Requeue decision (shared, unit-tested policy): requeue iff wakeups
          // remain pending AFTER the restore/drop above. The current turn's
          // wakeups are no longer pending in the unsafe case (dropped), so a
          // re-run cannot replay it; it only drives genuinely-unprocessed input.
          const pendingAfterRecovery = await getPendingWakeupCount(
            sessionId
          ).catch(() => 0)
          const recovery = decideLockLossRecovery({
            replayUnsafeStarted,
            pendingAfterRecovery,
          })
          if (recovery.requeue) {
            requeueAfterUnlock = true
            requeueTrigger = "system_interrupt"
          }
          await runCleanupStep(
            `shutdown MCP tools for session ${sessionId}`,
            () => mcpTools.shutdown()
          )
          return {
            success: false,
            reason: "session lock lost",
            requeued: requeueAfterUnlock,
          }
        }

        if (turn?.id) {
          await runCleanupStep(`drop wakeups for turn ${turn.id}`, () =>
            markTurnWakeupsDropped(turn.id)
          )
          await runCleanupStep(
            `mark turn ${turn.id} ${cancelled ? "cancelled" : "failed"}`,
            () =>
              updateTurnStatus(turn.id, cancelled ? "cancelled" : "failed", {
                metadata: { errorMessage },
              })
          )
        }

        if (turnInterrupted) {
          const remainingPendingWakeups = await getPendingWakeupCount(
            sessionId
          ).catch(() => 0)
          if (remainingPendingWakeups > 0) {
            requeueAfterUnlock = true
            requeueTrigger = "system_interrupt"
            await runCleanupStep(`mark session ${sessionId} queued`, () =>
              updateSessionStatus(sessionId, "queued", { errorMessage: null })
            )
            await runCleanupStep(
              `publish queued runtime for session ${sessionId}`,
              () =>
                publishSessionRuntime(workspaceId, sessionId, {
                  laneState: "queued",
                  health: ACTOR_RUNTIME_HEALTH.OK,
                  phase: "idle",
                  statusText: "Queued follow-up messages",
                })
            )
            // session.status.changed event emit removed (S13).
          } else {
            await runCleanupStep(`put session ${sessionId} idle`, () =>
              putSessionToIdle(sessionId)
            )
          }

          await runCleanupStep(
            `shutdown MCP tools for session ${sessionId}`,
            () => mcpTools.shutdown()
          )
          return {
            success: true,
            reason: "turn interrupted",
            requeued: requeueAfterUnlock,
          }
        }

        await runCleanupStep(`mark session ${sessionId} blocked`, () =>
          updateSessionStatus(sessionId, "blocked", { errorMessage })
        )
        await runCleanupStep(
          `publish blocked runtime for session ${sessionId}`,
          () =>
            publishSessionRuntime(workspaceId, sessionId, {
              laneState: "blocked",
              health: ACTOR_RUNTIME_HEALTH.ERROR,
              phase: "error",
              statusText: errorMessage,
              activeTurnId: turn?.id,
              lastError: {
                message: errorMessage,
                at: nowIsoInstant(),
              },
            })
        )
        // session.status.changed event emit removed (S13).
        await runCleanupStep(
          `shutdown MCP tools for session ${sessionId}`,
          () => mcpTools.shutdown()
        )
        await runCleanupStep(
          `shutdown MCP instances for session ${sessionId}`,
          () => shutdownSessionInstances(sessionId)
        )

        const wakeupTargets = pendingWakeups.filter(
          (wakeup) =>
            (wakeup.sourceParticipantType === "workspace_member" ||
              wakeup.sourceParticipantType === "remote_agent" ||
              wakeup.sourceParticipantType === "external") &&
            wakeup.sourceParticipantId
        )

        if (failedSession?.conversationId && wakeupTargets.length > 0) {
          await runCleanupStep(
            `publish model error notice for session ${sessionId}`,
            async () => {
              const targetParticipants = await Promise.all(
                wakeupTargets.map(async (wakeup) => {
                  if (wakeup.sourceParticipantType === "workspace_member") {
                    return getConversationParticipant({
                      conversationId: failedSession.conversationId,
                      workspaceMemberId: wakeup.sourceParticipantId as string,
                    })
                  }

                  if (wakeup.sourceParticipantType === "remote_agent") {
                    return getConversationParticipant({
                      conversationId: failedSession.conversationId,
                      remoteAgentId: wakeup.sourceParticipantId as string,
                    })
                  }

                  return getConversationParticipant({
                    conversationId: failedSession.conversationId,
                    participantId: wakeup.sourceParticipantId as string,
                  })
                })
              )
              const restrictedAudienceParticipantIds = [
                ...new Set(
                  targetParticipants
                    .map(
                      (participant: any) =>
                        participant?.id as string | undefined
                    )
                    .filter((participantId): participantId is string =>
                      Boolean(participantId)
                    )
                ),
              ]

              if (restrictedAudienceParticipantIds.length === 0) {
                return
              }

              await addSessionMessage({
                sessionId,
                workspaceId,
                role: "assistant",
                subtype: CONVERSATION_MESSAGE_SUBTYPE.MODEL_ERROR_NOTICE,
                visibility: "shared_visible",
                contentBlocks: textBlocks("出错了"),
                fromActorId: actorId,
                restrictedAudienceParticipantIds,
                projectTransportOutbound: true,
                metadata: {
                  excludeFromContext: true,
                  retrySessionId: sessionId,
                  retryTurnId: turn?.id,
                  notificationType: "model_error",
                  errorMessage,
                },
              })
            }
          )
        }

        throw err
      } finally {
        // Stop renewing the lock only now — after ALL side-effects are done —
        // so the fenced renew covered the whole critical section.
        if (lockRefreshInterval) clearInterval(lockRefreshInterval)
        await releaseLock(redis, sessionLock)
        await redis.decr(actorSessionsKey)
        if (requeueAfterUnlock) {
          // This requeue drains wakeups that may belong to OTHER requests/users
          // (a wakeup arriving while this session was 'running' enqueues no job
          // of its own — runtime.ts nudgeSessionAfterWakeup). We are still inside
          // THIS job's CONSUMER span here, so a plain `.add` would stamp this
          // job's trace onto the requeue and cross-attribute the next turn to the
          // wrong user. Root it → fresh trace; the drained wakeups' own traces
          // are re-attached as span LINKS on the next turn (see getPendingWakeups
          // / linkUpstreamTraces), not as the parent.
          await withRootTrace(() =>
            sessionThinkingQueue.add("think", {
              sessionId,
              actorId,
              workspaceId,
              trigger: requeueTrigger,
              userId,
            })
          )
        }
      }
    },
    {
      connection: redis,
      concurrency: 10,
      limiter: { max: 20, duration: 60_000 },
    }
  )

  worker.on("failed", (job, err) => {
    log.error({ err }, `Session thinking job ${job?.id} failed`)
  })

  registerWorker(worker)
  return worker
}
