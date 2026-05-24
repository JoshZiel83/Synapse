/**
 * Canonical subject and access-related enums for the authorization system.
 *
 * These are the single source of truth shared between API, web, and DB enum-compat
 * assertions. All other modules should reference these instead of declaring local
 * literal unions.
 */

export const SUBJECT_KIND = {
  WORKSPACE: "workspace",
  WORKSPACE_MEMBER: "workspace_member",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
  CONVERSATION: "conversation",
  CONVERSATION_ACTOR_CONTEXT: "conversation_actor_context",
  USER: "user",
  EXTERNAL: "external",
  SYSTEM: "system",
} as const

export const SUBJECT_KINDS = [
  SUBJECT_KIND.WORKSPACE,
  SUBJECT_KIND.WORKSPACE_MEMBER,
  SUBJECT_KIND.ACTOR,
  SUBJECT_KIND.REMOTE_AGENT,
  SUBJECT_KIND.CONVERSATION,
  SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
  SUBJECT_KIND.USER,
  SUBJECT_KIND.EXTERNAL,
  SUBJECT_KIND.SYSTEM,
] as const

export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/**
 * Resource types recognized by the access evaluator. A superset of the resources
 * that can be the target of an explicit binding row (see ACCESS_BINDABLE_RESOURCE_TYPES).
 */
export const ACCESS_RESOURCE_TYPE = {
  PLATFORM: "platform",
  WORKSPACE: "workspace",
  WORKSPACE_MEMBER: "workspace_member",
  USER: "user",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
  INSTALLED_SKILL: "installed_skill",
  PLUGIN_INSTALLATION: "plugin_installation",
  AUTOMATION_EVENT_SOURCE: "automation_event_source",
  RELAY_DEVICE: "relay_device",
  RELAY_EXPOSURE: "relay_exposure",
  RELAY_CAPABILITY: "relay_capability",
  CONVERSATION_ACTOR_CONTEXT: "conversation_actor_context",
  CONVERSATION: "conversation",
  MEMORY_SPACE: "memory_space",
  MEMORY_ITEM: "memory_item",
  MODEL_GROUP: "model_group",
  MODEL_PROFILE: "model_profile",
} as const

export const ACCESS_RESOURCE_TYPES = [
  ACCESS_RESOURCE_TYPE.PLATFORM,
  ACCESS_RESOURCE_TYPE.WORKSPACE,
  ACCESS_RESOURCE_TYPE.WORKSPACE_MEMBER,
  ACCESS_RESOURCE_TYPE.USER,
  ACCESS_RESOURCE_TYPE.ACTOR,
  ACCESS_RESOURCE_TYPE.REMOTE_AGENT,
  ACCESS_RESOURCE_TYPE.INSTALLED_SKILL,
  ACCESS_RESOURCE_TYPE.PLUGIN_INSTALLATION,
  ACCESS_RESOURCE_TYPE.AUTOMATION_EVENT_SOURCE,
  ACCESS_RESOURCE_TYPE.RELAY_DEVICE,
  ACCESS_RESOURCE_TYPE.RELAY_EXPOSURE,
  ACCESS_RESOURCE_TYPE.RELAY_CAPABILITY,
  ACCESS_RESOURCE_TYPE.CONVERSATION_ACTOR_CONTEXT,
  ACCESS_RESOURCE_TYPE.CONVERSATION,
  ACCESS_RESOURCE_TYPE.MEMORY_SPACE,
  ACCESS_RESOURCE_TYPE.MEMORY_ITEM,
  ACCESS_RESOURCE_TYPE.MODEL_GROUP,
  ACCESS_RESOURCE_TYPE.MODEL_PROFILE,
] as const

export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number]

/**
 * Resources that support explicit binding rows in `resource_access_bindings`.
 * A strict subset of ACCESS_RESOURCE_TYPES.
 */
export const ACCESS_BINDABLE_RESOURCE_TYPE = {
  INSTALLED_SKILL: "installed_skill",
  PLUGIN_INSTALLATION: "plugin_installation",
  RELAY_CAPABILITY: "relay_capability",
  AUTOMATION_EVENT_SOURCE: "automation_event_source",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
} as const

export const ACCESS_BINDABLE_RESOURCE_TYPES = [
  ACCESS_BINDABLE_RESOURCE_TYPE.INSTALLED_SKILL,
  ACCESS_BINDABLE_RESOURCE_TYPE.PLUGIN_INSTALLATION,
  ACCESS_BINDABLE_RESOURCE_TYPE.RELAY_CAPABILITY,
  ACCESS_BINDABLE_RESOURCE_TYPE.AUTOMATION_EVENT_SOURCE,
  ACCESS_BINDABLE_RESOURCE_TYPE.ACTOR,
  ACCESS_BINDABLE_RESOURCE_TYPE.REMOTE_AGENT,
] as const

export type AccessBindableResourceType =
  (typeof ACCESS_BINDABLE_RESOURCE_TYPES)[number]

/**
 * Lifecycle status of a `resource_access_bindings` row.
 */
export const ACCESS_BINDING_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const

export const ACCESS_BINDING_STATUSES = [
  ACCESS_BINDING_STATUS.ACTIVE,
  ACCESS_BINDING_STATUS.REVOKED,
] as const

export type AccessBindingStatus = (typeof ACCESS_BINDING_STATUSES)[number]

/**
 * Provenance marker for binding rows — distinguishes manually-granted rows from
 * rows auto-created by lifecycle hooks (e.g. actor-default-open, relay auto-skill).
 */
export const ACCESS_BINDING_SOURCE = {
  MANUAL: "manual",
  DEFAULT_OPEN: "default_open",
  RELAY_AUTO: "relay_auto",
  APPROVAL: "approval",
  SYSTEM: "system",
} as const

export const ACCESS_BINDING_SOURCES = [
  ACCESS_BINDING_SOURCE.MANUAL,
  ACCESS_BINDING_SOURCE.DEFAULT_OPEN,
  ACCESS_BINDING_SOURCE.RELAY_AUTO,
  ACCESS_BINDING_SOURCE.APPROVAL,
  ACCESS_BINDING_SOURCE.SYSTEM,
] as const

export type AccessBindingSource = (typeof ACCESS_BINDING_SOURCES)[number]
