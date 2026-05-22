import { AppState, Platform, type AppStateStatus } from "react-native"
import * as Network from "expo-network"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { useWorkspaceWebSocket } from "@/hooks/use-workspace-websocket"
import { syncChatBackgroundTaskRegistration } from "@/lib/chat-background-task"
import type { ChatComposerSendPayload } from "@/lib/chat-compose"
import { api, type ChatInteractionResolveInput } from "@/lib/api"
import {
  chatRuntime,
  type ChatRuntimeState,
  type ChatRuntimeStatus,
} from "@/lib/chat-runtime"
import {
  getConversationMetaOrDefault,
  getMobileConversationItems,
  toPendingReadAdjustedUnreadCount,
  type ChatConversationMeta,
  type MobileChatItem,
} from "@/lib/chat-data"
import {
  ensureChatServiceWorkerRegistered,
  requestChatServiceWorkerSync,
  subscribeToChatServiceWorker,
  syncChatServiceWorkerAuthContext,
} from "@/lib/chat-web-service-worker"
import { reportApiUnauthorized } from "@/lib/api"
import { useSession } from "@/providers/session-provider"
import { useWorkspace } from "@/providers/workspace-provider"
import {
  type ActorRuntimeState,
  type ChatConversationCreateResponse,
  type ChatConversationMessagesPage,
  type ChatConversationView,
  type InteractionRequestSummary,
  type ChatSocketEvent,
} from "@shared"

interface ChatContextValue {
  status: ChatRuntimeStatus
  syncing: boolean
  error: string | null
  workspaceMemberId: string | null
  clientInstanceId: string | null
  conversations: ChatConversationView[]
  totalUnreadCount: number
  getConversation: (conversationId: string) => ChatConversationView | null
  getConversationItems: (conversationId: string) => MobileChatItem[]
  getConversationMeta: (conversationId: string) => ChatConversationMeta | null
  getConversationRuntimes: (
    conversationId: string
  ) => Record<string, ActorRuntimeState>
  getTypingMembers: (conversationId: string) => string[]
  sendTypingState: (
    conversationId: string,
    state: "started" | "stopped"
  ) => Promise<void>
  refreshInbox: () => Promise<void>
  refreshConversation: (
    conversationId: string
  ) => Promise<ChatConversationMessagesPage | null>
  loadOlderMessages: (conversationId: string) => Promise<void>
  markConversationRead: (
    conversationId: string,
    readUpToSequence: number,
    lastVisibleSequence?: number
  ) => Promise<void>
  sendMessage: (
    conversationId: string,
    input: ChatComposerSendPayload
  ) => Promise<void>
  retryMessage: (clientMessageId: string) => Promise<void>
  respondInteraction: (
    conversationId: string,
    interactionId: string,
    input: ChatInteractionResolveInput
  ) => Promise<InteractionRequestSummary>
  createConversation: (input: {
    kind: "group" | "private" | "virtual"
    title?: string
    actorIds?: string[]
    workspaceMemberIds?: string[]
    boundary?: "internal" | "external"
  }) => Promise<ChatConversationCreateResponse>
  clearLocalState: () => Promise<void>
}

const ChatContext = createContext<ChatContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const { status: sessionStatus, token } = useSession()
  const { workspaceId } = useWorkspace()
  const [runtimeState, setRuntimeState] = useState<ChatRuntimeState>(
    chatRuntime.getState()
  )

  useEffect(() => {
    return chatRuntime.subscribe(setRuntimeState)
  }, [])

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !workspaceId) {
      chatRuntime.deactivate()
      return
    }

    void chatRuntime.ensureWorkspace(workspaceId)
  }, [sessionStatus, workspaceId])

  useEffect(() => {
    void syncChatBackgroundTaskRegistration({
      token: sessionStatus === "authenticated" ? token : null,
      workspaceId: sessionStatus === "authenticated" ? workspaceId : null,
    })
  }, [sessionStatus, token, workspaceId])

  useEffect(() => {
    if (Platform.OS !== "web") {
      return
    }

    void ensureChatServiceWorkerRegistered()
  }, [])

  useEffect(() => {
    if (Platform.OS !== "web") {
      return
    }

    void syncChatServiceWorkerAuthContext({
      token: sessionStatus === "authenticated" ? token : null,
      workspaceId: sessionStatus === "authenticated" ? workspaceId : null,
    })
  }, [sessionStatus, token, workspaceId])

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !workspaceId) {
      return
    }

    function handleAppStateChange(nextState: AppStateStatus) {
      if (nextState === "active") {
        void chatRuntime.syncFromServer()
      }
    }

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange
    )
    return () => subscription.remove()
  }, [sessionStatus, workspaceId])

  useEffect(() => {
    if (sessionStatus !== "authenticated" || !workspaceId) {
      return
    }

    const subscription = Network.addNetworkStateListener((event) => {
      if (event.isConnected && event.isInternetReachable !== false) {
        void chatRuntime.syncFromServer()
      }
    })

    return () => subscription.remove()
  }, [sessionStatus, workspaceId])

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      sessionStatus !== "authenticated" ||
      !workspaceId
    ) {
      return
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void chatRuntime.syncFromServer()
      }
    }

    function handleOnline() {
      void chatRuntime.syncFromServer()
      void requestChatServiceWorkerSync("browser-online")
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("online", handleOnline)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("online", handleOnline)
    }
  }, [sessionStatus, workspaceId])

  useEffect(() => {
    if (Platform.OS !== "web") {
      return
    }

    return subscribeToChatServiceWorker((message) => {
      if (message.type === "chat:auth-expired") {
        reportApiUnauthorized(401)
        return
      }

      if (
        workspaceId &&
        message.type === "chat:queue-updated" &&
        message.payload.workspaceId === workspaceId
      ) {
        void chatRuntime
          .reloadPersistedQueueState(workspaceId)
          .then(() => chatRuntime.syncFromServer())
          .catch(() => undefined)
      }
    })
  }, [workspaceId])

  const pendingReadCount = Object.keys(
    runtimeState.snapshot?.pendingReads ?? {}
  ).length
  const outboxCount = Object.keys(runtimeState.snapshot?.outbox ?? {}).length

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      sessionStatus !== "authenticated" ||
      !workspaceId ||
      (pendingReadCount === 0 && outboxCount === 0)
    ) {
      return
    }

    void chatRuntime
      .awaitPersistence()
      .then(() => requestChatServiceWorkerSync("queue-updated"))
      .catch(() => undefined)
  }, [outboxCount, pendingReadCount, sessionStatus, workspaceId])

  useEffect(() => {
    if (
      Platform.OS !== "web" ||
      sessionStatus !== "authenticated" ||
      !workspaceId ||
      !runtimeState.snapshot?.clientInstanceId
    ) {
      return
    }

    void chatRuntime
      .awaitPersistence()
      .then(() => requestChatServiceWorkerSync("client-instance-ready"))
      .catch(() => undefined)
  }, [runtimeState.snapshot?.clientInstanceId, sessionStatus, workspaceId])

  useWorkspaceWebSocket({
    workspaceId: workspaceId || undefined,
    enabled: Boolean(workspaceId && sessionStatus === "authenticated"),
    subscriptions: workspaceId
      ? [
          {
            key: `chat-inbox:${workspaceId}`,
            topic: "inbox" as const,
          },
        ]
      : [],
    onConnected: () => {
      chatRuntime.handleSocketConnected()
    },
    onEvent: (event: ChatSocketEvent | Record<string, unknown>) => {
      chatRuntime.handleSocketEvent(event)
    },
  })

  const conversations = useMemo(() => {
    if (!runtimeState.snapshot) {
      return []
    }

    return runtimeState.snapshot.conversations.map((conversation) => ({
      ...conversation,
      unreadCount: toPendingReadAdjustedUnreadCount(
        conversation,
        runtimeState.snapshot?.pendingReads[conversation.conversationId]
      ),
    }))
  }, [runtimeState.snapshot])

  const totalUnreadCount = useMemo(
    () =>
      conversations.reduce(
        (total, conversation) => total + conversation.unreadCount,
        0
      ),
    [conversations]
  )

  const getConversation = useCallback(
    (conversationId: string) =>
      conversations.find(
        (conversation) => conversation.conversationId === conversationId
      ) ?? null,
    [conversations]
  )

  const getConversationItems = useCallback(
    (conversationId: string) => {
      if (!runtimeState.snapshot) {
        return []
      }

      return getMobileConversationItems(runtimeState.snapshot, conversationId)
    },
    [runtimeState.snapshot]
  )

  const getConversationMeta = useCallback(
    (conversationId: string) => {
      if (!runtimeState.snapshot) {
        return null
      }

      return getConversationMetaOrDefault(runtimeState.snapshot, conversationId)
    },
    [runtimeState.snapshot]
  )

  const getConversationRuntimes = useCallback(
    (conversationId: string) =>
      runtimeState.runtimeByConversationId[conversationId] ?? {},
    [runtimeState.runtimeByConversationId]
  )

  const getTypingMembers = useCallback(
    (conversationId: string): string[] => {
      const map = runtimeState.typingByConversation[conversationId]
      if (!map) return []
      const now = Date.now()
      return Object.entries(map)
        .filter(([, expireAt]) => expireAt > now)
        .map(([memberId]) => memberId)
    },
    [runtimeState.typingByConversation]
  )

  const sendTypingState = useCallback(
    (conversationId: string, state: "started" | "stopped") =>
      chatRuntime.sendTypingState(conversationId, state),
    []
  )

  const refreshInbox = useCallback(() => chatRuntime.refreshInbox(), [])

  const refreshConversation = useCallback(
    (conversationId: string) => chatRuntime.refreshConversation(conversationId),
    []
  )

  const loadOlderMessages = useCallback(
    (conversationId: string) => chatRuntime.loadOlderMessages(conversationId),
    []
  )

  const markConversationRead = useCallback(
    (
      conversationId: string,
      readUpToSequence: number,
      lastVisibleSequence?: number
    ) =>
      chatRuntime.markConversationRead(
        conversationId,
        readUpToSequence,
        lastVisibleSequence
      ),
    []
  )

  const sendMessage = useCallback(
    (conversationId: string, input: ChatComposerSendPayload) =>
      chatRuntime.sendMessage(conversationId, input),
    []
  )

  const retryMessage = useCallback(
    (clientMessageId: string) => chatRuntime.retryMessage(clientMessageId),
    []
  )

  const respondInteraction = useCallback(
    async (
      conversationId: string,
      interactionId: string,
      input: ChatInteractionResolveInput
    ) => {
      if (!workspaceId) {
        throw new Error("Workspace context is required to respond.")
      }

      const result = await api.resolveChatInteraction(
        workspaceId,
        conversationId,
        interactionId,
        input
      )
      await chatRuntime.refreshConversation(conversationId)
      return result.interaction
    },
    [workspaceId]
  )

  const createConversation = useCallback(
    (input: {
      kind: "group" | "private" | "virtual"
      title?: string
      actorIds?: string[]
      workspaceMemberIds?: string[]
      boundary?: "internal" | "external"
    }) => chatRuntime.createConversation(input),
    []
  )

  const clearLocalState = useCallback(() => chatRuntime.clearLocalState(), [])

  const value = useMemo<ChatContextValue>(
    () => ({
      status: runtimeState.status,
      syncing: runtimeState.syncing,
      error: runtimeState.error,
      workspaceMemberId: runtimeState.snapshot?.workspaceMemberId ?? null,
      clientInstanceId: runtimeState.snapshot?.clientInstanceId ?? null,
      conversations,
      totalUnreadCount,
      getConversation,
      getConversationItems,
      getConversationMeta,
      getConversationRuntimes,
      getTypingMembers,
      sendTypingState,
      refreshInbox,
      refreshConversation,
      loadOlderMessages,
      markConversationRead,
      sendMessage,
      retryMessage,
      respondInteraction,
      createConversation,
      clearLocalState,
    }),
    [
      clearLocalState,
      conversations,
      createConversation,
      getConversation,
      getConversationItems,
      getConversationMeta,
      getConversationRuntimes,
      getTypingMembers,
      sendTypingState,
      loadOlderMessages,
      markConversationRead,
      refreshConversation,
      refreshInbox,
      respondInteraction,
      retryMessage,
      runtimeState.error,
      runtimeState.snapshot?.clientInstanceId,
      runtimeState.snapshot?.workspaceMemberId,
      runtimeState.status,
      runtimeState.syncing,
      sendMessage,
      totalUnreadCount,
    ]
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat() {
  const value = useContext(ChatContext)
  if (!value) {
    throw new Error("useChat must be used inside ChatProvider.")
  }

  return value
}
