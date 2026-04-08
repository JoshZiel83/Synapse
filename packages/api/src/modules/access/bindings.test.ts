import test from "node:test";
import assert from "node:assert/strict";
import {
  type AccessGrantTarget,
} from "./bindings.js";
import {
  buildAccessBindingStorageTarget,
  buildResourceAccessBindingInsertValues,
} from "./binding-storage.js";

test("buildAccessBindingStorageTarget stores actor_in_conversation by context only", () => {
  const target: AccessGrantTarget = {
    targetType: "actor_in_conversation",
    subjectWorkspaceId: null,
    subjectActorId: "actor-1",
    subjectConversationId: "conversation-1",
    subjectConversationActorContextId: "context-1",
  };

  assert.deepEqual(buildAccessBindingStorageTarget(target), {
    target_type: "actor_in_conversation",
    subject_workspace_id: null,
    subject_actor_id: null,
    subject_conversation_id: null,
    subject_conversation_actor_context_id: "context-1",
  });
});

test("buildResourceAccessBindingInsertValues maps resource and target columns consistently", () => {
  const target: AccessGrantTarget = {
    targetType: "workspace",
    subjectWorkspaceId: "workspace-1",
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  };

  assert.deepEqual(
    buildResourceAccessBindingInsertValues({
      workspaceId: "workspace-1",
      resourceType: "installed_skill",
      resourceId: "skill-1",
      target,
      createdByWorkspaceMemberId: "member-1",
      reason: "test reason",
    }),
    {
      workspace_id: "workspace-1",
      resource_type: "installed_skill",
      installed_skill_id: "skill-1",
      plugin_installation_id: null,
      relay_capability_id: null,
      automation_event_source_id: null,
      target_type: "workspace",
      subject_workspace_id: "workspace-1",
      subject_actor_id: null,
      subject_conversation_id: null,
      subject_conversation_actor_context_id: null,
      conversation_type_mask_override: null,
      status: "active",
      created_by_workspace_member_id: "member-1",
      reason: "test reason",
    },
  );
});
