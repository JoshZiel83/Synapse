import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import {
  accessBindingHasTarget,
  accessGrantTargetToSubjectRef,
  buildResourceAccessBindingRef,
  capabilityTargetMatchesContext,
  mapAccessBindingToGrant,
  normalizeAccessBindingRow,
  readAccessBindingResourceId,
  readAccessBindingTarget,
  relationForAccessTargetType,
  type AccessGrantTarget,
} from "./bindings.js"
import {
  accessSubjectRowToGrantTarget,
  subjectKindToTargetType,
} from "./binding-storage.js"

test("accessGrantTargetToSubjectRef maps actor_in_conversation to context kind", () => {
  const target: AccessGrantTarget = {
    targetType: "actor_in_conversation",
    subjectWorkspaceId: null,
    subjectActorId: "actor-1",
    subjectConversationId: "conversation-1",
    subjectConversationActorContextId: "context-1",
  }
  assert.deepEqual(accessGrantTargetToSubjectRef(target), {
    kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
    contextId: "context-1",
  })
})

test("accessGrantTargetToSubjectRef maps workspace target", () => {
  const target: AccessGrantTarget = {
    targetType: "workspace",
    subjectWorkspaceId: "workspace-1",
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
  assert.deepEqual(accessGrantTargetToSubjectRef(target), {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: "workspace-1",
  })
})

test("accessGrantTargetToSubjectRef maps workspace_member target", () => {
  assert.deepEqual(
    accessGrantTargetToSubjectRef({
      targetType: "workspace_member",
      subjectWorkspaceId: null,
      subjectWorkspaceMemberId: "m-7",
      subjectActorId: null,
      subjectConversationId: null,
      subjectConversationActorContextId: null,
    }),
    { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "m-7" }
  )
})

test("accessGrantTargetToSubjectRef maps actor and conversation targets", () => {
  assert.deepEqual(
    accessGrantTargetToSubjectRef({
      targetType: "actor",
      subjectWorkspaceId: null,
      subjectActorId: "a-1",
      subjectConversationId: null,
      subjectConversationActorContextId: null,
    }),
    { kind: SUBJECT_KIND.ACTOR, actorId: "a-1" }
  )
  assert.deepEqual(
    accessGrantTargetToSubjectRef({
      targetType: "conversation",
      subjectWorkspaceId: null,
      subjectActorId: null,
      subjectConversationId: "c-1",
      subjectConversationActorContextId: null,
    }),
    { kind: SUBJECT_KIND.CONVERSATION, conversationId: "c-1" }
  )
})

test("accessSubjectRowToGrantTarget round-trips a workspace subject row", () => {
  const target = accessSubjectRowToGrantTarget({
    kind: "workspace",
    workspace_id: "workspace-1",
    workspace_member_id: null,
    actor_id: null,
    conversation_id: null,
    conversation_actor_context_id: null,
  })
  assert.deepEqual(target, {
    targetType: "workspace",
    subjectWorkspaceId: "workspace-1",
    subjectWorkspaceMemberId: null,
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  })
})

test("accessSubjectRowToGrantTarget requires context row for actor_in_conversation", () => {
  assert.throws(() =>
    accessSubjectRowToGrantTarget({
      kind: "conversation_actor_context",
      workspace_id: null,
      workspace_member_id: null,
      actor_id: null,
      conversation_id: null,
      conversation_actor_context_id: "context-1",
    })
  )
  assert.deepEqual(
    accessSubjectRowToGrantTarget(
      {
        kind: "conversation_actor_context",
        workspace_id: null,
        workspace_member_id: null,
        actor_id: null,
        conversation_id: null,
        conversation_actor_context_id: "context-1",
      },
      { actor_id: "actor-1", conversation_id: "conv-1" }
    ),
    {
      targetType: "actor_in_conversation",
      subjectWorkspaceId: null,
      subjectWorkspaceMemberId: null,
      subjectActorId: "actor-1",
      subjectConversationId: "conv-1",
      subjectConversationActorContextId: "context-1",
    }
  )
})

test("subjectKindToTargetType maps each kind to its legacy target type", () => {
  assert.equal(subjectKindToTargetType("workspace"), "workspace")
  assert.equal(subjectKindToTargetType("conversation"), "conversation")
  assert.equal(subjectKindToTargetType("actor"), "actor")
  assert.equal(
    subjectKindToTargetType("conversation_actor_context"),
    "actor_in_conversation"
  )
  assert.throws(() => subjectKindToTargetType("user"))
})

test("accessBindingHasTarget matches when projected row fields agree with target", () => {
  const target: AccessGrantTarget = {
    targetType: "actor",
    subjectWorkspaceId: null,
    subjectActorId: "actor-7",
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
  assert.equal(
    accessBindingHasTarget(
      {
        target_type: "actor",
        subject_workspace_id: null,
        subject_actor_id: "actor-7",
        subject_conversation_id: null,
        subject_conversation_actor_context_id: null,
      },
      target
    ),
    true
  )
  assert.equal(
    accessBindingHasTarget(
      {
        target_type: "actor",
        subject_workspace_id: null,
        subject_actor_id: "actor-8",
        subject_conversation_id: null,
        subject_conversation_actor_context_id: null,
      },
      target
    ),
    false
  )
  assert.equal(
    accessBindingHasTarget(
      {
        target_type: "workspace",
        subject_workspace_id: "ws-1",
        subject_actor_id: null,
        subject_conversation_id: null,
        subject_conversation_actor_context_id: null,
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

test("relationForAccessTargetType maps every target type to its relation", () => {
  assert.equal(relationForAccessTargetType("workspace"), "use_workspace")
  assert.equal(
    relationForAccessTargetType("workspace_member"),
    "use_workspace_member"
  )
  assert.equal(relationForAccessTargetType("conversation"), "use_conversation")
  assert.equal(relationForAccessTargetType("actor"), "use_actor")
  assert.equal(
    relationForAccessTargetType("actor_in_conversation"),
    "use_actor_in_conversation"
  )
})

test("readAccessBindingTarget decodes each target_type into the legacy target shape", () => {
  assert.deepEqual(
    readAccessBindingTarget({
      target_type: "workspace",
      subject_workspace_id: "ws-1",
      subject_workspace_member_id: null,
      subject_actor_id: null,
      subject_conversation_id: null,
      subject_conversation_actor_context_id: null,
    }),
    {
      targetType: "workspace",
      subjectWorkspaceId: "ws-1",
      subjectWorkspaceMemberId: null,
      subjectActorId: null,
      subjectConversationId: null,
      subjectConversationActorContextId: null,
    }
  )
  assert.deepEqual(
    readAccessBindingTarget({
      target_type: "workspace_member",
      subject_workspace_id: null,
      subject_workspace_member_id: "m-1",
      subject_actor_id: null,
      subject_conversation_id: null,
      subject_conversation_actor_context_id: null,
    }),
    {
      targetType: "workspace_member",
      subjectWorkspaceId: null,
      subjectWorkspaceMemberId: "m-1",
      subjectActorId: null,
      subjectConversationId: null,
      subjectConversationActorContextId: null,
    }
  )
  assert.deepEqual(
    readAccessBindingTarget({
      target_type: "actor_in_conversation",
      subject_workspace_id: null,
      subject_workspace_member_id: null,
      subject_actor_id: "a-1",
      subject_conversation_id: "c-1",
      subject_conversation_actor_context_id: "ctx-1",
    }),
    {
      targetType: "actor_in_conversation",
      subjectWorkspaceId: null,
      subjectWorkspaceMemberId: null,
      subjectActorId: "a-1",
      subjectConversationId: "c-1",
      subjectConversationActorContextId: "ctx-1",
    }
  )
})

test("readAccessBindingTarget throws for missing actor_in_conversation ids", () => {
  assert.throws(() =>
    readAccessBindingTarget({
      target_type: "actor_in_conversation",
      subject_workspace_id: null,
      subject_workspace_member_id: null,
      subject_actor_id: null,
      subject_conversation_id: "c-1",
      subject_conversation_actor_context_id: "ctx-1",
    })
  )
})

test("normalizeAccessBindingRow attaches derived resource_id and relation", () => {
  const normalized = normalizeAccessBindingRow({
    target_type: "actor",
    resource_type: "actor",
    installed_skill_id: null,
    plugin_installation_id: null,
    automation_event_source_id: null,
    actor_id: "act-1",
    remote_agent_id: null,
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
      target_type: "workspace",
      subject_workspace_id: "ws-1",
      subject_workspace_member_id: null,
      subject_actor_id: null,
      subject_conversation_id: null,
      subject_conversation_actor_context_id: null,
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
  assert.equal(grant.target.type, "workspace")
  assert.equal(grant.status, "active")
})

test("capabilityTargetMatchesContext matches by target type", () => {
  const ctxBase = {
    grantOwnerWorkspaceId: "ws-1",
    contextWorkspaceId: "ws-1",
    actorId: "a-1",
    conversationId: "c-1",
    workspaceMemberId: "m-1",
  }
  // workspace target — context workspace matches grant owner
  assert.equal(
    capabilityTargetMatchesContext({ type: "workspace" }, ctxBase),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "workspace" },
      { ...ctxBase, contextWorkspaceId: "ws-2" }
    ),
    false
  )
  // workspace_member
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "workspace_member", workspaceMemberId: "m-1" },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "workspace_member", workspaceMemberId: "m-2" },
      ctxBase
    ),
    false
  )
  // actor
  assert.equal(
    capabilityTargetMatchesContext({ type: "actor", actorId: "a-1" }, ctxBase),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext({ type: "actor", actorId: "a-2" }, ctxBase),
    false
  )
  // conversation
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "conversation", conversationId: "c-1" },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "conversation", conversationId: "c-2" },
      ctxBase
    ),
    false
  )
  // actor_in_conversation requires both
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "actor_in_conversation", actorId: "a-1", conversationId: "c-1" },
      ctxBase
    ),
    true
  )
  assert.equal(
    capabilityTargetMatchesContext(
      { type: "actor_in_conversation", actorId: "a-1", conversationId: "c-2" },
      ctxBase
    ),
    false
  )
})
