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

export const WORKSPACE_RESOURCE_KIND = {
  PLUGIN_INSTALLATION: "plugin_installation",
  INSTALLED_SKILL: "installed_skill",
  ACTOR: "actor",
  REMOTE_AGENT: "remote_agent",
  RUNTIME_CAPABILITY: "runtime_capability",
  AUTOMATION_EVENT_SOURCE: "automation_event_source",
} as const

export const WORKSPACE_RESOURCE_KINDS = [
  WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION,
  WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL,
  WORKSPACE_RESOURCE_KIND.ACTOR,
  WORKSPACE_RESOURCE_KIND.REMOTE_AGENT,
  WORKSPACE_RESOURCE_KIND.RUNTIME_CAPABILITY,
  WORKSPACE_RESOURCE_KIND.AUTOMATION_EVENT_SOURCE,
] as const

export type WorkspaceResourceKind = (typeof WORKSPACE_RESOURCE_KINDS)[number]

export const WORKSPACE_RESOURCE_STATUS = {
  ACTIVE: "active",
  DISABLED: "disabled",
  ERROR: "error",
  DEPRECATED: "deprecated",
  ARCHIVED: "archived",
} as const

export const WORKSPACE_RESOURCE_STATUSES = [
  WORKSPACE_RESOURCE_STATUS.ACTIVE,
  WORKSPACE_RESOURCE_STATUS.DISABLED,
  WORKSPACE_RESOURCE_STATUS.ERROR,
  WORKSPACE_RESOURCE_STATUS.DEPRECATED,
  WORKSPACE_RESOURCE_STATUS.ARCHIVED,
] as const

export type WorkspaceResourceStatus =
  (typeof WORKSPACE_RESOURCE_STATUSES)[number]

export const WORKSPACE_RESOURCE_GRANT_PERMISSION = {
  USE: "use",
  MANAGE: "manage",
  CONTACT_VISIBLE: "contact_visible",
} as const

export const WORKSPACE_RESOURCE_GRANT_PERMISSIONS = [
  WORKSPACE_RESOURCE_GRANT_PERMISSION.USE,
  WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE,
  WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE,
] as const

export type WorkspaceResourceGrantPermission =
  (typeof WORKSPACE_RESOURCE_GRANT_PERMISSIONS)[number]

export const WORKSPACE_RESOURCE_GRANT_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const

export const WORKSPACE_RESOURCE_GRANT_STATUSES = [
  WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
  WORKSPACE_RESOURCE_GRANT_STATUS.REVOKED,
] as const

export type WorkspaceResourceGrantStatus =
  (typeof WORKSPACE_RESOURCE_GRANT_STATUSES)[number]

export const WORKSPACE_RESOURCE_GRANT_SOURCE = {
  MANUAL: "manual",
  APPROVAL: "approval",
  SYSTEM: "system",
} as const

export const WORKSPACE_RESOURCE_GRANT_SOURCES = [
  WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
  WORKSPACE_RESOURCE_GRANT_SOURCE.APPROVAL,
  WORKSPACE_RESOURCE_GRANT_SOURCE.SYSTEM,
] as const

export type WorkspaceResourceGrantSource =
  (typeof WORKSPACE_RESOURCE_GRANT_SOURCES)[number]

export const WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
} as const

export const WORKSPACE_RESOURCE_GRANT_REQUEST_STATUSES = [
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.PENDING,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.APPROVED,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.REJECTED,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUS.CANCELLED,
] as const

export type WorkspaceResourceGrantRequestStatus =
  (typeof WORKSPACE_RESOURCE_GRANT_REQUEST_STATUSES)[number]

export const WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION = {
  INCOMING: "incoming",
  OUTGOING: "outgoing",
} as const

export const WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS = [
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.INCOMING,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTION.OUTGOING,
] as const

export type WorkspaceResourceGrantRequestDirection =
  (typeof WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS)[number]

/**
 * Resource types recognized by the access evaluator.
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
  RUNTIME: "runtime",
  RUNTIME_EXPOSURE: "runtime_exposure",
  RUNTIME_CAPABILITY: "runtime_capability",
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
  ACCESS_RESOURCE_TYPE.RUNTIME,
  ACCESS_RESOURCE_TYPE.RUNTIME_EXPOSURE,
  ACCESS_RESOURCE_TYPE.RUNTIME_CAPABILITY,
  ACCESS_RESOURCE_TYPE.CONVERSATION,
  ACCESS_RESOURCE_TYPE.MEMORY_SPACE,
  ACCESS_RESOURCE_TYPE.MEMORY_ITEM,
  ACCESS_RESOURCE_TYPE.MODEL_GROUP,
] as const

export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number]

/**
 * Lifecycle status of an access grant row.
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
