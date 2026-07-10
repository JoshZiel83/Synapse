import test from "node:test"
import assert from "node:assert/strict"
import {
  ChatBootstrapViewSchema,
  ChatClientInstanceViewSchema,
  ChatConversationEnvelopeViewSchema,
  ChatConversationMessagesViewSchema,
  ChatDedupCountersViewSchema,
  ChatParticipantRemovalViewSchema,
  ChatReadWatermarkViewSchema,
  ChatRuntimeTurnDetailViewSchema,
  ChatSendMessageViewSchema,
  ChatSyncViewSchema,
  ChatTaskRespondViewSchema,
} from "@synapse/shared/schemas"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  ACTOR_RUNTIME_HEALTH,
  AUTOMATION_RULE_CATEGORY,
  AUTOMATION_TRIGGER_SOURCE_KINDS,
  CHAT_MEMBERSHIP_UPDATE_REASON,
  CHAT_PARTICIPANT_REMOVAL_STATE,
  CONVERSATION_EVENT_CONTEXT_POLICY,
  CONVERSATION_EVENT_TIMELINE_POLICY,
  CONVERSATION_FEED_EVENT_TYPE,
  CONVERSATION_FEED_MESSAGE_TYPE,
  CONVERSATION_ITEM_ROLE,
  CONVERSATION_ITEM_SCOPE,
  CONVERSATION_ITEM_SURFACE,
  CONVERSATION_ITEM_TYPE,
  CONVERSATION_KIND,
  CONVERSATION_MESSAGE_TRANSPORT_DIRECTION,
  CONVERSATION_MESSAGE_SUBTYPE,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE,
  CONVERSATION_STATUS,
  REMOTE_AGENT_RUNTIME_STATE,
  TASK_REQUEST_KIND,
} from "@synapse/shared"
import type {
  ChatConversationItem,
  ChatConversationView,
  ChatSyncEvent,
  ChatSyncEventType,
  TaskSummary,
} from "@synapse/shared"
import {
  presentChatBootstrap,
  presentChatClientInstanceRegistration,
  presentChatConversationCreate,
  presentChatConversationRecord,
  presentChatConversationReadWatermark,
  presentChatConversationSendMessage,
  presentChatSync,
  type ChatConversationRecord,
} from "./presenter.js"

const now = assertIsoInstant("2026-06-13T00:00:00.000Z")
const nowDate = new Date(now)

const conversationRecord: ChatConversationRecord = {
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  baseTitle: "Conversation",
  kind: CONVERSATION_KIND.GROUP,
  isIm: false,
  unreadCount: 0,
  muted: false,
  archived: false,
  updatedAt: nowDate,
  createdAt: nowDate,
  participants: [],
  viewerWorkspaceMemberId: "member-1",
  viewerConversationRole: "member",
}
const conversation: ChatConversationView =
  presentChatConversationRecord(conversationRecord)
const item: ChatConversationItem = {
  id: "item-1",
  conversationId: conversation.conversationId,
  sequence: 1,
  itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
  role: CONVERSATION_ITEM_ROLE.USER,
  scope: CONVERSATION_ITEM_SCOPE.SHARED,
  surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
  content: "hello",
  contentBlocks: [],
  metadata: {},
  createdAt: now,
  subtype: CONVERSATION_MESSAGE_SUBTYPE.USER,
}
const conversationUpsertEventType =
  "conversation.upsert" satisfies ChatSyncEventType
const event: ChatSyncEvent<typeof conversationUpsertEventType> = {
  syncSeq: 1,
  memberSeq: 1,
  workspaceId: conversation.workspaceId,
  workspaceMemberId: "member-1",
  conversationId: conversation.conversationId,
  eventType: conversationUpsertEventType,
  payload: { conversation },
  occurredAt: now,
}

const requester = {
  participantId: "participant-1",
  participantType: "workspace_member" as const,
  workspaceMemberId: "member-1",
  name: "Member",
}

const taskBase = {
  id: "task-1",
  workspaceId: conversation.workspaceId,
  conversationId: conversation.conversationId,
  itemId: item.id,
  lifecycleStatus: "input_required" as const,
  revision: 1,
  requester,
  createdAt: now,
  updatedAt: now,
  viewerCanResolve: true,
}

const userInputTask: TaskSummary = {
  ...taskBase,
  kind: TASK_REQUEST_KIND.USER_INPUT,
  target: requester,
  userInput: {
    title: "Need input",
    instructions: "Pick one option",
    questions: [
      {
        id: "question-1",
        header: "Choice",
        type: "single_select",
        prompt: "Pick one",
        required: true,
        options: [{ id: "a", label: "A" }],
        allowOther: false,
      },
    ],
  },
}

const planApprovalTask: TaskSummary = {
  ...taskBase,
  kind: TASK_REQUEST_KIND.PLAN_APPROVAL,
  lifecycleStatus: "working",
  target: requester,
  planApproval: {
    title: "Approve plan",
    summary: "Plan summary",
    planMarkdown: "# Plan\n- Step",
    checklist: [{ step: "Step", status: "pending" }],
  },
}

const runtimeAuthorizationTask: TaskSummary = {
  ...taskBase,
  kind: TASK_REQUEST_KIND.RUNTIME_AUTHORIZATION,
  lifecycleStatus: "auth_required",
  runtimeAuthorization: {
    requestedToolName: "fs.write",
    runtimeToolStableKey: "filesystem.write",
    requestedAction: {
      capability: "filesystem",
      toolName: "fs.write",
      summary: "Write a file",
      filesystem: {
        access: "write",
        pathPrefixes: ["/workspace"],
        scopeIsPushdown: true,
      },
    },
    reason: "Need to write output",
    runtimeId: "device-1",
    deviceDisplayName: "Local device",
    runtimeCapabilityId: "capability-1",
    exposureId: "exposure-1",
    exposureDisplayName: "Filesystem",
    grantOptions: [
      {
        id: "grant-option-1",
        summary: "Workspace write",
        grantSpec: {
          capability: "filesystem",
          filesystem: {
            access: "write",
            pathPrefixes: ["/workspace"],
          },
        },
      },
    ],
    availablePresets: ["once", "workspace"],
    requestMode: "blocking",
  },
}

const taskRequestedItem: ChatConversationItem = {
  id: "event-item-1",
  conversationId: conversation.conversationId,
  sequence: 2,
  itemType: CONVERSATION_ITEM_TYPE.EVENT,
  role: CONVERSATION_ITEM_ROLE.SYSTEM,
  scope: CONVERSATION_ITEM_SCOPE.SHARED,
  surface: CONVERSATION_ITEM_SURFACE.VISIBLE,
  content: "Task requested",
  contentBlocks: [],
  metadata: {},
  createdAt: now,
  subtype: CONVERSATION_FEED_EVENT_TYPE.TASK_REQUESTED,
  eventPayload: {
    task: userInputTask,
  },
}

test("presentChatClientInstanceRegistration output parses ChatClientInstanceViewSchema", () => {
  const parsed = ChatClientInstanceViewSchema.safeParse(
    presentChatClientInstanceRegistration({
      clientInstanceId: "client-1",
      workspaceMemberId: "member-1",
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentChatConversationCreate output parses ChatConversationEnvelopeViewSchema", () => {
  const parsed = ChatConversationEnvelopeViewSchema.safeParse(
    presentChatConversationCreate({ conversation: conversationRecord })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ChatConversationEnvelopeViewSchema validates conversation view details", () => {
  assert.equal(conversation.status, CONVERSATION_STATUS.COMPLETED)

  const parsed = ChatConversationEnvelopeViewSchema.safeParse({
    conversation: {
      ...conversation,
      participants: [
        {
          participantId: "participant-1",
          conversationId: conversation.conversationId,
          participantType: "workspace_member",
          workspaceMemberId: "member-1",
          name: "Member",
          role: "member",
          roleKey: "member",
          state: "active",
          metadata: {},
          joinedAt: now,
          sessionStatus: "running",
        },
      ],
      presentation: {
        ...conversation.presentation,
        subtitle: "Group chat",
        peerParticipantId: "participant-1",
      },
      viewerParticipantId: "participant-1",
      lastItem: {
        itemId: item.id,
        sequence: item.sequence,
        itemType: item.itemType,
        subtype: item.subtype,
        previewText: "hello",
        authorParticipantId: "participant-1",
        author: {
          participantId: "participant-1",
          participantType: "workspace_member",
          workspaceMemberId: "member-1",
          name: "Member",
        },
        createdAt: now,
      },
    },
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const remoteAgentRuntime = ChatConversationEnvelopeViewSchema.safeParse({
    conversation: {
      ...conversation,
      participants: [
        {
          participantId: "participant-remote-agent",
          conversationId: conversation.conversationId,
          participantType: "remote_agent",
          remoteAgentId: "remote-agent-1",
          name: "Agent",
          role: "remote_agent",
          roleKey: "remote_agent",
          state: "active",
          metadata: {},
          joinedAt: now,
          sessionStatus: REMOTE_AGENT_RUNTIME_STATE.WAITING_USER_INPUT,
        },
      ],
    },
  })
  assert.ok(
    remoteAgentRuntime.success,
    JSON.stringify(remoteAgentRuntime.error?.issues)
  )

  const invalidSessionStatus = ChatConversationEnvelopeViewSchema.safeParse({
    conversation: {
      ...conversation,
      participants: [
        {
          participantId: "participant-1",
          conversationId: conversation.conversationId,
          participantType: "workspace_member",
          workspaceMemberId: "member-1",
          name: "Member",
          role: "member",
          roleKey: "member",
          state: "active",
          metadata: {},
          joinedAt: now,
          sessionStatus: "sleeping",
        },
      ],
    },
  })
  assert.equal(invalidSessionStatus.success, false)

  const invalid = ChatConversationEnvelopeViewSchema.safeParse({
    conversation: {
      ...conversation,
      status: "archived",
    },
  })
  assert.equal(invalid.success, false)
})

test("presentChatBootstrap output parses ChatBootstrapViewSchema", () => {
  const parsed = ChatBootstrapViewSchema.safeParse(
    presentChatBootstrap({
      workspaceMemberId: "member-1",
      clientInstanceRequired: true,
      conversations: [conversationRecord],
      nextInboxCursor: 1,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentChatSync output parses ChatSyncViewSchema", () => {
  const parsed = ChatSyncViewSchema.safeParse(
    presentChatSync({
      events: [event],
      nextCursor: 1,
      hasMore: false,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ChatSyncViewSchema validates discriminated sync event payloads", () => {
  const parsed = ChatSyncViewSchema.safeParse({
    events: [
      {
        syncSeq: 2,
        memberSeq: 2,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        conversationId: conversation.conversationId,
        eventType: "conversation.membership.updated",
        payload: {
          conversationId: conversation.conversationId,
          selfState: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
          reason: CHAT_MEMBERSHIP_UPDATE_REASON.ADDED,
          participants: [
            {
              participantId: "participant-1",
              conversationId: conversation.conversationId,
              participantType: "workspace_member",
              workspaceMemberId: "member-1",
              name: "Member",
              roleKey: "member",
              state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
              metadata: {},
              joinedAt: now,
            },
          ],
        },
        occurredAt: now,
      },
      {
        syncSeq: 3,
        memberSeq: 3,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        eventType: "remote_agent.runtime_updated",
        payload: {
          remoteAgentId: "remote-agent-1",
          snapshot: {
            remoteAgentId: "remote-agent-1",
            runtimeKind: "codex",
            state: "idle",
            pendingConversationCount: 0,
            unreadDeliveryCount: 0,
            updatedAt: now,
          },
        },
        occurredAt: now,
      },
      {
        syncSeq: 4,
        memberSeq: 4,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        conversationId: conversation.conversationId,
        itemId: taskRequestedItem.id,
        eventType: "conversation.item.created",
        payload: {
          conversationId: conversation.conversationId,
          item: taskRequestedItem,
        },
        occurredAt: now,
      },
      {
        syncSeq: 5,
        memberSeq: 5,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        conversationId: conversation.conversationId,
        itemId: item.id,
        eventType: "task.updated",
        payload: {
          conversationId: conversation.conversationId,
          taskId: userInputTask.id,
          itemId: item.id,
          task: userInputTask,
        },
        occurredAt: now,
      },
    ],
    nextCursor: 5,
    hasMore: false,
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalidMembershipReason = ChatSyncViewSchema.safeParse({
    events: [
      {
        syncSeq: 2,
        memberSeq: 2,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        conversationId: conversation.conversationId,
        eventType: "conversation.membership.updated",
        payload: {
          conversationId: conversation.conversationId,
          selfState: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
          reason: "not_a_reason",
          participants: [],
        },
        occurredAt: now,
      },
    ],
    nextCursor: 2,
    hasMore: false,
  })
  assert.equal(invalidMembershipReason.success, false)

  const invalid = ChatSyncViewSchema.safeParse({
    events: [
      {
        syncSeq: 2,
        memberSeq: 2,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        eventType: "conversation.read.updated",
        payload: {
          conversationId: conversation.conversationId,
          workspaceMemberId: "member-1",
          participantId: "participant-1",
          readWatermarkSequence: "1",
          lastReadAt: now,
        },
        occurredAt: now,
      },
    ],
    nextCursor: 2,
    hasMore: false,
  })
  assert.equal(invalid.success, false)
})

test("presentChatConversationSendMessage output parses ChatSendMessageViewSchema", () => {
  const parsed = ChatSendMessageViewSchema.safeParse(
    presentChatConversationSendMessage({ item })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      sequence: "1",
    },
  })
  assert.equal(invalid.success, false)
})

test("ChatConversationItemSchema validates transport context and deliveries", () => {
  const parsed = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      transport: {
        direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.INBOUND,
        transportKind: "feishu",
        transportAccountId: "transport-account-1",
        endpointType: "group",
        endpointExternalId: "chat-1",
        externalMessageId: "message-1",
      },
      transportDeliveries: [
        {
          linkId: "link-1",
          transportKind: "feishu",
          direction: CONVERSATION_MESSAGE_TRANSPORT_DIRECTION.OUTBOUND,
          deliveryStatus: "sent",
          endpointType: "group",
          endpointExternalId: "chat-1",
          endpointDisplayName: "Ops",
          externalMessageId: "message-2",
          deliveredAt: now,
          metadata: { retryCount: 0 },
        },
      ],
    },
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      transport: {
        unknown: "legacy passthrough",
      },
    },
  })
  assert.equal(invalid.success, false)
})

test("ChatConversationItemSchema validates finite item subtypes", () => {
  const validMessage = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
      replyTo: {
        itemId: "missing-item",
        itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
        subtype: CONVERSATION_REPLY_REF_SPECIAL_SUBTYPE.UNAVAILABLE,
        previewText: "",
        previewBlocks: [],
        isUnavailable: true,
      },
    },
  })
  assert.ok(validMessage.success, JSON.stringify(validMessage.error?.issues))

  const validSummary = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      itemType: CONVERSATION_ITEM_TYPE.SUMMARY,
      subtype: CONVERSATION_FEED_MESSAGE_TYPE.SUMMARY,
    },
  })
  assert.ok(validSummary.success, JSON.stringify(validSummary.error?.issues))

  const invalidMessageSubtype = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      subtype: "legacy-message",
    },
  })
  assert.equal(invalidMessageSubtype.success, false)

  const invalidSummarySubtype = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      itemType: CONVERSATION_ITEM_TYPE.SUMMARY,
      subtype: CONVERSATION_MESSAGE_SUBTYPE.CHAT_MESSAGE,
    },
  })
  assert.equal(invalidSummarySubtype.success, false)

  const invalidReplySubtype = ChatSendMessageViewSchema.safeParse({
    item: {
      ...item,
      replyTo: {
        itemId: "reply-item",
        itemType: CONVERSATION_ITEM_TYPE.MESSAGE,
        subtype: "legacy-reply",
        previewText: "legacy",
        previewBlocks: [],
      },
    },
  })
  assert.equal(invalidReplySubtype.success, false)

  const invalidLastItemSubtype = ChatConversationEnvelopeViewSchema.safeParse({
    conversation: {
      ...conversation,
      lastItem: {
        itemId: item.id,
        sequence: item.sequence,
        itemType: item.itemType,
        subtype: "legacy-last-item",
        previewText: "hello",
        createdAt: now,
      },
    },
  })
  assert.equal(invalidLastItemSubtype.success, false)
})

test("ChatConversationItemSchema validates event payload details", () => {
  const parsed = ChatSendMessageViewSchema.safeParse({
    item: {
      ...taskRequestedItem,
      eventTimelinePolicy: CONVERSATION_EVENT_TIMELINE_POLICY.USERS_ONLY,
      eventContextPolicy: CONVERSATION_EVENT_CONTEXT_POLICY.TARGETED_MEMBERS,
    },
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = ChatSendMessageViewSchema.safeParse({
    item: {
      ...taskRequestedItem,
      eventPayload: {},
    },
  })
  assert.equal(invalid.success, false)

  const invalidPolicy = ChatSendMessageViewSchema.safeParse({
    item: {
      ...taskRequestedItem,
      eventTimelinePolicy: "everyone",
      eventContextPolicy: "private_to_user",
    },
  })
  assert.equal(invalidPolicy.success, false)

  const automationNotice = ChatSendMessageViewSchema.safeParse({
    item: {
      ...taskRequestedItem,
      subtype: CONVERSATION_FEED_EVENT_TYPE.AUTOMATION_NOTICE,
      eventPayload: {
        automationId: "automation-1",
        executionId: "execution-1",
        occurrenceId: "occurrence-1",
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        sourceKind: AUTOMATION_TRIGGER_SOURCE_KINDS[0],
        message: "Automation fired",
      },
    },
  })
  assert.ok(
    automationNotice.success,
    JSON.stringify(automationNotice.error?.issues)
  )

  const invalidAutomationNotice = ChatSendMessageViewSchema.safeParse({
    item: {
      ...taskRequestedItem,
      subtype: CONVERSATION_FEED_EVENT_TYPE.AUTOMATION_NOTICE,
      eventPayload: {
        automationId: "automation-1",
        executionId: "execution-1",
        occurrenceId: "occurrence-1",
        category: AUTOMATION_RULE_CATEGORY.EVENT_SUBSCRIPTION,
        sourceKind: "legacy_source",
        message: "Automation fired",
      },
    },
  })
  assert.equal(invalidAutomationNotice.success, false)

  const invalidTask = ChatSyncViewSchema.safeParse({
    events: [
      {
        syncSeq: 3,
        memberSeq: 3,
        workspaceId: conversation.workspaceId,
        workspaceMemberId: "member-1",
        eventType: "task.updated",
        payload: {
          conversationId: conversation.conversationId,
          taskId: "task-1",
          task: {
            ...userInputTask,
            lifecycleStatus: "not_a_lifecycle",
          },
        },
        occurredAt: now,
      },
    ],
    nextCursor: 3,
    hasMore: false,
  })
  assert.equal(invalidTask.success, false)
})

test("ChatTaskRespondViewSchema validates task summary variants", () => {
  for (const task of [
    userInputTask,
    planApprovalTask,
    runtimeAuthorizationTask,
  ]) {
    const parsed = ChatTaskRespondViewSchema.safeParse({
      outcome: "applied",
      task,
    })
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  }

  const invalid = ChatTaskRespondViewSchema.safeParse({
    outcome: "applied",
    task: {
      ...planApprovalTask,
      planApproval: undefined,
    },
  })
  assert.equal(invalid.success, false)
})

test("ChatConversationMessagesViewSchema validates runtime and device state shapes", () => {
  const parsed = ChatConversationMessagesViewSchema.safeParse({
    conversation,
    items: [item],
    runtimeByActor: {
      "actor-1": {
        conversationId: conversation.conversationId,
        sessionId: "session-1",
        actorId: "actor-1",
        actorDisplayName: "Research Actor",
        laneState: "running",
        health: ACTOR_RUNTIME_HEALTH.OK,
        phase: "thinking",
        statusText: "Thinking",
        pendingWakeupCount: 1,
        currentTurnPreview: {
          turnId: "turn-1",
          startedAt: now,
          updatedAt: now,
          processingTargets: [],
          activeTool: {
            toolCallId: "tool-call-1",
            toolKind: "plugin",
            toolName: "search_docs",
            state: "running",
            displayTitle: "Search docs",
            startedAt: now,
            updatedAt: now,
          },
          totalToolCallCount: 1,
          completedToolCallCount: 0,
          failedToolCallCount: 0,
        },
        latestWakeupAt: now,
        updatedAt: now,
      },
    },
    runtimeByRemoteAgent: {
      "remote-agent-1": {
        remoteAgentId: "remote-agent-1",
        runtimeKind: "codex",
        state: "running",
        statusText: "Working",
        activeConversationId: conversation.conversationId,
        activeTaskId: "task-1",
        sessionId: "remote-session-1",
        pendingConversationCount: 1,
        unreadDeliveryCount: 2,
        lastActivityAt: now,
        lastRunStartedAt: now,
        updatedAt: now,
        capabilities: {
          supportsPlanMode: true,
          supportsStructuredIo: true,
        },
      },
    },
    participantReadWatermarkSequence: 1,
    deviceState: {
      clientInstanceId: "client-1",
      conversationId: conversation.conversationId,
      lastVisibleSequence: 1,
      lastInboxSeq: 2,
      lastOpenedAt: now,
      draftPayload: { text: "draft" },
    },
    hasMoreBefore: false,
    hasMoreAfter: false,
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const withoutDeviceState = ChatConversationMessagesViewSchema.safeParse({
    conversation,
    items: [item],
    runtimeByActor: {},
    runtimeByRemoteAgent: {},
    participantReadWatermarkSequence: 1,
    hasMoreBefore: false,
    hasMoreAfter: false,
  })
  assert.ok(
    withoutDeviceState.success,
    JSON.stringify(withoutDeviceState.error?.issues)
  )

  const invalid = ChatConversationMessagesViewSchema.safeParse({
    conversation,
    items: [item],
    runtimeByActor: {
      "actor-1": {
        conversationId: conversation.conversationId,
        sessionId: "session-1",
        actorId: "actor-1",
        actorDisplayName: "Research Actor",
        laneState: "not_a_session_status",
        health: ACTOR_RUNTIME_HEALTH.OK,
        phase: "thinking",
        pendingWakeupCount: 0,
        updatedAt: now,
      },
    },
    runtimeByRemoteAgent: {},
    participantReadWatermarkSequence: 1,
    deviceState: {
      clientInstanceId: "client-1",
      conversationId: conversation.conversationId,
      lastVisibleSequence: "1",
      lastInboxSeq: 2,
      draftPayload: {},
    },
    hasMoreBefore: false,
    hasMoreAfter: false,
  })
  assert.equal(invalid.success, false)
})

test("presentChatConversationReadWatermark output parses ChatReadWatermarkViewSchema", () => {
  const parsed = ChatReadWatermarkViewSchema.safeParse(
    presentChatConversationReadWatermark({
      conversationId: "conversation-1",
      workspaceMemberId: "member-1",
      participantId: "participant-1",
      readWatermarkSequence: 1,
      lastReadAt: now,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("ChatParticipantRemovalViewSchema validates removal states", () => {
  const parsed = ChatParticipantRemovalViewSchema.safeParse({
    conversationId: conversation.conversationId,
    participantId: "participant-1",
    state: CHAT_PARTICIPANT_REMOVAL_STATE.LEFT,
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = ChatParticipantRemovalViewSchema.safeParse({
    conversationId: conversation.conversationId,
    participantId: "participant-1",
    state: "active",
  })
  assert.equal(invalid.success, false)
})

test("ChatRuntimeTurnDetailViewSchema validates runtime activity details", () => {
  const parsed = ChatRuntimeTurnDetailViewSchema.safeParse({
    conversationId: "conversation-1",
    actorId: "actor-1",
    actorDisplayName: "Research Actor",
    turnId: "turn-1",
    startedAt: now,
    updatedAt: now,
    processingTargets: [
      {
        wakeupId: "wakeup-1",
        participantType: "workspace_member",
        participantId: "member-1",
        name: "Member",
        summary: "Asked a question",
        createdAt: now,
        attachedAt: now,
      },
    ],
    items: [
      {
        toolCallId: "tool-call-1",
        toolKind: "plugin",
        toolName: "search_docs",
        source: {
          kind: "plugin",
          displayName: "docs/search",
          upstreamToolName: "search",
        },
        state: "completed",
        displayTitle: "Search docs",
        displayDetail: "Query: runtime",
        icon: "search",
        titlePresentation: {
          key: "tool.search.title",
          params: { query: "runtime" },
          fallback: "Search docs",
        },
        detailPresentation: {
          key: "tool.search.detail",
          params: { count: 2 },
          fallback: "2 results",
        },
        resultSummary: {
          key: "tool.search.result",
          params: { count: 2 },
          fallback: "Found 2 results",
        },
        requestBlocks: [{ type: "text", text: "runtime" }],
        resultBlocks: [{ type: "text", text: "result" }],
        taskStatus: "completed",
        startedAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ],
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = ChatRuntimeTurnDetailViewSchema.safeParse({
    conversationId: "conversation-1",
    actorId: "actor-1",
    actorDisplayName: "Research Actor",
    turnId: "turn-1",
    startedAt: now,
    updatedAt: now,
    processingTargets: [],
    items: [
      {
        toolCallId: "tool-call-1",
        toolKind: "plugin",
        toolName: "search_docs",
        state: "completed",
        displayTitle: "Search docs",
        requestBlocks: [{ type: "text", text: "runtime" }],
        resultBlocks: [{ type: "text", text: "result" }],
        taskStatus: "not_a_task_status",
        startedAt: now,
        updatedAt: now,
      },
    ],
  })
  assert.equal(invalid.success, false)
})

test("ChatDedupCountersViewSchema validates numeric counter snapshots", () => {
  const parsed = ChatDedupCountersViewSchema.safeParse({
    duplicate_watermark_post_total: 1,
    duplicate_clientmessageid_send_total: 0,
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const empty = ChatDedupCountersViewSchema.safeParse({})
  assert.ok(empty.success, JSON.stringify(empty.error?.issues))

  const invalid = ChatDedupCountersViewSchema.safeParse({
    duplicate_watermark_post_total: "1",
  })
  assert.equal(invalid.success, false)
})
