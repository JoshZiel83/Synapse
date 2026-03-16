"use client"

import { create } from "zustand"
import { api } from "@/lib/api"
import type {
  ActorRuntimeState,
  CanonicalContentBlock,
  ConversationEntityRef,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  WorkspaceFeedEventRecord,
} from "@synapse/shared"
import {
  extractText,
  normalizeCanonicalContentBlocks,
  textBlocks,
} from "@synapse/shared"

export interface GroupParticipant {
  id: string
  name: string
  role: string
  emoji?: string
  avatarUrl?: string
  title?: string
}

export interface GroupMember {
  memberId: string
  type: "actor" | "user"
  id: string
  name: string
  role?: string
  title?: string
  emoji?: string
  avatarUrl?: string
  sessionStatus?: string
}

export interface Group {
  id: string
  status: "active" | "completed" | "failed"
  participants: GroupParticipant[]
  members: GroupMember[]
  lastMessage?: {
    content: string
    role: string
    actorName?: string
    createdAt: string
  }
  unreadCount: number
  createdAt: string
  title?: string
  name?: string
  avatarUrl?: string
  permissions?: {
    canManage?: boolean
    canManageMembers?: boolean
  }
}

export interface ServerToolCall {
  type: "web_search" | "web_fetch"
  query?: string
  url?: string
  results?: { url: string; title: string; pageAge?: string }[]
}

export interface FeedMessage {
  id: string
  kind: "message" | "event"
  conversationId: string
  sequence: number
  workspaceSequence?: number
  sessionId: string
  role: string
  content: string
  contentBlocks: CanonicalContentBlock[]
  author?: ConversationEntityRef
  fromActorId?: string
  fromUserId?: string
  actorName?: string
  actorRole?: string
  actorEmoji?: string
  createdAt: string
  clientMessageId?: string
  deliveryStatus?: "sending" | "retrying" | "sent"
  toolsUsed?: string[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
  coordination?: boolean
  targetActorIds?: string[]
  targetUserIds?: string[]
  eventType?: ConversationFeedEventType
  eventPayload?: ConversationFeedEventPayloadMap[ConversationFeedEventType]
}

export type ThinkingPhase = "thinking" | "tool" | "responding" | "error"
export type ActorAvatarStatus = "idle" | ThinkingPhase
export type GroupRuntimeMap = Record<string, Record<string, ActorRuntimeState>>

export interface OutboxEntry {
  clientMessageId: string
  workspaceId: string
  conversationId: string
  contentBlocks: CanonicalContentBlock[]
  targetActorIds: string[]
  targetUserIds: string[]
  createdAt: string
  optimisticSequence: number
  status: "sending" | "retrying"
  attemptCount: number
  firstFailedAt?: string
  lastAttemptAt?: string
  lastErrorMessage?: string
}

interface ChatState {
  groups: Group[]
  selectedGroupId: string | null
  messages: FeedMessage[]
  outbox: Record<string, OutboxEntry>
  loadingGroups: boolean
  loadingMessages: boolean
  runtimeMap: GroupRuntimeMap
  runtimeSeqMap: Record<string, number>
  totalUnread: number

  loadGroups: (workspaceId: string) => Promise<void>
  selectGroup: (groupId: string | null) => void
  loadMessages: (workspaceId: string, groupId: string) => Promise<void>
  sendMessage: (
    workspaceId: string,
    groupId: string,
    contentBlocks: CanonicalContentBlock[],
    targetActorIds?: string[]
  ) => Promise<void>
  hydrateOutbox: (workspaceId: string) => void
  flushOutbox: (workspaceId: string) => void
  createGroup: (
    workspaceId: string,
    actorIds: string[],
    content?: string,
    targetActorId?: string
  ) => Promise<string>
  markRead: (workspaceId: string, groupId: string) => Promise<void>

  handleFeedItemCreated: (record: WorkspaceFeedEventRecord) => void
  handleRuntimeUpdated: (payload: {
    conversationId: string
    runtimeSeq: number
    snapshot: ActorRuntimeState
  }) => void
  handleConversationUpdated: (payload: {
    conversationId: string
    action: "created" | "profile_updated" | "cancelled"
    title?: string | null
    avatarUrl?: string | null
  }) => void
}

function normalizeContentBlocks(blocks: unknown): CanonicalContentBlock[] {
  if (Array.isArray(blocks)) {
    return normalizeCanonicalContentBlocks(blocks)
  }
  return []
}

function previewTextForItem(item: FeedMessage) {
  const text = item.content.trim()
  if (text) return text
  if (item.contentBlocks.some((block) => block.type === "file_ref"))
    return "Attachment"
  return item.kind === "event" ? "System event" : ""
}

function sortMessages(messages: FeedMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence - right.sequence
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    )
  })
}

function sortGroups(groups: Group[]) {
  return [...groups].sort((left, right) => {
    const leftAt = left.lastMessage?.createdAt || left.createdAt
    const rightAt = right.lastMessage?.createdAt || right.createdAt
    return new Date(rightAt).getTime() - new Date(leftAt).getTime()
  })
}

function sumUnread(groups: Group[]) {
  return groups.reduce((sum, group) => sum + group.unreadCount, 0)
}

function createClientMessageId() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID()
  }
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createOptimisticSequence(messages: FeedMessage[]) {
  const maxSequence = messages.reduce(
    (max, message) => Math.max(max, message.sequence),
    0
  )
  return Math.max(Date.now() * 1000, maxSequence) + 1
}

const OUTBOX_STORAGE_KEY = "chat-outbox:v2"
const OUTBOX_RETRY_DELAYS_MS = [1500, 3000, 5000, 8000, 12000, 20000, 30000]
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getOutboxRetryDelay(attemptCount: number) {
  const index = Math.max(
    0,
    Math.min(attemptCount, OUTBOX_RETRY_DELAYS_MS.length - 1)
  )
  const baseDelay = OUTBOX_RETRY_DELAYS_MS[index] || 30000
  return baseDelay + Math.round(Math.random() * 600)
}

function loadStoredOutbox(): Record<string, OutboxEntry> {
  if (typeof window === "undefined") return {}

  try {
    const raw = window.localStorage.getItem(OUTBOX_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as OutboxEntry[] | null
    if (!Array.isArray(parsed)) return {}

    return Object.fromEntries(
      parsed
        .filter((entry) => entry && typeof entry.clientMessageId === "string")
        .map((entry) => [entry.clientMessageId, entry])
    )
  } catch {
    return {}
  }
}

function persistOutbox(outbox: Record<string, OutboxEntry>) {
  if (typeof window === "undefined") return

  const entries = Object.values(outbox).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )
  window.localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries))
}

function outboxEntryToMessage(entry: OutboxEntry): FeedMessage {
  return {
    id: `temp:${entry.clientMessageId}`,
    kind: "message",
    conversationId: entry.conversationId,
    sequence: entry.optimisticSequence,
    sessionId: "",
    role: "user",
    content: extractText(entry.contentBlocks),
    contentBlocks: entry.contentBlocks,
    createdAt: entry.createdAt,
    clientMessageId: entry.clientMessageId,
    deliveryStatus: entry.status,
    targetActorIds: entry.targetActorIds,
    targetUserIds: entry.targetUserIds,
  }
}

function mergeConversationMessagesWithOutbox(
  messages: FeedMessage[],
  outbox: Record<string, OutboxEntry>,
  conversationId: string
) {
  let nextMessages = sortMessages(messages)
  const pendingEntries = Object.values(outbox)
    .filter(
      (entry) => entry.workspaceId && entry.conversationId === conversationId
    )
    .sort((left, right) => left.optimisticSequence - right.optimisticSequence)

  for (const entry of pendingEntries) {
    const hasServerMessage = nextMessages.some(
      (message) =>
        message.clientMessageId &&
        message.clientMessageId === entry.clientMessageId &&
        message.id !== `temp:${entry.clientMessageId}`
    )
    if (hasServerMessage) continue
    nextMessages = upsertFeedMessage(nextMessages, outboxEntryToMessage(entry))
  }

  return nextMessages
}

function applyOutboxToGroups(
  groups: Group[],
  outbox: Record<string, OutboxEntry>,
  runtimeMap: GroupRuntimeMap
) {
  let nextGroups = groups
  const pendingEntries = Object.values(outbox).sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )

  for (const entry of pendingEntries) {
    const optimisticMessage = outboxEntryToMessage(entry)
    nextGroups = sortGroups(
      nextGroups.map((group) =>
        group.id === entry.conversationId &&
        (!group.lastMessage ||
          new Date(entry.createdAt).getTime() >=
            new Date(group.lastMessage.createdAt).getTime())
          ? applyRuntimeMapToGroup(
              applyFeedMessageToGroup(group, optimisticMessage, true),
              runtimeMap[group.id]
            )
          : group
      )
    )
  }

  return nextGroups
}

function upsertFeedMessage(messages: FeedMessage[], item: FeedMessage) {
  const byIdIndex = messages.findIndex((message) => message.id === item.id)
  if (byIdIndex >= 0) {
    const next = [...messages]
    next[byIdIndex] = item
    return sortMessages(next)
  }

  if (item.clientMessageId) {
    const optimisticIndex = messages.findIndex(
      (message) => message.clientMessageId === item.clientMessageId
    )
    if (optimisticIndex >= 0) {
      const next = [...messages]
      next[optimisticIndex] = item
      return sortMessages(next)
    }
  }

  return sortMessages([...messages, item])
}

function feedItemToMessage(item: ConversationFeedItem): FeedMessage {
  if (item.kind === "event") {
    const content = item.fallbackText || ""
    return {
      id: item.itemId,
      kind: "event",
      conversationId: item.conversationId,
      sequence: item.sequence,
      workspaceSequence: item.workspaceSequence,
      sessionId: item.sessionId || "",
      role: "system",
      content,
      contentBlocks: textBlocks(content),
      author: item.author,
      fromActorId: item.author?.actorId,
      fromUserId: item.author?.userId,
      actorName: item.author?.name,
      actorRole: item.author?.role,
      actorEmoji: item.author?.avatarEmoji,
      createdAt: item.createdAt,
      deliveryStatus: "sent",
      eventType: item.eventType,
      eventPayload: item.payload,
    }
  }

  const targetActorIds = item.targets
    .filter((target) => target.memberType === "actor" && target.actorId)
    .map((target) => target.actorId!)
  const targetUserIds = item.targets
    .filter((target) => target.memberType === "user" && target.userId)
    .map((target) => target.userId!)
  const metadata = item.metadata || {}

  return {
    id: item.itemId,
    kind: "message",
    conversationId: item.conversationId,
    sequence: item.sequence,
    workspaceSequence: item.workspaceSequence,
    sessionId: item.sessionId || "",
    role: item.role,
    content: item.content,
    contentBlocks: normalizeContentBlocks(item.contentBlocks),
    author: item.author,
    fromActorId: item.author?.actorId,
    fromUserId: item.author?.userId,
    actorName:
      item.author?.memberType === "actor" ? item.author.name : undefined,
    actorRole: item.author?.role,
    actorEmoji: item.author?.avatarEmoji,
    createdAt: item.createdAt,
    clientMessageId: item.clientMessageId,
    deliveryStatus: "sent",
    toolsUsed: metadata.toolsUsed as string[] | undefined,
    serverToolCalls: metadata.serverToolCalls as ServerToolCall[] | undefined,
    citationSources: metadata.citationSources as
      | Record<string, { url: string; title: string }>
      | undefined,
    coordination: Boolean(metadata.coordination),
    targetActorIds,
    targetUserIds,
  }
}

function applyMemberJoined(
  group: Group,
  payload: ConversationFeedEventPayloadMap["member_joined"]
) {
  const nextMembers = [...group.members]
  const nextParticipants = [...group.participants]

  for (const member of payload.members) {
    const id = member.actorId || member.userId
    if (!id) continue

    const normalizedMember: GroupMember = {
      memberId: member.memberId,
      type: member.memberType === "user" ? "user" : "actor",
      id,
      name: member.name || "Unknown",
      title: member.title,
      role: member.role,
      emoji: member.avatarEmoji,
      avatarUrl: member.avatarUrl,
    }

    if (
      !nextMembers.some(
        (existing) => existing.memberId === normalizedMember.memberId
      )
    ) {
      nextMembers.push(normalizedMember)
    }

    if (
      normalizedMember.type === "actor" &&
      !nextParticipants.some(
        (participant) => participant.id === normalizedMember.id
      )
    ) {
      nextParticipants.push({
        id: normalizedMember.id,
        name: normalizedMember.name,
        role: normalizedMember.role || "specialist",
        emoji: normalizedMember.emoji,
        avatarUrl: normalizedMember.avatarUrl,
        title: normalizedMember.title,
      })
    }
  }

  return { ...group, members: nextMembers, participants: nextParticipants }
}

function applyMemberRemoved(
  group: Group,
  payload:
    | ConversationFeedEventPayloadMap["member_kicked"]
    | ConversationFeedEventPayloadMap["member_left"]
) {
  const removedActorIds = new Set(
    payload.members
      .map((member) => member.actorId)
      .filter((value): value is string => Boolean(value))
  )
  const removedUserIds = new Set(
    payload.members
      .map((member) => member.userId)
      .filter((value): value is string => Boolean(value))
  )

  return {
    ...group,
    participants: group.participants.filter(
      (participant) => !removedActorIds.has(participant.id)
    ),
    members: group.members.filter((member) =>
      member.type === "actor"
        ? !removedActorIds.has(member.id)
        : !removedUserIds.has(member.id)
    ),
  }
}

function applyActorPatch(
  group: Group,
  actorId: string,
  patch: Partial<GroupMember & GroupParticipant>
) {
  return {
    ...group,
    participants: group.participants.map((participant) =>
      participant.id === actorId ? { ...participant, ...patch } : participant
    ),
    members: group.members.map((member) =>
      member.type === "actor" && member.id === actorId
        ? { ...member, ...patch }
        : member
    ),
  }
}

function applyFeedMessageToGroup(
  group: Group,
  item: FeedMessage,
  isSelected: boolean
) {
  let nextGroup: Group = {
    ...group,
    lastMessage: {
      content: previewTextForItem(item),
      role: item.role,
      actorName: item.actorName,
      createdAt: item.createdAt,
    },
    unreadCount: isSelected ? group.unreadCount : group.unreadCount + 1,
  }

  if (item.kind !== "event" || !item.eventType || !item.eventPayload) {
    return nextGroup
  }

  switch (item.eventType) {
    case "member_joined":
      nextGroup = applyMemberJoined(
        nextGroup,
        item.eventPayload as ConversationFeedEventPayloadMap["member_joined"]
      )
      break
    case "member_kicked":
    case "member_left":
      nextGroup = applyMemberRemoved(
        nextGroup,
        item.eventPayload as
          | ConversationFeedEventPayloadMap["member_kicked"]
          | ConversationFeedEventPayloadMap["member_left"]
      )
      break
    case "actor_renamed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_renamed"]
      if (payload.actor.actorId) {
        nextGroup = applyActorPatch(nextGroup, payload.actor.actorId, {
          name: payload.newName,
        })
      }
      break
    }
    case "actor_avatar_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_avatar_changed"]
      if (payload.actor.actorId) {
        nextGroup = applyActorPatch(nextGroup, payload.actor.actorId, {
          emoji: payload.newAvatarEmoji,
        })
      }
      break
    }
    case "actor_version_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_version_changed"]
      if (payload.actor.actorId) {
        nextGroup = applyActorPatch(nextGroup, payload.actor.actorId, {
          name: payload.actor.name,
          avatarUrl: payload.actor.avatarUrl,
          emoji: payload.actor.avatarEmoji,
        })
      }
      break
    }
    default:
      break
  }

  return nextGroup
}

export function runtimePhaseToBadgePhase(
  runtime?: ActorRuntimeState
): ThinkingPhase | undefined {
  if (!runtime) return undefined
  if (runtime.health === "error" || runtime.phase === "error") return "error"
  if (runtime.phase === "tool") return "tool"
  if (runtime.phase === "responding") return "responding"
  if (
    runtime.phase === "thinking" ||
    runtime.laneState === "running" ||
    runtime.laneState === "queued"
  ) {
    return "thinking"
  }
  return undefined
}

export function runtimeToAvatarStatus(
  runtime?: ActorRuntimeState
): ActorAvatarStatus | undefined {
  if (!runtime) return undefined
  return runtimePhaseToBadgePhase(runtime) || "idle"
}

function applyRuntimeToGroupMembers(
  group: Group,
  runtime: ActorRuntimeState
): Group {
  return {
    ...group,
    members: group.members.map((member) =>
      member.type === "actor" && member.id === runtime.actorId
        ? { ...member, sessionStatus: runtime.laneState }
        : member
    ),
  }
}

function deriveGroupStatus(
  group: Group,
  runtimesForGroup?: Record<string, ActorRuntimeState>
) {
  const actorMembers = group.members.filter((member) => member.type === "actor")
  if (actorMembers.length === 0) return "completed" as const
  const hasOpenLane = actorMembers.some((member) => {
    const runtime = runtimesForGroup?.[member.id]
    const laneState = runtime?.laneState || member.sessionStatus
    return laneState !== "closed"
  })
  return hasOpenLane ? ("active" as const) : ("completed" as const)
}

function applyRuntimeMapToGroup(
  group: Group,
  runtimesForGroup?: Record<string, ActorRuntimeState>
): Group {
  if (!runtimesForGroup) {
    return {
      ...group,
      status: deriveGroupStatus(group, undefined),
    }
  }

  let nextGroup = group
  for (const runtime of Object.values(runtimesForGroup)) {
    nextGroup = applyRuntimeToGroupMembers(nextGroup, runtime)
  }

  return {
    ...nextGroup,
    status: deriveGroupStatus(nextGroup, runtimesForGroup),
  }
}

function applyFeedItemToRuntimeMap(
  runtimeByActor: Record<string, ActorRuntimeState>,
  item: FeedMessage
) {
  let nextRuntimeByActor = runtimeByActor

  if (
    item.kind === "message" &&
    item.fromActorId &&
    runtimeByActor[item.fromActorId]
  ) {
    nextRuntimeByActor = {
      ...runtimeByActor,
      [item.fromActorId]: {
        ...runtimeByActor[item.fromActorId],
        actorName: item.actorName || runtimeByActor[item.fromActorId].actorName,
        updatedAt: item.createdAt,
      },
    }
  }

  if (item.kind !== "event" || !item.eventType || !item.eventPayload) {
    return nextRuntimeByActor
  }

  switch (item.eventType) {
    case "member_kicked":
    case "member_left": {
      const payload = item.eventPayload as
        | ConversationFeedEventPayloadMap["member_kicked"]
        | ConversationFeedEventPayloadMap["member_left"]
      const removedActorIds = payload.members
        .map((member) => member.actorId)
        .filter((value): value is string => Boolean(value))
      if (removedActorIds.length === 0) return nextRuntimeByActor
      const next = { ...nextRuntimeByActor }
      for (const actorId of removedActorIds) {
        delete next[actorId]
      }
      return next
    }
    case "actor_renamed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_renamed"]
      const actorId = payload.actor.actorId
      if (!actorId || !nextRuntimeByActor[actorId]) return nextRuntimeByActor
      return {
        ...nextRuntimeByActor,
        [actorId]: {
          ...nextRuntimeByActor[actorId],
          actorName: payload.newName,
          updatedAt: item.createdAt,
        },
      }
    }
    case "actor_version_changed": {
      const payload =
        item.eventPayload as ConversationFeedEventPayloadMap["actor_version_changed"]
      const actorId = payload.actor.actorId
      if (!actorId || !nextRuntimeByActor[actorId]) return nextRuntimeByActor
      return {
        ...nextRuntimeByActor,
        [actorId]: {
          ...nextRuntimeByActor[actorId],
          actorName:
            payload.actor.name || nextRuntimeByActor[actorId].actorName,
          updatedAt: item.createdAt,
        },
      }
    }
    default:
      return nextRuntimeByActor
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  groups: [],
  selectedGroupId: null,
  messages: [],
  outbox: {},
  loadingGroups: false,
  loadingMessages: false,
  runtimeMap: {},
  runtimeSeqMap: {},
  totalUnread: 0,

  loadGroups: async (workspaceId) => {
    set({ loadingGroups: true })
    try {
      const res = await api.getGroups(workspaceId)
      const incomingGroups = Array.isArray(res?.groups)
        ? (res.groups as Group[])
        : []
      const serverRuntime = (res?.runtimeMap || {}) as GroupRuntimeMap

      set((state) => {
        const runtimeMap = { ...state.runtimeMap, ...serverRuntime }
        const groups = applyOutboxToGroups(
          sortGroups(
            incomingGroups.map((group) =>
              applyRuntimeMapToGroup(group, runtimeMap[group.id])
            )
          ),
          state.outbox,
          runtimeMap
        )
        const nextSelectedGroupId =
          state.selectedGroupId &&
          groups.some((group) => group.id === state.selectedGroupId)
            ? state.selectedGroupId
            : null

        return {
          groups,
          runtimeMap,
          totalUnread: sumUnread(groups),
          loadingGroups: false,
          ...(nextSelectedGroupId === state.selectedGroupId
            ? {}
            : {
                selectedGroupId: nextSelectedGroupId,
                messages: [],
              }),
        }
      })
    } catch (err) {
      console.error("Failed to load groups:", err)
      set({ loadingGroups: false })
    }
  },

  selectGroup: (groupId) => {
    if (get().selectedGroupId === groupId) return
    set({ selectedGroupId: groupId, messages: [] })
  },

  loadMessages: async (workspaceId, groupId) => {
    set({ loadingMessages: true })
    try {
      const res = await api.getGroupMessages(workspaceId, groupId, 100)
      const fetchedMessages = sortMessages(
        (res?.items || []).map(feedItemToMessage)
      )

      set((state) => {
        if (state.selectedGroupId !== groupId) {
          return { loadingMessages: false }
        }

        return {
          messages: mergeConversationMessagesWithOutbox(
            fetchedMessages,
            state.outbox,
            groupId
          ),
          loadingMessages: false,
        }
      })
    } catch (err) {
      console.error("Failed to load messages:", err)
      set({ loadingMessages: false })
    }
  },

  sendMessage: async (workspaceId, groupId, contentBlocks, targetActorIds) => {
    const clientMessageId = createClientMessageId()
    const createdAt = new Date().toISOString()
    const optimisticSequence = createOptimisticSequence(get().messages)
    const entry: OutboxEntry = {
      clientMessageId,
      workspaceId,
      conversationId: groupId,
      contentBlocks,
      targetActorIds: targetActorIds || [],
      targetUserIds: [],
      createdAt,
      optimisticSequence,
      status: "sending",
      attemptCount: 0,
    }
    const optimisticMessage = outboxEntryToMessage(entry)

    set((state) => {
      const outbox = {
        ...state.outbox,
        [clientMessageId]: entry,
      }
      const groups = sortGroups(
        state.groups.map((group) =>
          group.id === groupId
            ? applyRuntimeMapToGroup(
                applyFeedMessageToGroup(group, optimisticMessage, true),
                state.runtimeMap[groupId]
              )
            : group
        )
      )

      persistOutbox(outbox)

      return {
        outbox,
        messages:
          state.selectedGroupId === groupId
            ? upsertFeedMessage(state.messages, optimisticMessage)
            : state.messages,
        groups,
        totalUnread: sumUnread(groups),
      }
    })

    scheduleOutboxSend(clientMessageId, 0)
  },

  hydrateOutbox: (workspaceId) => {
    const storedOutbox = loadStoredOutbox()
    set((state) => {
      const groups = applyOutboxToGroups(
        state.groups,
        storedOutbox,
        state.runtimeMap
      )
      return {
        outbox: storedOutbox,
        groups,
        messages: state.selectedGroupId
          ? mergeConversationMessagesWithOutbox(
              state.messages,
              storedOutbox,
              state.selectedGroupId
            )
          : state.messages,
        totalUnread: sumUnread(groups),
      }
    })
    get().flushOutbox(workspaceId)
  },

  flushOutbox: (workspaceId) => {
    for (const entry of Object.values(get().outbox)) {
      if (entry.workspaceId !== workspaceId) continue
      scheduleOutboxSend(entry.clientMessageId, 0)
    }
  },

  createGroup: async (workspaceId, actorIds, content, targetActorId) => {
    const res = await api.createGroup(
      workspaceId,
      actorIds,
      content,
      targetActorId
    )
    const groupId = res.id || res.sessionId
    await get().loadGroups(workspaceId)
    return groupId
  },

  markRead: async (workspaceId, groupId) => {
    try {
      await api.markGroupRead(workspaceId, groupId)
      set((state) => {
        const groups = state.groups.map((group) =>
          group.id === groupId ? { ...group, unreadCount: 0 } : group
        )
        return {
          groups,
          totalUnread: sumUnread(groups),
        }
      })
    } catch (err) {
      console.error("Failed to mark read:", err)
    }
  },

  handleFeedItemCreated: (record) => {
    const item = record.item.workspaceSequence
      ? record.item
      : { ...record.item, workspaceSequence: record.workspaceSequence }
    const message = feedItemToMessage(item)

    set((state) => {
      const nextOutbox = { ...state.outbox }
      if (message.clientMessageId && nextOutbox[message.clientMessageId]) {
        delete nextOutbox[message.clientMessageId]
        const timer = retryTimers.get(message.clientMessageId)
        if (timer) {
          clearTimeout(timer)
          retryTimers.delete(message.clientMessageId)
        }
      }

      const isSelected = state.selectedGroupId === message.conversationId
      const currentRuntime = state.runtimeMap[message.conversationId] || {}
      const nextRuntime = applyFeedItemToRuntimeMap(currentRuntime, message)
      const runtimeMap =
        nextRuntime === currentRuntime
          ? state.runtimeMap
          : { ...state.runtimeMap, [message.conversationId]: nextRuntime }
      const groups = applyOutboxToGroups(
        sortGroups(
          state.groups.map((group) =>
            group.id === message.conversationId
              ? applyRuntimeMapToGroup(
                  applyFeedMessageToGroup(group, message, isSelected),
                  runtimeMap[message.conversationId]
                )
              : group
          )
        ),
        nextOutbox,
        runtimeMap
      )

      persistOutbox(nextOutbox)

      return {
        messages: isSelected
          ? mergeConversationMessagesWithOutbox(
              upsertFeedMessage(state.messages, message),
              nextOutbox,
              message.conversationId
            )
          : state.messages,
        outbox: nextOutbox,
        groups,
        runtimeMap,
        totalUnread: sumUnread(groups),
      }
    })
  },

  handleRuntimeUpdated: (payload) => {
    set((state) => {
      const currentSeq = state.runtimeSeqMap[payload.conversationId] || 0
      if (payload.runtimeSeq <= currentSeq) {
        return state
      }

      const nextRuntimeForGroup = {
        ...(state.runtimeMap[payload.conversationId] || {}),
        [payload.snapshot.actorId]: payload.snapshot,
      }
      const runtimeMap = {
        ...state.runtimeMap,
        [payload.conversationId]: nextRuntimeForGroup,
      }
      const groups = state.groups.map((group) =>
        group.id === payload.conversationId
          ? applyRuntimeMapToGroup(group, nextRuntimeForGroup)
          : group
      )

      return {
        groups,
        runtimeMap,
        runtimeSeqMap: {
          ...state.runtimeSeqMap,
          [payload.conversationId]: payload.runtimeSeq,
        },
      }
    })
  },

  handleConversationUpdated: (payload) => {
    set((state) => {
      const hasGroup = state.groups.some(
        (group) => group.id === payload.conversationId
      )
      if (!hasGroup) return state

      const groups = sortGroups(
        state.groups.map((group) => {
          if (group.id !== payload.conversationId) return group

          let nextGroup = group
          if (payload.action === "profile_updated") {
            const nextTitle = payload.title?.trim() || group.title || group.name
            nextGroup = {
              ...nextGroup,
              title: nextTitle,
              name: nextTitle,
              avatarUrl:
                payload.avatarUrl === undefined
                  ? group.avatarUrl
                  : payload.avatarUrl || undefined,
            }
          }

          if (payload.action === "cancelled") {
            nextGroup = {
              ...nextGroup,
              status: "completed",
            }
          }

          return applyRuntimeMapToGroup(
            nextGroup,
            state.runtimeMap[payload.conversationId]
          )
        })
      )

      return { groups }
    })
  },
}))

function scheduleOutboxSend(clientMessageId: string, delayMs: number) {
  const existingTimer = retryTimers.get(clientMessageId)
  if (existingTimer) {
    clearTimeout(existingTimer)
  }

  const timer = setTimeout(
    () => {
      retryTimers.delete(clientMessageId)
      void processOutboxEntry(clientMessageId)
    },
    Math.max(0, delayMs)
  )

  retryTimers.set(clientMessageId, timer)
}

async function processOutboxEntry(clientMessageId: string) {
  const state = useChatStore.getState()
  const entry = state.outbox[clientMessageId]
  if (!entry) {
    return
  }

  const lastAttemptAt = new Date().toISOString()
  useChatStore.setState((currentState) => {
    const currentEntry = currentState.outbox[clientMessageId]
    if (!currentEntry) return currentState

    const nextOutbox = {
      ...currentState.outbox,
      [clientMessageId]: {
        ...currentEntry,
        attemptCount: currentEntry.attemptCount + 1,
        lastAttemptAt,
      },
    }
    persistOutbox(nextOutbox)
    return {
      outbox: nextOutbox,
      messages:
        currentState.selectedGroupId === currentEntry.conversationId
          ? mergeConversationMessagesWithOutbox(
              currentState.messages,
              nextOutbox,
              currentEntry.conversationId
            )
          : currentState.messages,
    }
  })

  try {
    const result = await api.sendGroupMessage(
      entry.workspaceId,
      entry.conversationId,
      entry.contentBlocks,
      entry.clientMessageId,
      entry.targetActorIds,
      entry.targetUserIds
    )

    if (result?.item) {
      useChatStore.getState().handleFeedItemCreated({
        workspaceSequence: result.item.workspaceSequence || 0,
        item: result.item,
      })
      return
    }

    throw new Error("Message send did not return an item")
  } catch (error) {
    const failedAt = new Date().toISOString()
    let retryDelay = 30000

    useChatStore.setState((currentState) => {
      const currentEntry = currentState.outbox[clientMessageId]
      if (!currentEntry) return currentState

      retryDelay = getOutboxRetryDelay(currentEntry.attemptCount)
      const nextEntry: OutboxEntry = {
        ...currentEntry,
        status: "retrying",
        firstFailedAt: currentEntry.firstFailedAt || failedAt,
        lastErrorMessage:
          error instanceof Error ? error.message : "Failed to send message",
      }
      const nextOutbox = {
        ...currentState.outbox,
        [clientMessageId]: nextEntry,
      }
      persistOutbox(nextOutbox)

      return {
        outbox: nextOutbox,
        messages:
          currentState.selectedGroupId === nextEntry.conversationId
            ? mergeConversationMessagesWithOutbox(
                currentState.messages,
                nextOutbox,
                nextEntry.conversationId
              )
            : currentState.messages,
      }
    })

    scheduleOutboxSend(clientMessageId, retryDelay)
  }
}
