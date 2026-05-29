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
  accessBindingHasTarget,
  accessGrantTargetToSubjectRef,
  buildResourceAccessBindingRef,
  capabilityTargetMatchesContext,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  readAccessBindingResourceId,
  readAccessBindingTarget,
  relationForAccessGrantTarget,
  type AccessGrantTarget,
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

test("accessBindingHasTarget compares decoded subject + scope shape", () => {
  const target: AccessGrantTarget = { subject: actorRef("actor-7") }
  assert.equal(
    accessBindingHasTarget(
      {
        subject_id: "subj-1",
        scope_subject_id: null,
        subject_kind: "actor",
        subject_actor_id_via_join: "actor-7",
      },
      target
    ),
    true
  )
  assert.equal(
    accessBindingHasTarget(
      {
        subject_id: "subj-2",
        scope_subject_id: null,
        subject_kind: "actor",
        subject_actor_id_via_join: "actor-8",
      },
      target
    ),
    false
  )
  assert.equal(
    accessBindingHasTarget(
      {
        subject_id: "subj-3",
        scope_subject_id: null,
        subject_kind: "workspace",
        subject_workspace_id_via_join: "ws-1",
      },
      target
    ),
    false
  )
})

test("readAccessBindingResourceId returns the right column for each resource_type", () => {
  assert.equal(
    readAccessBindingResourceId({
      resource_type: "installed_skill",
      installed_skill_id: "s-1",
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
    }),
    "s-1"
  )
  assert.equal(
    readAccessBindingResourceId({
      resource_type: "plugin_installation",
      installed_skill_id: null,
      plugin_installation_id: "p-1",
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
    }),
    "p-1"
  )
  assert.equal(
    readAccessBindingResourceId({
      resource_type: "automation_event_source",
      installed_skill_id: null,
      plugin_installation_id: null,
      automation_event_source_id: "a-1",
      actor_id: null,
      remote_agent_id: null,
    }),
    "a-1"
  )
  assert.equal(
    readAccessBindingResourceId({
      resource_type: "actor",
      installed_skill_id: null,
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: "act-1",
      remote_agent_id: null,
    }),
    "act-1"
  )
  assert.equal(
    readAccessBindingResourceId({
      resource_type: "remote_agent",
      installed_skill_id: null,
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: "ra-1",
    }),
    "ra-1"
  )
})

test("readAccessBindingResourceId throws when the matching id is missing", () => {
  assert.throws(() =>
    readAccessBindingResourceId({
      resource_type: "installed_skill",
      installed_skill_id: null,
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
    })
  )
})

test("buildResourceAccessBindingRef populates only the matching id column", () => {
  assert.deepEqual(
    buildResourceAccessBindingRef({
      resourceType: "installed_skill",
      resourceId: "s-1",
    }),
    {
      resource_type: "installed_skill",
      installed_skill_id: "s-1",
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
    }
  )
  assert.deepEqual(
    buildResourceAccessBindingRef({
      resourceType: "remote_agent",
      resourceId: "ra-1",
    }),
    {
      resource_type: "remote_agent",
      installed_skill_id: null,
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: "ra-1",
    }
  )
})

test("relationForAccessGrantTarget maps every subject + scope combo", () => {
  assert.equal(
    relationForAccessGrantTarget({ subject: workspaceRef("ws-1") }),
    "use_workspace"
  )
  assert.equal(
    relationForAccessGrantTarget({ subject: workspaceMemberRef("m-1") }),
    "use_workspace_member"
  )
  assert.equal(
    relationForAccessGrantTarget({ subject: conversationRef("c-1") }),
    "use_conversation"
  )
  assert.equal(
    relationForAccessGrantTarget({ subject: actorRef("a-1") }),
    "use_actor"
  )
  assert.equal(
    relationForAccessGrantTarget({
      subject: actorRef("a-1"),
      scope: conversationRef("c-1"),
    }),
    "use_actor_in_conversation"
  )
})

test("readAccessBindingTarget decodes a workspace-subject row", () => {
  assert.deepEqual(
    readAccessBindingTarget({
      subject_kind: "workspace",
      subject_workspace_id_via_join: "ws-1",
    }),
    { subject: { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "ws-1" } }
  )
})

test("readAccessBindingTarget decodes a workspace_member subject row", () => {
  assert.deepEqual(
    readAccessBindingTarget({
      subject_kind: "workspace_member",
      subject_workspace_member_id_via_join: "m-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-1" },
    }
  )
})

test("readAccessBindingTarget decodes actor + scope=conversation", () => {
  assert.deepEqual(
    readAccessBindingTarget({
      subject_kind: "actor",
      subject_actor_id_via_join: "a-1",
      scope_kind: "conversation",
      scope_conversation_id_via_join: "c-1",
    }),
    {
      subject: { kind: SUBJECT_KIND.ACTOR, actorId: "a-1" },
      scope: { kind: SUBJECT_KIND.CONVERSATION, conversationId: "c-1" },
    }
  )
})

test("readAccessBindingTarget throws on missing required id", () => {
  assert.throws(() =>
    readAccessBindingTarget({
      subject_kind: "actor",
      subject_actor_id_via_join: null,
    })
  )
})

test("normalizeAccessBindingRow attaches derived resource_id and relation", () => {
  const normalized = normalizeAccessBindingRow({
    resource_type: "actor",
    installed_skill_id: null,
    plugin_installation_id: null,
    automation_event_source_id: null,
    actor_id: "act-1",
    remote_agent_id: null,
    subject_kind: "actor",
  })
  assert.equal(normalized.resource_id, "act-1")
  assert.equal(normalized.relation, "use_actor")
})

test("mapAccessBindingToGrant projects a full AccessGrant from a normalized row", () => {
  const grant = mapAccessBindingToGrant(
    normalizeAccessBindingRow({
      id: "binding-1",
      workspace_id: "ws-1",
      resource_type: "installed_skill",
      installed_skill_id: "s-1",
      plugin_installation_id: null,
      automation_event_source_id: null,
      actor_id: null,
      remote_agent_id: null,
      subject_id: "subj-1",
      scope_subject_id: null,
      subject_kind: "workspace",
      subject_workspace_id_via_join: "ws-1",
      conversation_type_mask_override: null,
      status: "active",
      source: "manual",
      created_by_workspace_member_id: null,
      reason: null,
      created_at: new Date("2026-05-23T00:00:00Z"),
      revoked_at: null,
    } as any)
  )
  assert.equal(grant.id, "binding-1")
  assert.equal(grant.resourceId, "s-1")
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
