import test from "node:test"
import assert from "node:assert/strict"
import {
  SUBJECT_KIND,
  actorRef,
  conversationRef,
  workspaceMemberRef,
  workspaceRef,
} from "@synapse/shared"
import {
  accessGrantTargetToSubjectRef,
  capabilityTargetMatchesContext,
  readAutomationEventSourceAccessGrantTarget,
} from "./grant-target.js"

test("accessGrantTargetToSubjectRef returns the subject directly", () => {
  assert.deepEqual(
    accessGrantTargetToSubjectRef({
      subject: actorRef("actor-1"),
      scope: conversationRef("conversation-1"),
    }),
    { kind: SUBJECT_KIND.ACTOR, actorId: "actor-1" }
  )
  assert.deepEqual(
    accessGrantTargetToSubjectRef({ subject: workspaceRef("workspace-1") }),
    { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "workspace-1" }
  )
})

test("accessGrantTargetToSubjectRef on workspace_member / actor / conversation", () => {
  assert.deepEqual(
    accessGrantTargetToSubjectRef({ subject: workspaceMemberRef("m-7") }),
    { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-7" }
  )
  assert.deepEqual(
    accessGrantTargetToSubjectRef({ subject: actorRef("a-1") }),
    { kind: SUBJECT_KIND.ACTOR, actorId: "a-1" }
  )
  assert.deepEqual(
    accessGrantTargetToSubjectRef({ subject: conversationRef("c-1") }),
    { kind: SUBJECT_KIND.CONVERSATION, conversationId: "c-1" }
  )
})

test("readAutomationEventSourceAccessGrantTarget decodes a workspace-subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "workspace",
      subjectWorkspaceIdViaJoin: "ws-1",
    }),
    { subject: { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "ws-1" } }
  )
})

test("readAutomationEventSourceAccessGrantTarget decodes a workspace_member subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "workspace_member",
      subjectWorkspaceMemberIdViaJoin: "m-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-1" },
    }
  )
})

test("readAutomationEventSourceAccessGrantTarget decodes actor + scope=conversation", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "actor",
      subjectActorIdViaJoin: "a-1",
      scopeKind: "conversation",
      scopeConversationIdViaJoin: "c-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.ACTOR, actorId: "a-1" },
      scope: { kind: SUBJECT_KIND.CONVERSATION, conversationId: "c-1" },
    }
  )
})

test("readAutomationEventSourceAccessGrantTarget throws on missing required id", () => {
  assert.throws(() =>
    readAutomationEventSourceAccessGrantTarget({
      subjectKind: "actor",
      subjectActorIdViaJoin: null,
    })
  )
})

test("capabilityTargetMatchesContext matches by subject + scope", () => {
  const ctxBase = {
    grantOwnerWorkspaceId: "ws-1",
    contextWorkspaceId: "ws-1",
    actorId: "a-1",
    conversationId: "c-1",
    workspaceMemberId: "m-1",
  }
  // workspace target
  assert.equal(
    capabilityTargetMatchesContext({ subject: workspaceRef("ws-1") }, ctxBase),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { subject: workspaceRef("ws-1") },
      { ...ctxBase, contextWorkspaceId: "ws-2" }
    ),
    false
  )
  // workspace_member
  assert.equal(
    capabilityTargetMatchesContext(
      { subject: workspaceMemberRef("m-1") },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { subject: workspaceMemberRef("m-2") },
      ctxBase
    ),
    false
  )
  // actor
  assert.equal(
    capabilityTargetMatchesContext({ subject: actorRef("a-1") }, ctxBase),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext({ subject: actorRef("a-2") }, ctxBase),
    false
  )
  // conversation
  assert.equal(
    capabilityTargetMatchesContext(
      { subject: conversationRef("c-1") },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { subject: conversationRef("c-2") },
      ctxBase
    ),
    false
  )
  // actor + scope=conversation
  assert.equal(
    capabilityTargetMatchesContext(
      {
        subject: actorRef("a-1"),
        scope: conversationRef("c-1"),
      },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      {
        subject: actorRef("a-1"),
        scope: conversationRef("c-2"),
      },
      ctxBase
    ),
    false
  )
})
