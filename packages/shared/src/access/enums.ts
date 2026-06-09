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
  USER: "user",
  EXTERNAL: "external",
  PLATFORM: "platform",
} as const

export const SUBJECT_KINDS = [
  SUBJECT_KIND.WORKSPACE,
  SUBJECT_KIND.WORKSPACE_MEMBER,
  SUBJECT_KIND.ACTOR,
  SUBJECT_KIND.REMOTE_AGENT,
  SUBJECT_KIND.CONVERSATION,
  SUBJECT_KIND.USER,
  SUBJECT_KIND.EXTERNAL,
  SUBJECT_KIND.PLATFORM,
] as const

export type SubjectKind = (typeof SUBJECT_KINDS)[number]

export const WORKSPACE_APP_KIND = {
  PLUGIN_INSTALLATION: "plugin_installation",
  INSTALLED_SKILL: "installed_skill",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
  DEVICE_CAPABILITY: "device_capability",
} as const

export const WORKSPACE_APP_KINDS = [
  WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
  WORKSPACE_APP_KIND.INSTALLED_SKILL,
  WORKSPACE_APP_KIND.ACTOR,
  WORKSPACE_APP_KIND.REMOTE_AGENT,
  WORKSPACE_APP_KIND.DEVICE_CAPABILITY,
] as const

export type WorkspaceAppKind = (typeof WORKSPACE_APP_KINDS)[number]

export const WORKSPACE_APP_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled",
  ERROR: "error",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
} as const

export const WORKSPACE_APP_STATUSES = [
  WORKSPACE_APP_STATUS.ACTIVE,
  WORKSPACE_APP_STATUS.DISABLED,
  WORKSPACE_APP_STATUS.ERROR,
  WORKSPACE_APP_STATUS.DEPRECATED,
  WORKSPACE_APP_STATUS.ARCHIVED,
] as const

export type WorkspaceAppStatus = (typeof WORKSPACE_APP_STATUSES)[number]

export const WORKSPACE_APP_GRANT_PERMISSION = {
  USE: "use",
  MANAGE: "manage",
  CONTACT_VISIBLE: "contact_visible",
} as const

export const WORKSPACE_APP_GRANT_PERMISSIONS = [
  WORKSPACE_APP_GRANT_PERMISSION.USE,
  WORKSPACE_APP_GRANT_PERMISSION.MANAGE,
  WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE,
] as const

export type WorkspaceAppGrantPermission =
  (typeof WORKSPACE_APP_GRANT_PERMISSIONS)[number]

export const WORKSPACE_APP_GRANT_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const

export const WORKSPACE_APP_GRANT_STATUSES = [
  WORKSPACE_APP_GRANT_STATUS.ACTIVE,
  WORKSPACE_APP_GRANT_STATUS.REVOKED,
] as const

export type WorkspaceAppGrantStatus =
  (typeof WORKSPACE_APP_GRANT_STATUSES)[number]

export const WORKSPACE_APP_GRANT_SOURCE = {
  MANUAL: "manual",
  APPROVAL: "approval",
  SYSTEM: "system",
} as const

export const WORKSPACE_APP_GRANT_SOURCES = [
  WORKSPACE_APP_GRANT_SOURCE.MANUAL,
  WORKSPACE_APP_GRANT_SOURCE.APPROVAL,
  WORKSPACE_APP_GRANT_SOURCE.SYSTEM,
] as const

export type WorkspaceAppGrantSource =
  (typeof WORKSPACE_APP_GRANT_SOURCES)[number]

export const WORKSPACE_APP_GRANT_REQUEST_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const

export const WORKSPACE_APP_GRANT_REQUEST_STATUSES = [
  WORKSPACE_APP_GRANT_REQUEST_STATUS.PENDING,
  WORKSPACE_APP_GRANT_REQUEST_STATUS.APPROVED,
  WORKSPACE_APP_GRANT_REQUEST_STATUS.REJECTED,
  WORKSPACE_APP_GRANT_REQUEST_STATUS.CANCELLED,
] as const

export type WorkspaceAppGrantRequestStatus =
  (typeof WORKSPACE_APP_GRANT_REQUEST_STATUSES)[number]

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
  DEVICE: "device",
  DEVICE_EXPOSURE: "device_exposure",
  DEVICE_CAPABILITY: "device_capability",
  CONVERSATION: "conversation",
  MEMORY_SPACE: "memory_space",
  MEMORY_ITEM: "memory_item",
  MODEL_GROUP: "model_group",
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
  ACCESS_RESOURCE_TYPE.DEVICE,
  ACCESS_RESOURCE_TYPE.DEVICE_EXPOSURE,
  ACCESS_RESOURCE_TYPE.DEVICE_CAPABILITY,
  ACCESS_RESOURCE_TYPE.CONVERSATION,
  ACCESS_RESOURCE_TYPE.MEMORY_SPACE,
  ACCESS_RESOURCE_TYPE.MEMORY_ITEM,
  ACCESS_RESOURCE_TYPE.MODEL_GROUP,
] as const

export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number]

/**
 * Resources that still use the legacy `resource_access_bindings` junction.
 * Workspace-app resources have moved to `workspace_app_grants`; the old table
 * remains only for automation event sources.
 */
export const ACCESS_BINDABLE_RESOURCE_TYPE = {
  AUTOMATION_EVENT_SOURCE: "automation_event_source",
} as const

export const ACCESS_BINDABLE_RESOURCE_TYPES = [
  ACCESS_BINDABLE_RESOURCE_TYPE.AUTOMATION_EVENT_SOURCE,
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
 * rows auto-created by lifecycle hooks (e.g. actor-default-open).
 */
export const ACCESS_BINDING_SOURCE = {
  MANUAL: "manual",
  DEFAULT_OPEN: "default_open",
  APPROVAL: "approval",
  SYSTEM: "system",
} as const

export const ACCESS_BINDING_SOURCES = [
  ACCESS_BINDING_SOURCE.MANUAL,
  ACCESS_BINDING_SOURCE.DEFAULT_OPEN,
  ACCESS_BINDING_SOURCE.APPROVAL,
  ACCESS_BINDING_SOURCE.SYSTEM,
] as const

export type AccessBindingSource = (typeof ACCESS_BINDING_SOURCES)[number]

/**
 * subject-scope-refactor: memory_access_grants table permissions. Grants can
 * be scoped to a memory_space or a single memory_item; the same permission
 * tuple applies to both. Used by memory module access-grant-storage and by
 * evaluator's hasMemoryItemPermission / hasMemorySpacePermission to honor
 * explicit grants on top of legacy space_type-based decision tree.
 */
export const MEMORY_PERMISSION = {
  READ: "read",
  RECALL: "recall",
  WRITE: "write",
  EDIT: "edit",
  DELETE: "delete",
  MANAGE: "manage",
} as const

export const MEMORY_PERMISSIONS = [
  MEMORY_PERMISSION.READ,
  MEMORY_PERMISSION.RECALL,
  MEMORY_PERMISSION.WRITE,
  MEMORY_PERMISSION.EDIT,
  MEMORY_PERMISSION.DELETE,
  MEMORY_PERMISSION.MANAGE,
] as const

export type MemoryPermission = (typeof MEMORY_PERMISSIONS)[number]

export const MEMORY_ACCESS_GRANT_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
  SUPERSEDED: "superseded",
} as const

export const MEMORY_ACCESS_GRANT_STATUSES = [
  MEMORY_ACCESS_GRANT_STATUS.ACTIVE,
  MEMORY_ACCESS_GRANT_STATUS.REVOKED,
  MEMORY_ACCESS_GRANT_STATUS.SUPERSEDED,
] as const

export type MemoryAccessGrantStatus =
  (typeof MEMORY_ACCESS_GRANT_STATUSES)[number]
