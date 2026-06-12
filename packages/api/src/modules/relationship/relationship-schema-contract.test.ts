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
  FriendRequestViewSchema,
  ActorAccessRequestViewSchema,
  RemoteAgentAccessRequestViewSchema,
  RequestListResponseSchema,
} from "@synapse/shared/schemas"
import {
  presentFriendRequest,
  presentActorAccessRequest,
  presentRemoteAgentAccessRequest,
  type FriendRequestRecord,
  type ActorAccessRequestRecord,
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
  trustLevel: "member",
}
const actorSummary = {
  workspace,
  actorId: "actor-1",
  displayName: "Actor",
  title: "Title",
  role: "specialist",
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

test("presentFriendRequest output parses FriendRequestViewSchema", () => {
  const record: FriendRequestRecord = {
    id: "fr-1",
    status: "pending",
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
    status: "pending",
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
    status: "approved",
    createdAt: new Date("2026-06-12T00:00:00.000Z"),
    requester: memberSummary,
    remoteAgent: remoteAgentSummary,
  }
  const parsed = RemoteAgentAccessRequestViewSchema.safeParse(
    presentRemoteAgentAccessRequest(record)
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
        status: "pending",
        createdAt: null,
        requester: memberSummary,
        actor: actorSummary,
      }),
    ],
    outgoing: [
      presentFriendRequest({
        id: "fr-2",
        status: "pending",
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
