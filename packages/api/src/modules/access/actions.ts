import type { AccessResourceType } from "./evaluator.js"

export const ACCESS_ACTIONS = {
  "platform.manage": { resourceType: "platform", permission: "manage" },
  "platform.manage_workspaces": {
    resourceType: "platform",
    permission: "manage_workspaces",
  },
  "platform.manage_models": {
    resourceType: "platform",
    permission: "manage_models",
  },
  "platform.support": {
    resourceType: "platform",
    permission: "support_access",
  },
  "platform.audit": { resourceType: "platform", permission: "audit" },

  "workspace.view": { resourceType: "workspace", permission: "view" },
  "workspace.manage": { resourceType: "workspace", permission: "manage" },
  "workspace.manage_members": {
    resourceType: "workspace",
    permission: "manage_members",
  },
  "workspace.manage_actors": {
    resourceType: "workspace",
    permission: "manage_actors",
  },
  "workspace.use_actors": {
    resourceType: "workspace",
    permission: "use_actors",
  },
  "workspace.manage_remote_agents": {
    resourceType: "workspace",
    permission: "manage_remote_agents",
  },
  "workspace.use_remote_agents": {
    resourceType: "workspace",
    permission: "use_remote_agents",
  },
  "workspace.manage_conversations": {
    resourceType: "workspace",
    permission: "manage_conversations",
  },
  "workspace.create_conversation": {
    resourceType: "workspace",
    permission: "create_conversation",
  },
  "workspace.manage_skills": {
    resourceType: "workspace",
    permission: "manage_skills",
  },
  "workspace.manage_plugins": {
    resourceType: "workspace",
    permission: "manage_plugins",
  },
  "workspace.manage_memories": {
    resourceType: "workspace",
    permission: "manage_memories",
  },
  "workspace.manage_devices": {
    resourceType: "workspace",
    permission: "manage_devices",
  },
  "workspace.manage_models": {
    resourceType: "workspace",
    permission: "manage_models",
  },

  "actor.discover": { resourceType: "actor", permission: "discover" },
  "actor.view": { resourceType: "actor", permission: "view" },
  "actor.invoke": { resourceType: "actor", permission: "invoke" },
  "actor.receive_message": {
    resourceType: "actor",
    permission: "receive_message",
  },
  "actor.memory_read": { resourceType: "actor", permission: "memory_read" },
  "actor.memory_edit": { resourceType: "actor", permission: "memory_edit" },
  "actor.memory_retarget": {
    resourceType: "actor",
    permission: "memory_retarget",
  },
  "actor.memory_delete": { resourceType: "actor", permission: "memory_delete" },
  "actor.edit": { resourceType: "actor", permission: "edit" },
  "actor.grant": { resourceType: "actor", permission: "grant" },
  "actor.delete": { resourceType: "actor", permission: "delete" },

  "remote_agent.discover": {
    resourceType: "remote_agent",
    permission: "discover",
  },
  "remote_agent.view": { resourceType: "remote_agent", permission: "view" },
  "remote_agent.invoke": { resourceType: "remote_agent", permission: "invoke" },
  "remote_agent.receive_message": {
    resourceType: "remote_agent",
    permission: "receive_message",
  },
  "remote_agent.edit": { resourceType: "remote_agent", permission: "edit" },
  "remote_agent.grant": { resourceType: "remote_agent", permission: "grant" },
  "remote_agent.delete": { resourceType: "remote_agent", permission: "delete" },

  "conversation.view": { resourceType: "conversation", permission: "view" },
  "conversation.send": { resourceType: "conversation", permission: "send" },
  "conversation.moderate": {
    resourceType: "conversation",
    permission: "moderate",
  },
  "conversation.manage": { resourceType: "conversation", permission: "manage" },
  "conversation.manage_members": {
    resourceType: "conversation",
    permission: "manage_members",
  },
  "conversation.attach_resources": {
    resourceType: "conversation",
    permission: "attach_resources",
  },
  "conversation.memory_read": {
    resourceType: "conversation",
    permission: "memory_read",
  },
  "conversation.memory_edit": {
    resourceType: "conversation",
    permission: "memory_edit",
  },
  "conversation.memory_retarget": {
    resourceType: "conversation",
    permission: "memory_retarget",
  },
  "conversation.memory_delete": {
    resourceType: "conversation",
    permission: "memory_delete",
  },

  "memory.read": { resourceType: "memory_item", permission: "read" },
  "memory.recall": { resourceType: "memory_item", permission: "recall" },
  "memory.write": { resourceType: "memory_item", permission: "write" },
  "memory.edit": { resourceType: "memory_item", permission: "edit" },
  "memory.delete": { resourceType: "memory_item", permission: "delete" },

  "memory_space.read": { resourceType: "memory_space", permission: "read" },
  "memory_space.recall": { resourceType: "memory_space", permission: "recall" },
  "memory_space.write": { resourceType: "memory_space", permission: "write" },
  "memory_space.edit": { resourceType: "memory_space", permission: "edit" },
  "memory_space.delete": { resourceType: "memory_space", permission: "delete" },
  "memory_space.manage": { resourceType: "memory_space", permission: "manage" },

  "plugin_installation.view": {
    resourceType: "plugin_installation",
    permission: "view",
  },
  "plugin_installation.use": {
    resourceType: "plugin_installation",
    permission: "use",
  },
  "plugin_installation.edit": {
    resourceType: "plugin_installation",
    permission: "edit",
  },
  "plugin_installation.grant": {
    resourceType: "plugin_installation",
    permission: "grant",
  },
  "plugin_installation.delete": {
    resourceType: "plugin_installation",
    permission: "delete",
  },

  "installed_skill.view": {
    resourceType: "installed_skill",
    permission: "view",
  },
  "installed_skill.use": { resourceType: "installed_skill", permission: "use" },
  "installed_skill.edit": {
    resourceType: "installed_skill",
    permission: "edit",
  },
  "installed_skill.grant": {
    resourceType: "installed_skill",
    permission: "grant",
  },
  "installed_skill.delete": {
    resourceType: "installed_skill",
    permission: "delete",
  },

  // v3 device-runtime parallel actions.
  "device_capability.view": {
    resourceType: "device_capability",
    permission: "view",
  },
  "device_capability.use": {
    resourceType: "device_capability",
    permission: "use",
  },
  "device_capability.request_runtime_authorization": {
    resourceType: "device_capability",
    permission: "request_runtime_authorization",
  },
  "device_capability.edit": {
    resourceType: "device_capability",
    permission: "edit",
  },
  "device_capability.grant": {
    resourceType: "device_capability",
    permission: "grant",
  },
  "device_capability.delete": {
    resourceType: "device_capability",
    permission: "delete",
  },

  "model_group.use": { resourceType: "model_group", permission: "use" },
  "model_group.view": { resourceType: "model_group", permission: "view" },
  "model_group.edit": { resourceType: "model_group", permission: "edit" },
  "model_group.attach": { resourceType: "model_group", permission: "attach" },
  "model_group.grant": { resourceType: "model_group", permission: "grant" },
  "model_group.delete": { resourceType: "model_group", permission: "delete" },

  "model_profile.use": { resourceType: "model_profile", permission: "use" },
  "model_profile.view": { resourceType: "model_profile", permission: "view" },
  "model_profile.edit": { resourceType: "model_profile", permission: "edit" },
  "model_profile.attach": {
    resourceType: "model_profile",
    permission: "attach",
  },
  "model_profile.grant": { resourceType: "model_profile", permission: "grant" },
  "model_profile.delete": {
    resourceType: "model_profile",
    permission: "delete",
  },

  "automation_event_source.use": {
    resourceType: "automation_event_source",
    permission: "use",
  },
  "automation_event_source.view": {
    resourceType: "automation_event_source",
    permission: "view",
  },
  "automation_event_source.edit": {
    resourceType: "automation_event_source",
    permission: "edit",
  },
  "automation_event_source.grant": {
    resourceType: "automation_event_source",
    permission: "grant",
  },
  "automation_event_source.delete": {
    resourceType: "automation_event_source",
    permission: "delete",
  },
} as const satisfies Record<
  string,
  { resourceType: AccessResourceType; permission: string }
>

export type AccessAction = keyof typeof ACCESS_ACTIONS

export function getAccessActionSpec(action: AccessAction) {
  return ACCESS_ACTIONS[action]
}
