// Round-6 P1-4: the relationship response schemas in
// @synapse/shared/schemas/relationship.ts were deepened from z.unknown() to
// real Zod for the presented views (friend/actor/remote-agent request views,
// contact-hub entries, identity-search matches). The relationship controller
// sends present*() output through sendData (parses through z.output), so a
// schema that under-models the presenter would strip fields on the wire. These
// tests pin the presenter → shared-schema contract.

import test from "node:test"
import assert from "node:assert/strict"
import {
  CONTACT_DIRECT_STATE,
  CONTACT_HUB_KIND,
  CONTACT_TARGET_TYPE,
  CONVERSATION_KIND,
  CONVERSATION_PARTICIPANT_STATE,
  CONVERSATION_PARTICIPANT_TYPE,
  CONVERSATION_STATUS,
  DIRECT_CONVERSATION_OPEN_STATUS,
  RELATIONSHIP_APPROVAL_MODE,
  RELATIONSHIP_PROFILE_SUBJECT_TYPE,
  RELATIONSHIP_REQUEST_STATUS,
} from "@synapse/shared"
import {
  ContactHubDetailResponseSchema,
  ContactHubResponseSchema,
  FriendRequestViewSchema,
  ActorAccessRequestViewSchema,
  DirectConversationOpenResponseSchema,
  RemoteAgentAccessRequestViewSchema,
  RelationshipProfileViewSchema,
  RelationshipScanResponseSchema,
  RequestListResponseSchema,
  ResolveRequestResponseSchema,
} from "@synapse/shared/schemas"
import { assertIsoInstant } from "@synapse/shared/datetime"
import {
  presentContactHub,
  presentContactHubDetail,
  presentDirectConversationOpen,
  presentFriendRequest,
  presentActorAccessRequest,
  presentRelationshipProfile,
  presentRemoteAgentAccessRequest,
  presentResolvedRelationshipRequest,
  type ContactHubDetailRecord,
  type ContactHubRecord,
  type DirectConversationOpenRecord,
  type FriendRequestRecord,
  type ActorAccessRequestRecord,
  type RelationshipProfileRecord,
  type RemoteAgentAccessRequestRecord,
} from "./presenter.js"

const workspace = { id: "ws-1", name: "WS", slug: "ws" }
const memberSummary = {
  workspace,
  workspaceMemberId: "wm-1",
  userId: "u-1",
  name: "Member",
  email: "m@example.com",
  avatarFileId: null,
  trustLevel: "member" as const,
}
const actorSummary = {
  workspace,
  actorId: "actor-1",
  displayName: "Actor",
  title: "Title",
  role: "specialist" as const,
  avatarFileId: null,
  avatarEmoji: null,
  requiresContactApproval: true,
  isPublicShared: false,
}
const remoteAgentSummary = {
  workspace,
  remoteAgentId: "ra-1",
  displayName: "Agent",
  title: "Title",
  runtimeKind: "claude_code" as const,
  avatarFileId: null,
  avatarEmoji: null,
  requiresContactApproval: false,
  isPublicShared: true,
}
const contactHubEntry = {
  kind: CONTACT_HUB_KIND.WORKSPACE_MEMBER,
  id: "wm-1",
  targetType: CONTACT_TARGET_TYPE.MEMBER,
  title: "Member",
  subtitle: "m@example.com",
  workspace,
  workspaceMemberId: "wm-1",
  userId: "u-1",
  relationLabel: "Workspace member",
  directState: {
    status: CONTACT_DIRECT_STATE.AVAILABLE,
  },
}
const NOW = assertIsoInstant("2026-06-12T00:00:00.000Z")
const conversationParticipant = {
  participantId: "participant-1",
  participantType: CONVERSATION_PARTICIPANT_TYPE.WORKSPACE_MEMBER,
  workspaceMemberId: "wm-1",
  id: "wm-1",
  name: "Member",
  conversationRole: "owner",
  state: CONVERSATION_PARTICIPANT_STATE.ACTIVE,
}
const groupSummary = {
  id: "conversation-1",
  kind: CONVERSATION_KIND.GROUP,
  isIm: false,
  status: CONVERSATION_STATUS.ACTIVE,
  participants: [conversationParticipant],
  members: [conversationParticipant],
  lastMessage: {
    content: "hello",
    role: "user" as const,
    createdAt: NOW,
  },
  unreadCount: 0,
  createdAt: NOW,
  title: "Group",
  name: "Group",
  presentation: {
    chatType: CONVERSATION_KIND.GROUP,
    title: "Group",
    subtitle: "Group chat",
    canRename: true,
    canManageParticipants: true,
  },
  permissions: {
    canManage: true,
    canManageParticipants: true,
  },
  viewerParticipantId: "participant-1",
  viewerWorkspaceMemberId: "wm-1",
}

test("presentFriendRequest output parses FriendRequestViewSchema", () => {
  const record: FriendRequestRecord = {
    id: "fr-1",
    status: RELATIONSHIP_REQUEST_STATUS.PENDING,
    createdAt: new Date("2026-06-12T00:00:00.000Z"),
    targetType: "workspace_member",
    requester: memberSummary,
    targetMember: memberSummary,
  }
  const parsed = FriendRequestViewSchema.safeParse(presentFriendRequest(record))
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentActorAccessRequest output parses ActorAccessRequestViewSchema", () => {
  const record: ActorAccessRequestRecord = {
    id: "ar-1",
    status: RELATIONSHIP_REQUEST_STATUS.PENDING,
    createdAt: null,
    requester: memberSummary,
    actor: actorSummary,
  }
  const parsed = ActorAccessRequestViewSchema.safeParse(
    presentActorAccessRequest(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentRemoteAgentAccessRequest output parses RemoteAgentAccessRequestViewSchema", () => {
  const record: RemoteAgentAccessRequestRecord = {
    id: "rar-1",
    status: RELATIONSHIP_REQUEST_STATUS.APPROVED,
    createdAt: new Date("2026-06-12T00:00:00.000Z"),
    requester: memberSummary,
    remoteAgent: remoteAgentSummary,
  }
  const parsed = RemoteAgentAccessRequestViewSchema.safeParse(
    presentRemoteAgentAccessRequest(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentResolvedRelationshipRequest output parses ResolveRequestResponseSchema", () => {
  const parsed = ResolveRequestResponseSchema.safeParse(
    presentResolvedRelationshipRequest({
      id: "fr-1",
      status: RELATIONSHIP_REQUEST_STATUS.APPROVED,
    })
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  assert.throws(() =>
    presentResolvedRelationshipRequest({
      id: "fr-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
    })
  )

  const invalid = ResolveRequestResponseSchema.safeParse({
    request: {
      id: "fr-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
    },
  })
  assert.equal(invalid.success, false)
})

test("presentRelationshipProfile output parses RelationshipProfileViewSchema", () => {
  const record: RelationshipProfileRecord = {
    subjectType: RELATIONSHIP_PROFILE_SUBJECT_TYPE.MEMBER,
    approvalMode: RELATIONSHIP_APPROVAL_MODE.AUTO,
    qrToken: "qr-token",
    identityId: "member.one",
    identitySearchEnabled: true,
    requiresContactApproval: false,
  }
  const parsed = RelationshipProfileViewSchema.safeParse(
    presentRelationshipProfile(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
  assert.equal(parsed.data.qrUrl, "synapse://relationship-qr?token=qr-token")
})

test("RelationshipScanResponseSchema validates contact refs", () => {
  const parsed = RelationshipScanResponseSchema.safeParse({
    outcome: "same_workspace_member",
    contact: {
      kind: CONTACT_HUB_KIND.WORKSPACE_MEMBER,
      id: "wm-1",
    },
  })
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))

  const invalid = RelationshipScanResponseSchema.safeParse({
    outcome: "same_workspace_member",
    contact: {
      kind: CONTACT_HUB_KIND.WORKSPACE_MEMBER,
    },
  })
  assert.equal(invalid.success, false)
})

test("presentContactHub output parses ContactHubResponseSchema", () => {
  const record: ContactHubRecord = {
    requestSummary: {
      friendPendingCount: 1,
      actorAccessPendingCount: 2,
      remoteAgentAccessPendingCount: 3,
      totalPendingCount: 6,
    },
    workspaceActors: [],
    workspaceRemoteAgents: [],
    workspaceMembers: [contactHubEntry],
    friends: [],
    groups: [groupSummary],
  }
  const parsed = ContactHubResponseSchema.safeParse(presentContactHub(record))
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentContactHubDetail output parses ContactHubDetailResponseSchema", () => {
  const record: ContactHubDetailRecord = {
    contact: contactHubEntry,
    groups: [groupSummary],
  }
  const parsed = ContactHubDetailResponseSchema.safeParse(
    presentContactHubDetail(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("presentDirectConversationOpen output parses DirectConversationOpenResponseSchema", () => {
  const record: DirectConversationOpenRecord = {
    status: DIRECT_CONVERSATION_OPEN_STATUS.READY,
    created: true,
    conversationId: "conversation-1",
  }
  const parsed = DirectConversationOpenResponseSchema.safeParse(
    presentDirectConversationOpen(record)
  )
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("RequestListResponseSchema accepts each request-view kind in its union", () => {
  // The three endpoints share RequestListResponseSchema; an actor request
  // (no targetType) must not be mis-matched by the friend variant.
  const list = {
    incoming: [
      presentActorAccessRequest({
        id: "ar-2",
        status: RELATIONSHIP_REQUEST_STATUS.PENDING,
        createdAt: null,
        requester: memberSummary,
        actor: actorSummary,
      }),
    ],
    outgoing: [
      presentFriendRequest({
        id: "fr-2",
        status: RELATIONSHIP_REQUEST_STATUS.PENDING,
        createdAt: null,
        targetType: "actor",
        requester: memberSummary,
        targetActor: actorSummary,
      }),
    ],
  }
  const parsed = RequestListResponseSchema.safeParse(list)
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues))
})

test("relationship request views reject unknown request statuses", () => {
  assert.equal(
    FriendRequestViewSchema.safeParse({
      id: "fr-1",
      status: "cancelled",
      createdAt: NOW,
      targetType: CONTACT_TARGET_TYPE.MEMBER,
    }).success,
    false
  )
  assert.equal(
    ActorAccessRequestViewSchema.safeParse({
      id: "ar-1",
      status: "cancelled",
      createdAt: NOW,
    }).success,
    false
  )
  assert.equal(
    RemoteAgentAccessRequestViewSchema.safeParse({
      id: "rar-1",
      status: "cancelled",
      createdAt: NOW,
    }).success,
    false
  )
})

test("relationship request views reject non-canonical createdAt instants", () => {
  const nonCanonical = "2026-06-12T00:00:00Z"
  assert.equal(
    FriendRequestViewSchema.safeParse({
      id: "fr-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
      createdAt: nonCanonical,
      targetType: CONTACT_TARGET_TYPE.MEMBER,
    }).success,
    false
  )
  assert.equal(
    ActorAccessRequestViewSchema.safeParse({
      id: "ar-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
      createdAt: nonCanonical,
    }).success,
    false
  )
  assert.equal(
    RemoteAgentAccessRequestViewSchema.safeParse({
      id: "rar-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
      createdAt: nonCanonical,
    }).success,
    false
  )
})

test("relationship member summaries validate finite trust levels", () => {
  assert.equal(
    FriendRequestViewSchema.safeParse({
      id: "fr-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
      createdAt: NOW,
      targetType: CONTACT_TARGET_TYPE.MEMBER,
      requester: {
        ...memberSummary,
        trustLevel: "super_admin",
      },
    }).success,
    false
  )
})

test("relationship actor summaries validate finite actor roles", () => {
  assert.equal(
    ActorAccessRequestViewSchema.safeParse({
      id: "ar-1",
      status: RELATIONSHIP_REQUEST_STATUS.PENDING,
      createdAt: NOW,
      requester: memberSummary,
      actor: {
        ...actorSummary,
        role: "remote_agent",
      },
    }).success,
    false
  )
})

test("relationship conversation summaries validate finite transport kinds", () => {
  assert.equal(
    ContactHubResponseSchema.safeParse({
      requestSummary: {
        friendPendingCount: 0,
        actorAccessPendingCount: 0,
        remoteAgentAccessPendingCount: 0,
        totalPendingCount: 0,
      },
      workspaceActors: [],
      workspaceRemoteAgents: [],
      workspaceMembers: [],
      friends: [],
      groups: [
        {
          ...groupSummary,
          isIm: true,
          transportKind: "carrier_pigeon",
        },
      ],
    }).success,
    false
  )
})

test("relationship conversation summaries validate finite app statuses", () => {
  assert.equal(
    ContactHubResponseSchema.safeParse({
      requestSummary: {
        friendPendingCount: 0,
        actorAccessPendingCount: 0,
        remoteAgentAccessPendingCount: 0,
        totalPendingCount: 0,
      },
      workspaceActors: [],
      workspaceRemoteAgents: [],
      workspaceMembers: [],
      friends: [],
      groups: [
        {
          ...groupSummary,
          status: "archived",
        },
      ],
    }).success,
    false
  )
})
