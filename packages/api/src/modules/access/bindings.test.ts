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
  automationEventSourceAccessBindingHasTarget,
  accessGrantTargetToSubjectRef,
  buildAutomationEventSourceAccessBindingRef,
  capabilityTargetMatchesContext,
  mapAutomationEventSourceAccessBindingToGrant,
  normalizeAutomationEventSourceAccessBindingRow,
  readAutomationEventSourceAccessBindingResourceId,
  readAutomationEventSourceAccessBindingTarget,
  relationForAutomationEventSourceAccessBindingTarget,
  type AutomationEventSourceBindingTarget,
} from "./bindings.js"

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

test("automationEventSourceAccessBindingHasTarget compares decoded subject + scope shape", () => {
  const target: AutomationEventSourceBindingTarget = {
    subject: actorRef("actor-7"),
  }
  assert.equal(
    automationEventSourceAccessBindingHasTarget(
      {
        subjectId: "subj-1",
        scopeSubjectId: null,
        subjectKind: "actor",
        subjectActorIdViaJoin: "actor-7",
      },
      target
    ),
    true
  )
  assert.equal(
    automationEventSourceAccessBindingHasTarget(
      {
        subjectId: "subj-2",
        scopeSubjectId: null,
        subjectKind: "actor",
        subjectActorIdViaJoin: "actor-8",
      },
      target
    ),
    false
  )
  assert.equal(
    automationEventSourceAccessBindingHasTarget(
      {
        subjectId: "subj-3",
        scopeSubjectId: null,
        subjectKind: "workspace",
        subjectWorkspaceIdViaJoin: "ws-1",
      },
      target
    ),
    false
  )
})

test("readAutomationEventSourceAccessBindingResourceId returns the automation event source id", () => {
  assert.equal(
    readAutomationEventSourceAccessBindingResourceId({
      resourceType: "automation_event_source",
      automationEventSourceId: "a-1",
    }),
    "a-1"
  )
})

test("readAutomationEventSourceAccessBindingResourceId throws when the matching id is missing", () => {
  assert.throws(() =>
    readAutomationEventSourceAccessBindingResourceId({
      resourceType: "automation_event_source",
      automationEventSourceId: null,
    })
  )
})

test("buildAutomationEventSourceAccessBindingRef populates only the automation event source id column", () => {
  assert.deepEqual(
    buildAutomationEventSourceAccessBindingRef({
      resourceType: "automation_event_source",
      resourceId: "evt-1",
    }),
    {
      resourceType: "automation_event_source",
      automationEventSourceId: "evt-1",
    }
  )
})

test("relationForAutomationEventSourceAccessBindingTarget maps every subject + scope combo", () => {
  assert.equal(
    relationForAutomationEventSourceAccessBindingTarget({
      subject: workspaceRef("ws-1"),
    }),
    "use_workspace"
  )
  assert.equal(
    relationForAutomationEventSourceAccessBindingTarget({
      subject: workspaceMemberRef("m-1"),
    }),
    "use_workspace_member"
  )
  assert.equal(
    relationForAutomationEventSourceAccessBindingTarget({
      subject: conversationRef("c-1"),
    }),
    "use_conversation"
  )
  assert.equal(
    relationForAutomationEventSourceAccessBindingTarget({
      subject: actorRef("a-1"),
    }),
    "use_actor"
  )
  assert.equal(
    relationForAutomationEventSourceAccessBindingTarget({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
    "use_actor"
  )
})

test("readAutomationEventSourceAccessBindingTarget decodes a workspace-subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessBindingTarget({
      subjectKind: "workspace",
      subjectWorkspaceIdViaJoin: "ws-1",
    }),
    { subject: { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "ws-1" } }
  )
})

test("readAutomationEventSourceAccessBindingTarget decodes a workspace_member subject row", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessBindingTarget({
      subjectKind: "workspace_member",
      subjectWorkspaceMemberIdViaJoin: "m-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-1" },
    }
  )
})

test("readAutomationEventSourceAccessBindingTarget decodes actor + scope=conversation", () => {
  assert.deepEqual(
    readAutomationEventSourceAccessBindingTarget({
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

test("readAutomationEventSourceAccessBindingTarget throws on missing required id", () => {
  assert.throws(() =>
    readAutomationEventSourceAccessBindingTarget({
      subjectKind: "actor",
      subjectActorIdViaJoin: null,
    })
  )
})

test("normalizeAutomationEventSourceAccessBindingRow attaches derived resource_id and relation", () => {
  const normalized = normalizeAutomationEventSourceAccessBindingRow({
    resourceType: "automation_event_source",
    installedSkillId: null,
    pluginInstallationId: null,
    automationEventSourceId: "evt-1",
    actorId: null,
    remoteAgentId: null,
    subjectKind: "actor",
  })
  assert.equal(normalized.resourceId, "evt-1")
  assert.equal(normalized.relation, "use_actor")
})

test("mapAutomationEventSourceAccessBindingToGrant projects a full automation event source grant from a normalized row", () => {
  const grant = mapAutomationEventSourceAccessBindingToGrant(
    normalizeAutomationEventSourceAccessBindingRow({
      id: "binding-1",
      workspaceId: "ws-1",
      resourceType: "automation_event_source",
      installedSkillId: null,
      pluginInstallationId: null,
      automationEventSourceId: "evt-1",
      actorId: null,
      remoteAgentId: null,
      subjectId: "subj-1",
      scopeSubjectId: null,
      subjectKind: "workspace",
      subjectWorkspaceIdViaJoin: "ws-1",
      conversationTypeMaskOverride: null,
      status: "active",
      source: "manual",
      createdByWorkspaceMemberId: null,
      reason: null,
      createdAt: new Date("2026-05-23T00:00:00Z"),
      revokedAt: null,
    } as any)
  )
  assert.equal(grant.id, "binding-1")
  assert.equal(grant.resourceId, "evt-1")
  assert.equal(grant.workspaceId, "ws-1")
  assert.equal(grant.target.subject.kind, "workspace")
  assert.equal(grant.status, "active")
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
