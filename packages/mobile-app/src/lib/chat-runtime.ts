import { Platform } from "react-native"

import { api } from "@/lib/api"
import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("mobile.chat-runtime")
import {
  applyChatWorkspaceQueueState,
  buildPreviewTextFromItem,
  buildChatWorkspaceSnapshotFromQueueState,
  createEmptyChatWorkspaceQueueState,
  createEmptyChatWorkspaceSnapshot,
  getConfirmedConversationMaxSequence,
  getConversationMetaOrDefault,
  mergeChatItems,
  pruneConversationFromSnapshot,
  clearConversationTombstone,
  upsertConversationWithTombstoneGuard,
  updateConversationInSnapshot,
  upsertChatConversation,
  upsertChatConversations,
  type ChatWorkspaceSnapshot,
  type PendingChatOutboxMessage,
} from "@/lib/chat-data"
import { createChatPersistence } from "@/lib/chat-persistence"
import { isChatServiceWorkerActive } from "@/lib/chat-web-service-worker"
import {
  clearDeliveredOutbox,
  shouldIncrementUnreadCount,
} from "@shared/chat-state"
import type { ChatComposerSendPayload } from "@/lib/chat-compose"
import { getDeviceLabel } from "@/lib/config"
import { createId } from "@/lib/ids"
import { nowIsoInstant } from "@shared/datetime"
import {
  type ActorRuntimeState,
  extractText,
  summarizeConversationEvent,
  type ChatConversationCreateInput,
  type ChatConversationCreateResponse,
  type ChatConversationItem,
  type ChatConversationMessagesPage,
  type ChatConversationReadWatermarkResponse,
  type ChatSocketEvent,
  type ChatSyncEvent,
} from "@shared"

export type ChatRuntimeStatus = "idle" | "loading" | "ready"

export interface ChatRuntimeState {
  status: ChatRuntimeStatus
  syncing: boolean
  error: string | null
  activeWorkspaceId: string | null
  snapshot: ChatWorkspaceSnapshot | null
  runtimeByConversationId: Record<string, Record<string, ActorRuntimeState>>
  /** conversationId -> workspaceMemberId -> expireAtMs */
  typingByConversation: Record<string, Record<string, number>>
}

type ChatRuntimeListener = (state: ChatRuntimeState) => void

function patchTaskInConversationItem(
  item: ChatConversationItem,
  payload: ChatSyncEvent<"task.updated">["payload"]
) {
  if (
    item.itemType !== "event" ||
    item.subtype !== "task_requested" ||
    !item.eventPayload ||
    typeof item.eventPayload !== "object"
  ) {
    return item
  }

  const currentTask =
    "task" in item.eventPayload
      ? ((item.eventPayload as { task?: unknown }).task as
          | { id?: string }
          | undefined)
      : undefined

  if (item.id !== payload.itemId && currentTask?.id !== payload.taskId) {
    return item
  }

  return {
    ...item,
    eventPayload: {
      ...(item.eventPayload as Record<string, unknown>),
      task: payload.task,
    },
  }
}

export class ChatRuntime {
  private readonly persistence = createChatPersistence()
  private readonly listeners = new Set<ChatRuntimeListener>()
  private persistPromise: Promise<void> = Promise.resolve()
  private syncPromise: Promise<void> | null = null
  private initializePromise: Promise<void> | null = null
  // In-memory (not persisted) live high-water mark per workspace for durable
  // sync-frame ordering. Initialized from / refreshed to the persisted
  // inboxCursor on every sync/bootstrap.
  private liveCursorByWorkspace = new Map<string, number>()
  // Set when a live gap arrives mid-sync; the in-flight sync reruns once after.
  private needsResync = false
  private state: ChatRuntimeState = {
    status: "idle",
    syncing: false,
    error: null,
    activeWorkspaceId: null,
    snapshot: null,
    runtimeByConversationId: {},
    typingByConversation: {},
  }

  subscribe(listener: ChatRuntimeListener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState() {
    return this.state
  }

  getSnapshot() {
    return this.state.snapshot
  }

  async awaitPersistence() {
    await this.persistPromise
  }

  private getActiveSnapshotForWorkspace(workspaceId: string) {
    const snapshot = this.state.snapshot
    if (
      this.state.activeWorkspaceId !== workspaceId ||
      !snapshot ||
      snapshot.workspaceId !== workspaceId
    ) {
      return null
    }

    return snapshot
  }

  private updateSnapshotForWorkspace(
    workspaceId: string,
    updater: (current: ChatWorkspaceSnapshot) => ChatWorkspaceSnapshot
  ) {
    const current = this.getActiveSnapshotForWorkspace(workspaceId)
    if (!current) {
      return null
    }

    const nextSnapshot = updater(current)
    this.replaceSnapshot(nextSnapshot)
    return nextSnapshot
  }

  deactivate() {
    this.initializePromise = null
    this.syncPromise = null
    this.replaceState({
      status: "idle",
      syncing: false,
      error: null,
      activeWorkspaceId: null,
      snapshot: null,
      runtimeByConversationId: {},
      typingByConversation: {},
    })
  }

  async clearLocalState() {
    await this.persistence.clearAllWorkspaceState()
    this.deactivate()
  }

  async reloadPersistedQueueState(workspaceId?: string | null) {
    const targetWorkspaceId = workspaceId ?? this.state.activeWorkspaceId
    if (!targetWorkspaceId) {
      return null
    }

    const persisted =
      await this.persistence.loadWorkspaceQueueState(targetWorkspaceId)
    if (this.state.activeWorkspaceId !== targetWorkspaceId) {
      return persisted
    }

    const queueState = persisted
    if (!this.state.snapshot) {
      this.replaceSnapshot(
        buildChatWorkspaceSnapshotFromQueueState(targetWorkspaceId, queueState)
      )
      return persisted
    }

    this.updateSnapshot((current) =>
      applyChatWorkspaceQueueState(
        current,
        queueState ?? createEmptyChatWorkspaceQueueState(targetWorkspaceId)
      )
    )

    return persisted
  }

  async ensureWorkspace(workspaceId: string) {
    if (
      this.state.activeWorkspaceId === workspaceId &&
      this.state.status === "ready" &&
      this.state.snapshot
    ) {
      return
    }

    if (this.initializePromise) {
      return this.initializePromise
    }

    this.initializePromise = this.initializeWorkspace(workspaceId).finally(
      () => {
        this.initializePromise = null
      }
    )

    return this.initializePromise
  }

  async refreshInbox() {
    const workspaceId = this.state.activeWorkspaceId
    if (!workspaceId) {
      return
    }

    await this.bootstrapWorkspace(workspaceId)
  }

  async syncFromServer() {
    const current = this.state.snapshot
    if (!current?.workspaceId) {
      return
    }
    const workspaceId = current.workspaceId

    if (this.syncPromise) {
      return this.syncPromise
    }

    this.needsResync = false
    this.replaceState({
      ...this.state,
      syncing: true,
    })

    this.syncPromise = (async () => {
      try {
        let cursor = this.state.snapshot?.inboxCursor ?? 0
        let hasMore = true

        while (hasMore) {
          if (this.state.activeWorkspaceId !== workspaceId) {
            return
          }

          const response = await api.getChatSync(current.workspaceId, {
            cursor,
            limit: 200,
          })

          for (const event of response.events) {
            if (this.state.activeWorkspaceId !== workspaceId) {
              return
            }
            // Skip frames the live path already applied (memberSeq <= live
            // cursor): re-applying a stale membership.updated{active}/upsert
            // could clear/resurrect a newer kick. Cursor still advances below.
            const liveBase = Math.max(
              this.liveCursorByWorkspace.get(workspaceId) ?? 0,
              this.state.snapshot?.inboxCursor ?? 0
            )
            if (event.memberSeq <= liveBase) {
              continue
            }
            this.applyChatEvent(event)
          }

          cursor = response.nextCursor
          hasMore = response.hasMore
        }

        if (this.state.activeWorkspaceId !== workspaceId) {
          return
        }

        // Advance the authoritative resume cursor to the drained position
        // (the reducer no longer advances it), and refresh the live cursor so
        // the next live frame isn't misjudged as a gap.
        this.updateSnapshot((snap) => ({ ...snap, inboxCursor: cursor }))
        this.liveCursorByWorkspace.set(
          workspaceId,
          Math.max(this.liveCursorByWorkspace.get(workspaceId) ?? 0, cursor)
        )

        // When the SW is owning the flush (see markConversationRead +
        // sendMessage above), the provider triggers it on every queue
        // change. Calling flushPendingReads/flushOutbox here would race
        // the SW and double-POST.
        if (isChatServiceWorkerActive()) {
          return
        }

        await this.flushPendingReads()
        await this.flushOutbox()
      } finally {
        this.syncPromise = null
        this.replaceState({
          ...this.state,
          syncing: false,
        })
        if (this.needsResync) {
          this.needsResync = false
          void this.syncFromServer()
        }
      }
    })()

    return this.syncPromise
  }

  handleSocketConnected() {
    void this.syncFromServer()
  }

  handleSocketEvent(event: ChatSocketEvent | Record<string, unknown>) {
    if (event.type === "chat.sync.event") {
      this.applyLiveSyncEvent(
        (event as ChatSocketEvent<"chat.sync.event">).payload
      )
      return
    }

    if (event.type === "runtime.updated") {
      const payload = (event as ChatSocketEvent<"runtime.updated">).payload
      this.replaceState({
        ...this.state,
        runtimeByConversationId: {
          ...this.state.runtimeByConversationId,
          [payload.conversationId]: {
            ...(this.state.runtimeByConversationId[payload.conversationId] ??
              {}),
            [payload.snapshot.actorId]: payload.snapshot,
          },
        },
      })
    }

    if (event.type === "chat.typing") {
      const payload = (event as ChatSocketEvent<"chat.typing">).payload
      const ownMember = this.state.snapshot?.workspaceMemberId
      if (payload.fromWorkspaceMemberId === ownMember) {
        return
      }
      const current =
        this.state.typingByConversation[payload.conversationId] ?? {}
      const next = { ...current }
      if (payload.state === "stopped") {
        delete next[payload.fromWorkspaceMemberId]
      } else {
        next[payload.fromWorkspaceMemberId] = Date.now() + 5_000
      }
      const nextByConv = { ...this.state.typingByConversation }
      if (Object.keys(next).length > 0) {
        nextByConv[payload.conversationId] = next
      } else {
        delete nextByConv[payload.conversationId]
      }
      this.replaceState({
        ...this.state,
        typingByConversation: nextByConv,
      })
    }
  }

  async sendTypingState(conversationId: string, state: "started" | "stopped") {
    const snapshot = this.state.snapshot
    if (!snapshot) return
    try {
      await api.sendChatTypingState(snapshot.workspaceId, conversationId, state)
    } catch (error) {
      // Typing is best-effort.
      clientLog.debug("Failed to send typing state:", error)
    }
  }

  async refreshConversation(conversationId: string) {
    const current = this.state.snapshot
    if (!current?.workspaceId || !current.clientInstanceId) {
      return null
    }
    const workspaceId = current.workspaceId
    const clientInstanceId = current.clientInstanceId

    this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => ({
      ...snapshotValue,
      metaByConversationId: {
        ...snapshotValue.metaByConversationId,
        [conversationId]: {
          ...getConversationMetaOrDefault(snapshotValue, conversationId),
          loadingLatest: true,
          latestLoadError: undefined,
        },
      },
    }))

    try {
      const response = await api.getChatConversationMessages(
        workspaceId,
        conversationId,
        {
          clientInstanceId,
          limit: 100,
        }
      )

      if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
        return null
      }

      this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => ({
        ...snapshotValue,
        outbox: clearDeliveredOutbox(snapshotValue.outbox, response.items),
        conversations: upsertChatConversation(
          snapshotValue.conversations,
          response.conversation
        ),
        itemsByConversationId: {
          ...snapshotValue.itemsByConversationId,
          [conversationId]: mergeChatItems(
            snapshotValue.itemsByConversationId[conversationId] ?? [],
            response.items
          ),
        },
        metaByConversationId: {
          ...snapshotValue.metaByConversationId,
          [conversationId]: {
            readWatermarkSequence: response.participantReadWatermarkSequence,
            hasMoreBefore: response.hasMoreBefore,
            hasLoadedLatest: true,
            loadingLatest: false,
            lastFetchedAt: nowIsoInstant(),
            latestLoadError: undefined,
          },
        },
      }))

      if (this.getActiveSnapshotForWorkspace(workspaceId)) {
        this.replaceState({
          ...this.state,
          runtimeByConversationId: {
            ...this.state.runtimeByConversationId,
            [conversationId]: response.runtimeByActor ?? {},
          },
        })
      }

      return response
    } catch (error) {
      if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
        return null
      }

      this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => ({
        ...snapshotValue,
        metaByConversationId: {
          ...snapshotValue.metaByConversationId,
          [conversationId]: {
            ...getConversationMetaOrDefault(snapshotValue, conversationId),
            loadingLatest: false,
            latestLoadError:
              error instanceof Error ? error.message : "加载聊天记录失败。",
          },
        },
      }))
      throw error
    }
  }

  async loadOlderMessages(conversationId: string) {
    const current = this.state.snapshot
    if (!current?.workspaceId || !current.clientInstanceId) {
      return
    }
    const workspaceId = current.workspaceId
    const clientInstanceId = current.clientInstanceId

    const existingItems = current.itemsByConversationId[conversationId] ?? []
    const earliestSequence = existingItems[0]?.sequence
    if (!earliestSequence) {
      await this.refreshConversation(conversationId)
      return
    }

    const response = await api.getChatConversationMessages(
      workspaceId,
      conversationId,
      {
        clientInstanceId,
        beforeSequence: earliestSequence,
        limit: 100,
      }
    )

    if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
      return
    }

    this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => ({
      ...snapshotValue,
      conversations: upsertChatConversation(
        snapshotValue.conversations,
        response.conversation
      ),
      itemsByConversationId: {
        ...snapshotValue.itemsByConversationId,
        [conversationId]: mergeChatItems(
          snapshotValue.itemsByConversationId[conversationId] ?? [],
          response.items
        ),
      },
      metaByConversationId: {
        ...snapshotValue.metaByConversationId,
        [conversationId]: {
          ...getConversationMetaOrDefault(snapshotValue, conversationId),
          readWatermarkSequence: Math.max(
            getConversationMetaOrDefault(snapshotValue, conversationId)
              .readWatermarkSequence,
            response.participantReadWatermarkSequence
          ),
          hasMoreBefore: response.hasMoreBefore,
          lastFetchedAt: nowIsoInstant(),
        },
      },
    }))

    if (this.getActiveSnapshotForWorkspace(workspaceId)) {
      this.replaceState({
        ...this.state,
        runtimeByConversationId: {
          ...this.state.runtimeByConversationId,
          [conversationId]:
            response.runtimeByActor ??
            this.state.runtimeByConversationId[conversationId] ??
            {},
        },
      })
    }
  }

  async markConversationRead(
    conversationId: string,
    readUpToSequence: number,
    lastVisibleSequence?: number
  ) {
    const current = this.state.snapshot
    if (!current?.workspaceId) {
      return
    }
    const workspaceId = current.workspaceId
    const confirmedMaxSequence = getConfirmedConversationMaxSequence(
      current.itemsByConversationId[conversationId] ?? []
    )
    if (confirmedMaxSequence <= 0) {
      return
    }

    const normalizedReadUpToSequence = Math.min(
      confirmedMaxSequence,
      Math.max(0, Math.floor(readUpToSequence))
    )
    const normalizedLastVisibleSequence = Math.min(
      confirmedMaxSequence,
      Math.max(
        normalizedReadUpToSequence,
        Math.floor(lastVisibleSequence ?? normalizedReadUpToSequence)
      )
    )

    this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) =>
      updateConversationInSnapshot(
        {
          ...snapshotValue,
          pendingReads: {
            ...snapshotValue.pendingReads,
            [conversationId]: {
              conversationId,
              readUpToSequence: Math.max(
                normalizedReadUpToSequence,
                snapshotValue.pendingReads[conversationId]?.readUpToSequence ??
                  0
              ),
              lastVisibleSequence: Math.max(
                normalizedLastVisibleSequence,
                snapshotValue.pendingReads[conversationId]
                  ?.lastVisibleSequence ?? 0
              ),
              updatedAt: nowIsoInstant(),
            },
          },
          metaByConversationId: {
            ...snapshotValue.metaByConversationId,
            [conversationId]: {
              ...getConversationMetaOrDefault(snapshotValue, conversationId),
              readWatermarkSequence: Math.max(
                getConversationMetaOrDefault(snapshotValue, conversationId)
                  .readWatermarkSequence,
                normalizedReadUpToSequence
              ),
            },
          },
        },
        conversationId,
        (conversation) => ({
          ...conversation,
          unreadCount: 0,
        })
      )
    )

    if (!current.clientInstanceId) {
      return
    }

    // When the chat service worker has taken control on web, it is the
    // single owner of read-watermark POSTs (the provider re-broadcasts
    // queue changes to the SW via requestChatServiceWorkerSync). The
    // main thread doing a direct POST here would mean two writes per
    // mark — see S6 ("主线程与 SW 互斥、一次只 POST 一次"). On native
    // and on web before the SW activates, the main thread still POSTs
    // so the user's read state isn't lost.
    if (isChatServiceWorkerActive()) {
      return
    }

    const clientInstanceId = current.clientInstanceId
    try {
      const response = await api.updateChatConversationReadWatermark(
        workspaceId,
        conversationId,
        {
          clientInstanceId,
          readUpToSequence: normalizedReadUpToSequence,
          lastVisibleSequence: normalizedLastVisibleSequence,
        }
      )
      if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
        return
      }
      this.applyReadWatermarkAck(response)
    } catch {
      // Keep the pending read queued for the next sync/connection.
    }
  }

  async sendMessage(conversationId: string, input: ChatComposerSendPayload) {
    const current = this.state.snapshot
    if (!current?.workspaceId) {
      throw new Error("No active workspace")
    }
    if (!current.clientInstanceId) {
      throw new Error("Chat is still connecting")
    }

    const existingItems = current.itemsByConversationId[conversationId] ?? []
    const existingOutbox = Object.values(current.outbox).filter(
      (entry) => entry.conversationId === conversationId
    )
    const optimisticSequence =
      Math.max(
        Date.now() * 1000,
        ...existingItems.map((item) => item.sequence),
        ...existingOutbox.map((item) => item.optimisticSequence),
        0
      ) + 1

    const clientMessageId = createId("message")
    const outboxEntry: PendingChatOutboxMessage = {
      clientMessageId,
      conversationId,
      contentBlocks: input.contentBlocks,
      replyToItemId: input.replyToItemId,
      replyTo: input.replyTo,
      createdAt: nowIsoInstant(),
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    }

    this.updateSnapshot((snapshotValue) => ({
      ...snapshotValue,
      outbox: {
        ...snapshotValue.outbox,
        [clientMessageId]: outboxEntry,
      },
    }))

    // The SW polls the outbox via requestChatServiceWorkerSync() that
    // the provider fires when the queue changes; it owns the outbox
    // flush whenever it has activated. Skip the main-thread flush in
    // that case to avoid double-POSTing the same clientMessageId. On
    // native (no SW) or web before SW activation, fall through.
    if (isChatServiceWorkerActive()) {
      return
    }

    await this.flushOutbox()
  }

  /**
   * Reset a retrying/failed outbox entry's attempt count and immediately
   * re-attempt the flush. Used by the manual "retry" button.
   */
  async retryMessage(clientMessageId: string) {
    const current = this.state.snapshot
    if (!current) return
    const entry = current.outbox[clientMessageId]
    if (!entry) return

    this.updateSnapshot((snapshotValue) => ({
      ...snapshotValue,
      outbox: {
        ...snapshotValue.outbox,
        [clientMessageId]: {
          ...entry,
          status: "sending",
          attemptCount: 0,
          firstFailedAt: undefined,
          lastErrorMessage: undefined,
        },
      },
    }))

    // Same SW-mutex rule as sendMessage/markConversationRead — when the
    // SW is alive on web it owns the actual POST and the provider's
    // queue-change effect will trigger the sync once the optimistic
    // update lands. Falling through to flushOutbox would mean both the
    // SW and the main thread re-POST the same clientMessageId.
    if (isChatServiceWorkerActive()) {
      return
    }

    await this.flushOutbox()
  }

  async createConversation(
    input: Omit<ChatConversationCreateInput, "clientRequestId"> & {
      workspaceId?: string
    }
  ): Promise<ChatConversationCreateResponse> {
    const workspaceId = input.workspaceId ?? this.state.activeWorkspaceId
    if (!workspaceId) {
      throw new Error("No active workspace")
    }

    const response = await api.createChatConversation(workspaceId, {
      clientRequestId: createId("conversation"),
      kind: input.kind,
      title: input.title,
      actorIds: input.actorIds ?? [],
      workspaceMemberIds: input.workspaceMemberIds ?? [],
      remoteAgentIds: input.remoteAgentIds ?? [],
      metadata: input.metadata,
    })

    if (this.state.activeWorkspaceId === workspaceId) {
      this.updateSnapshot((snapshotValue) => ({
        ...snapshotValue,
        conversations: upsertChatConversation(
          snapshotValue.conversations,
          response.conversation
        ),
      }))
    }

    return response
  }

  private replaceState(nextState: ChatRuntimeState) {
    this.state = nextState
    for (const listener of this.listeners) {
      listener(nextState)
    }
  }

  private replaceSnapshot(nextSnapshot: ChatWorkspaceSnapshot | null) {
    const nextState = {
      ...this.state,
      snapshot: nextSnapshot,
    }
    this.replaceState(nextState)

    if (nextSnapshot) {
      this.persistPromise = this.persistPromise
        .then(() => this.persistence.saveWorkspaceState(nextSnapshot))
        .catch(() => undefined)
    }
  }

  private updateSnapshot(
    updater: (current: ChatWorkspaceSnapshot) => ChatWorkspaceSnapshot
  ) {
    const current = this.state.snapshot
    if (!current) {
      return null
    }

    const nextSnapshot = updater(current)
    this.replaceSnapshot(nextSnapshot)
    return nextSnapshot
  }

  private async initializeWorkspace(workspaceId: string) {
    this.replaceState({
      ...this.state,
      activeWorkspaceId: workspaceId,
      status: "loading",
      error: null,
      runtimeByConversationId: {},
    })

    const persisted = await this.persistence.loadWorkspaceState(workspaceId)
    if (this.state.activeWorkspaceId !== workspaceId) {
      return
    }

    const hydratedSnapshot =
      persisted ?? createEmptyChatWorkspaceSnapshot(workspaceId)
    const hasHydratedConversations = hydratedSnapshot.conversations.length > 0

    this.replaceState({
      ...this.state,
      activeWorkspaceId: workspaceId,
      status: hasHydratedConversations ? "ready" : "loading",
      error: null,
      snapshot: hydratedSnapshot,
      runtimeByConversationId: {},
    })

    if (this.state.snapshot) {
      this.persistPromise = this.persistPromise
        .then(() => this.persistence.saveWorkspaceState(this.state.snapshot!))
        .catch(() => undefined)
    }

    try {
      await this.bootstrapWorkspace(workspaceId)
    } catch (error) {
      if (this.state.activeWorkspaceId !== workspaceId) {
        return
      }

      this.replaceState({
        ...this.state,
        error: error instanceof Error ? error.message : "消息同步初始化失败。",
      })
    }
  }

  private async bootstrapWorkspace(workspaceId: string) {
    const bootstrap = await api.getChatBootstrap(workspaceId)
    if (this.state.activeWorkspaceId !== workspaceId) {
      return
    }

    let baseSnapshot =
      this.state.snapshot ?? createEmptyChatWorkspaceSnapshot(workspaceId)
    if (
      baseSnapshot.workspaceMemberId &&
      baseSnapshot.workspaceMemberId !== bootstrap.workspaceMemberId
    ) {
      baseSnapshot = createEmptyChatWorkspaceSnapshot(workspaceId)
    }

    const clientInstanceInput = {
      platform: Platform.OS,
      deviceLabel: getDeviceLabel(),
      metadata: {
        workspaceMemberId: bootstrap.workspaceMemberId,
      },
    }

    let clientInstanceId = baseSnapshot.clientInstanceId
    if (clientInstanceId) {
      const response = await api.touchChatClientInstance(
        workspaceId,
        clientInstanceId,
        clientInstanceInput
      )
      if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
        return
      }
      clientInstanceId = response.clientInstanceId
    }

    if (!clientInstanceId) {
      const response = await api.createChatClientInstance(
        workspaceId,
        clientInstanceInput
      )
      if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
        return
      }
      clientInstanceId = response.clientInstanceId
    }

    // Authoritative prune: bootstrap conversations are the member's current
    // live set. Locally-known conversations absent from it (removed while
    // offline) are pruned + tombstoned at the bootstrap cursor; live ones get
    // any tombstone cleared (legitimate re-add).
    const liveIds = new Set(
      bootstrap.conversations.map((conversation) => conversation.conversationId)
    )
    let prunedBase = baseSnapshot
    for (const conversation of baseSnapshot.conversations) {
      if (!liveIds.has(conversation.conversationId)) {
        prunedBase = pruneConversationFromSnapshot(
          prunedBase,
          conversation.conversationId,
          bootstrap.nextInboxCursor
        )
      }
    }
    for (const conversationId of liveIds) {
      prunedBase = clearConversationTombstone(prunedBase, conversationId)
    }

    const nextInboxCursor = Math.max(
      prunedBase.inboxCursor,
      bootstrap.nextInboxCursor
    )
    this.liveCursorByWorkspace.set(
      workspaceId,
      Math.max(
        this.liveCursorByWorkspace.get(workspaceId) ?? 0,
        nextInboxCursor
      )
    )

    this.replaceSnapshot({
      ...prunedBase,
      workspaceId,
      workspaceMemberId: bootstrap.workspaceMemberId,
      clientInstanceId,
      inboxCursor: nextInboxCursor,
      lastBootstrappedAt: nowIsoInstant(),
      conversations: upsertChatConversations(
        prunedBase.conversations,
        bootstrap.conversations
      ),
    })

    this.replaceState({
      ...this.state,
      status: "ready",
      error: null,
    })

    await this.syncFromServer()
  }

  private applyReadWatermarkAck(
    response: ChatConversationReadWatermarkResponse
  ) {
    this.updateSnapshot((current) => {
      const pendingReads = { ...current.pendingReads }
      const queued = pendingReads[response.conversationId]
      if (queued && queued.readUpToSequence <= response.readWatermarkSequence) {
        delete pendingReads[response.conversationId]
      }

      return updateConversationInSnapshot(
        {
          ...current,
          pendingReads,
          metaByConversationId: {
            ...current.metaByConversationId,
            [response.conversationId]: {
              ...getConversationMetaOrDefault(current, response.conversationId),
              readWatermarkSequence: Math.max(
                getConversationMetaOrDefault(current, response.conversationId)
                  .readWatermarkSequence,
                response.readWatermarkSequence
              ),
            },
          },
        },
        response.conversationId,
        (conversation) => ({
          ...conversation,
          unreadCount: 0,
        })
      )
    })
  }

  /**
   * Live durable-frame handler with strict member_seq ordering. base is the
   * unified high-water mark across the persisted resume cursor and the in-memory
   * live cursor. Stale (<=base) frames are dropped; in-order (==base+1) frames
   * apply and advance the live cursor; gaps (>base+1) trigger a contiguous
   * resync instead of a blind (potentially clobbering/resurrecting) apply.
   */
  private applyLiveSyncEvent(event: ChatSyncEvent) {
    const snapshot = this.state.snapshot
    if (!snapshot || snapshot.workspaceId !== event.workspaceId) {
      return
    }
    const workspaceId = event.workspaceId
    const base = Math.max(
      this.liveCursorByWorkspace.get(workspaceId) ?? 0,
      snapshot.inboxCursor
    )

    if (event.memberSeq <= base) {
      return
    }
    if (event.memberSeq > base + 1) {
      if (this.syncPromise) {
        this.needsResync = true
      } else {
        void this.syncFromServer()
      }
      return
    }

    this.liveCursorByWorkspace.set(workspaceId, event.memberSeq)
    this.applyChatEvent(event)
  }

  private applyChatEvent(event: ChatSyncEvent) {
    this.updateSnapshot((current) => {
      // Persisted inboxCursor is NOT advanced here — only the contiguous sync
      // drain and bootstrap advance it (the authoritative resume cursor). Live
      // ordering uses the in-memory liveCursor (see handleSocketEvent).
      let nextSnapshot: ChatWorkspaceSnapshot = current

      switch (event.eventType) {
        case "conversation.upsert": {
          const payload =
            event.payload as ChatSyncEvent<"conversation.upsert">["payload"]
          nextSnapshot = upsertConversationWithTombstoneGuard(
            nextSnapshot,
            payload.conversation,
            event.memberSeq
          )
          break
        }
        case "conversation.membership.updated": {
          const payload =
            event.payload as ChatSyncEvent<"conversation.membership.updated">["payload"]
          if (payload.selfState === "active") {
            nextSnapshot = clearConversationTombstone(
              nextSnapshot,
              payload.conversationId,
              event.memberSeq
            )
          } else {
            nextSnapshot = pruneConversationFromSnapshot(
              nextSnapshot,
              payload.conversationId,
              event.memberSeq
            )
          }
          break
        }
        case "conversation.item.created": {
          const { conversationId, item } =
            event.payload as ChatSyncEvent<"conversation.item.created">["payload"]
          // Guard against a stale item resurrecting a tombstoned conversation's
          // orphan item map.
          const tombstone = nextSnapshot.tombstones[conversationId]
          if (
            tombstone &&
            typeof event.memberSeq === "number" &&
            event.memberSeq <= tombstone.removedSeq
          ) {
            // Still clear any delivered outbox echo, but don't recreate state.
            nextSnapshot = {
              ...nextSnapshot,
              outbox: clearDeliveredOutbox(nextSnapshot.outbox, [item]),
            }
            break
          }
          const currentItems =
            nextSnapshot.itemsByConversationId[conversationId] ?? []
          const alreadyExists = currentItems.some(
            (entry) => entry.id === item.id
          )
          const nextItems = mergeChatItems(currentItems, [item])

          nextSnapshot = {
            ...nextSnapshot,
            outbox: clearDeliveredOutbox(nextSnapshot.outbox, [item]),
            itemsByConversationId: {
              ...nextSnapshot.itemsByConversationId,
              [conversationId]: nextItems,
            },
          }

          nextSnapshot = updateConversationInSnapshot(
            nextSnapshot,
            conversationId,
            (entry) => {
              // Idempotency: replay must not double-count unread or regress
              // lastItem. Skip when this item is not newer than what the
              // conversation already reflects.
              const isNewerItem =
                !entry.lastItem || item.sequence > entry.lastItem.sequence
              if (!isNewerItem) {
                return entry
              }
              return {
                ...entry,
                unreadCount:
                  !alreadyExists && shouldIncrementUnreadCount(entry, item)
                    ? entry.unreadCount + 1
                    : entry.unreadCount,
                updatedAt: item.createdAt,
                lastItem: {
                  itemId: item.id,
                  sequence: item.sequence,
                  itemType: item.itemType,
                  subtype: item.subtype,
                  previewText: buildPreviewTextFromItem(item),
                  authorParticipantId: item.authorParticipantId,
                  author: item.author,
                  createdAt: item.createdAt,
                },
              }
            }
          )
          break
        }
        case "conversation.read.updated": {
          const payload =
            event.payload as ChatSyncEvent<"conversation.read.updated">["payload"]
          if (payload.workspaceMemberId !== current.workspaceMemberId) {
            break
          }

          const pendingReads = { ...nextSnapshot.pendingReads }
          const queued = pendingReads[payload.conversationId]
          if (
            queued &&
            queued.readUpToSequence <= payload.readWatermarkSequence
          ) {
            delete pendingReads[payload.conversationId]
          }

          nextSnapshot = updateConversationInSnapshot(
            {
              ...nextSnapshot,
              pendingReads,
              metaByConversationId: {
                ...nextSnapshot.metaByConversationId,
                [payload.conversationId]: {
                  ...getConversationMetaOrDefault(
                    nextSnapshot,
                    payload.conversationId
                  ),
                  readWatermarkSequence: Math.max(
                    getConversationMetaOrDefault(
                      nextSnapshot,
                      payload.conversationId
                    ).readWatermarkSequence,
                    payload.readWatermarkSequence
                  ),
                },
              },
            },
            payload.conversationId,
            (conversation) => ({
              ...conversation,
              unreadCount: 0,
            })
          )
          break
        }
        case "task.updated": {
          const payload =
            event.payload as ChatSyncEvent<"task.updated">["payload"]
          const currentItems =
            nextSnapshot.itemsByConversationId[payload.conversationId] ?? []
          const nextItems = currentItems.map((item) =>
            patchTaskInConversationItem(item, payload)
          )

          nextSnapshot = {
            ...nextSnapshot,
            itemsByConversationId: {
              ...nextSnapshot.itemsByConversationId,
              [payload.conversationId]: nextItems,
            },
          }

          nextSnapshot = updateConversationInSnapshot(
            nextSnapshot,
            payload.conversationId,
            (conversation) => ({
              ...conversation,
              lastItem:
                payload.itemId &&
                conversation.lastItem?.itemId === payload.itemId
                  ? {
                      ...conversation.lastItem,
                      previewText: summarizeConversationEvent(
                        "task_requested",
                        {
                          task: payload.task,
                        }
                      ),
                    }
                  : conversation.lastItem,
            })
          )
          break
        }
      }

      return nextSnapshot
    })
  }

  private async flushPendingReads() {
    const current = this.state.snapshot
    if (!current?.workspaceId || !current.clientInstanceId) {
      return
    }
    const workspaceId = current.workspaceId

    const pendingReads = Object.values(current.pendingReads).sort(
      (left, right) => left.readUpToSequence - right.readUpToSequence
    )

    for (const entry of pendingReads) {
      const activeSnapshot = this.getActiveSnapshotForWorkspace(workspaceId)
      if (!activeSnapshot?.clientInstanceId) {
        return
      }

      const activeEntry = activeSnapshot.pendingReads[entry.conversationId]
      if (
        !activeEntry ||
        activeEntry.readUpToSequence !== entry.readUpToSequence ||
        activeEntry.lastVisibleSequence !== entry.lastVisibleSequence
      ) {
        continue
      }

      try {
        const response = await api.updateChatConversationReadWatermark(
          workspaceId,
          entry.conversationId,
          {
            clientInstanceId: activeSnapshot.clientInstanceId,
            readUpToSequence: activeEntry.readUpToSequence,
            lastVisibleSequence: activeEntry.lastVisibleSequence,
          }
        )
        if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
          return
        }
        this.applyReadWatermarkAck(response)
      } catch {
        break
      }
    }
  }

  private async flushOutbox() {
    const current = this.state.snapshot
    if (!current?.workspaceId || !current.clientInstanceId) {
      return
    }
    const workspaceId = current.workspaceId

    const entries = Object.values(current.outbox).sort(
      (left, right) => left.optimisticSequence - right.optimisticSequence
    )

    for (const entry of entries) {
      const activeSnapshot = this.getActiveSnapshotForWorkspace(workspaceId)
      if (!activeSnapshot?.clientInstanceId) {
        return
      }

      const activeEntry = activeSnapshot.outbox[entry.clientMessageId]
      if (!activeEntry) {
        continue
      }

      this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => {
        const queuedEntry = snapshotValue.outbox[entry.clientMessageId]
        if (!queuedEntry) {
          return snapshotValue
        }

        return {
          ...snapshotValue,
          outbox: {
            ...snapshotValue.outbox,
            [entry.clientMessageId]: {
              ...queuedEntry,
              attemptCount: queuedEntry.attemptCount + 1,
              lastAttemptAt: nowIsoInstant(),
            },
          },
        }
      })

      const latestSnapshot = this.getActiveSnapshotForWorkspace(workspaceId)
      if (!latestSnapshot?.clientInstanceId) {
        return
      }
      const latestEntry = latestSnapshot.outbox[entry.clientMessageId]
      if (!latestEntry) {
        continue
      }

      try {
        const response = await api.sendChatConversationMessage(
          workspaceId,
          latestEntry.conversationId,
          {
            clientInstanceId: latestSnapshot.clientInstanceId,
            clientMessageId: latestEntry.clientMessageId,
            contentBlocks: latestEntry.contentBlocks,
            replyToItemId: latestEntry.replyToItemId,
          }
        )

        if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
          return
        }

        this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => {
          const queuedEntry = snapshotValue.outbox[entry.clientMessageId]
          if (!queuedEntry) {
            return snapshotValue
          }

          const nextOutbox = { ...snapshotValue.outbox }
          delete nextOutbox[entry.clientMessageId]

          const nextItems = mergeChatItems(
            snapshotValue.itemsByConversationId[queuedEntry.conversationId] ??
              [],
            [response.item]
          )

          return updateConversationInSnapshot(
            {
              ...snapshotValue,
              outbox: nextOutbox,
              itemsByConversationId: {
                ...snapshotValue.itemsByConversationId,
                [queuedEntry.conversationId]: nextItems,
              },
            },
            queuedEntry.conversationId,
            (conversation) => ({
              ...conversation,
              updatedAt: response.item.createdAt,
              lastItem: {
                itemId: response.item.id,
                sequence: response.item.sequence,
                itemType: response.item.itemType,
                subtype: response.item.subtype,
                previewText: buildPreviewTextFromItem(response.item),
                authorParticipantId: response.item.authorParticipantId,
                author: response.item.author,
                createdAt: response.item.createdAt,
              },
            })
          )
        })
      } catch (error) {
        if (!this.getActiveSnapshotForWorkspace(workspaceId)) {
          return
        }

        this.updateSnapshotForWorkspace(workspaceId, (snapshotValue) => {
          const queuedEntry = snapshotValue.outbox[entry.clientMessageId]
          if (!queuedEntry) {
            return snapshotValue
          }

          return {
            ...snapshotValue,
            outbox: {
              ...snapshotValue.outbox,
              [entry.clientMessageId]: {
                ...queuedEntry,
                status: "retrying",
                firstFailedAt: queuedEntry.firstFailedAt ?? nowIsoInstant(),
                lastErrorMessage:
                  error instanceof Error ? error.message : "发送失败",
              },
            },
          }
        })
        break
      }
    }
  }
}

export function createChatRuntime() {
  return new ChatRuntime()
}

export const chatRuntime = createChatRuntime()
