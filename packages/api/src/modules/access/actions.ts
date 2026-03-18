import type { AuthzObjectType } from '../../infrastructure/authz/index.js';

export const ACCESS_ACTIONS = {
  'platform.manage': { resourceType: 'platform', permission: 'manage' },
  'platform.manage_workspaces': { resourceType: 'platform', permission: 'manage_workspaces' },
  'platform.manage_models': { resourceType: 'platform', permission: 'manage_models' },
  'platform.support': { resourceType: 'platform', permission: 'support_access' },
  'platform.audit': { resourceType: 'platform', permission: 'audit' },

  'workspace.view': { resourceType: 'workspace', permission: 'view' },
  'workspace.manage': { resourceType: 'workspace', permission: 'manage' },
  'workspace.manage_members': { resourceType: 'workspace', permission: 'manage_members' },
  'workspace.manage_actors': { resourceType: 'workspace', permission: 'manage_actors' },
  'workspace.use_actors': { resourceType: 'workspace', permission: 'use_actors' },
  'workspace.manage_conversations': { resourceType: 'workspace', permission: 'manage_conversations' },
  'workspace.create_conversation': { resourceType: 'workspace', permission: 'create_conversation' },
  'workspace.manage_skills': { resourceType: 'workspace', permission: 'manage_skills' },
  'workspace.manage_plugins': { resourceType: 'workspace', permission: 'manage_plugins' },
  'workspace.manage_memories': { resourceType: 'workspace', permission: 'manage_memories' },
  'workspace.manage_relays': { resourceType: 'workspace', permission: 'manage_relays' },
  'workspace.manage_models': { resourceType: 'workspace', permission: 'manage_models' },

  'actor.discover': { resourceType: 'actor', permission: 'discover' },
  'actor.view': { resourceType: 'actor', permission: 'view' },
  'actor.invoke': { resourceType: 'actor', permission: 'invoke' },
  'actor.receive_message': { resourceType: 'actor', permission: 'receive_message' },
  'actor.memory_read': { resourceType: 'actor', permission: 'memory_read' },
  'actor.memory_edit': { resourceType: 'actor', permission: 'memory_edit' },
  'actor.memory_retarget': { resourceType: 'actor', permission: 'memory_retarget' },
  'actor.memory_delete': { resourceType: 'actor', permission: 'memory_delete' },
  'actor.edit': { resourceType: 'actor', permission: 'edit' },
  'actor.grant': { resourceType: 'actor', permission: 'grant' },
  'actor.delete': { resourceType: 'actor', permission: 'delete' },

  'actor_conversation.memory_read': { resourceType: 'actor_conversation', permission: 'memory_read' },
  'actor_conversation.memory_edit': { resourceType: 'actor_conversation', permission: 'memory_edit' },
  'actor_conversation.memory_retarget': { resourceType: 'actor_conversation', permission: 'memory_retarget' },
  'actor_conversation.memory_delete': { resourceType: 'actor_conversation', permission: 'memory_delete' },

  'conversation.view': { resourceType: 'conversation', permission: 'view' },
  'conversation.send': { resourceType: 'conversation', permission: 'send' },
  'conversation.moderate': { resourceType: 'conversation', permission: 'moderate' },
  'conversation.manage': { resourceType: 'conversation', permission: 'manage' },
  'conversation.manage_members': { resourceType: 'conversation', permission: 'manage_members' },
  'conversation.attach_resources': { resourceType: 'conversation', permission: 'attach_resources' },
  'conversation.memory_read': { resourceType: 'conversation', permission: 'memory_read' },
  'conversation.memory_edit': { resourceType: 'conversation', permission: 'memory_edit' },
  'conversation.memory_retarget': { resourceType: 'conversation', permission: 'memory_retarget' },
  'conversation.memory_delete': { resourceType: 'conversation', permission: 'memory_delete' },

  'memory.read': { resourceType: 'memory', permission: 'read' },
  'memory.recall': { resourceType: 'memory', permission: 'recall' },
  'memory.edit': { resourceType: 'memory', permission: 'edit' },
  'memory.retarget': { resourceType: 'memory', permission: 'retarget' },
  'memory.delete': { resourceType: 'memory', permission: 'delete' },

  'plugin_installation.view': { resourceType: 'plugin_installation', permission: 'view' },
  'plugin_installation.use': { resourceType: 'plugin_installation', permission: 'use' },
  'plugin_installation.edit': { resourceType: 'plugin_installation', permission: 'edit' },
  'plugin_installation.grant': { resourceType: 'plugin_installation', permission: 'grant' },
  'plugin_installation.delete': { resourceType: 'plugin_installation', permission: 'delete' },

  'installed_skill.view': { resourceType: 'installed_skill', permission: 'view' },
  'installed_skill.use': { resourceType: 'installed_skill', permission: 'use' },
  'installed_skill.edit': { resourceType: 'installed_skill', permission: 'edit' },
  'installed_skill.grant': { resourceType: 'installed_skill', permission: 'grant' },
  'installed_skill.delete': { resourceType: 'installed_skill', permission: 'delete' },

  'relay.view': { resourceType: 'mcp_relay', permission: 'view' },
  'relay.invoke': { resourceType: 'mcp_relay', permission: 'invoke' },
  'relay.edit': { resourceType: 'mcp_relay', permission: 'edit' },
  'relay.grant': { resourceType: 'mcp_relay', permission: 'grant' },
  'relay.rotate_token': { resourceType: 'mcp_relay', permission: 'rotate_token' },
  'relay.delete': { resourceType: 'mcp_relay', permission: 'delete' },
  'relay_device.view': { resourceType: 'relay_device', permission: 'view' },
  'relay_device.manage': { resourceType: 'relay_device', permission: 'manage' },
  'relay_device.delete': { resourceType: 'relay_device', permission: 'delete' },
  'relay_exposure.view': { resourceType: 'relay_exposure', permission: 'view' },
  'relay_exposure.invoke': { resourceType: 'relay_exposure', permission: 'invoke' },
  'relay_exposure.edit': { resourceType: 'relay_exposure', permission: 'edit' },
  'relay_exposure.delete': { resourceType: 'relay_exposure', permission: 'delete' },

  'model_group.use': { resourceType: 'model_group', permission: 'use' },
  'model_group.view': { resourceType: 'model_group', permission: 'view' },
  'model_group.edit': { resourceType: 'model_group', permission: 'edit' },
  'model_group.attach': { resourceType: 'model_group', permission: 'attach' },
  'model_group.grant': { resourceType: 'model_group', permission: 'grant' },
  'model_group.delete': { resourceType: 'model_group', permission: 'delete' },

  'model_profile.use': { resourceType: 'model_profile', permission: 'use' },
  'model_profile.view': { resourceType: 'model_profile', permission: 'view' },
  'model_profile.edit': { resourceType: 'model_profile', permission: 'edit' },
  'model_profile.attach': { resourceType: 'model_profile', permission: 'attach' },
  'model_profile.grant': { resourceType: 'model_profile', permission: 'grant' },
  'model_profile.delete': { resourceType: 'model_profile', permission: 'delete' },
} as const satisfies Record<string, { resourceType: AuthzObjectType; permission: string }>;

export type AccessAction = keyof typeof ACCESS_ACTIONS;

export function getAccessActionSpec(action: AccessAction) {
  return ACCESS_ACTIONS[action];
}
