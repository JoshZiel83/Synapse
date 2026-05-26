/**
 * P8: RBAC rules data-driven. Platform and workspace permissions used to be
 * hardcoded as switch/case in evaluator.ts. They are now declarative
 * tables so adding a new permission requires only a data change here, not
 * touching the evaluator dispatch.
 *
 * A future iteration can move these tables into a DB-backed
 * `permission_role_grants` table for runtime mutability without code deploy.
 * The current shape is intentionally pure data so that migration is mechanical.
 */

import { PLATFORM_ACCESS_KEYS, WORKSPACE_ACCESS_KEYS } from "@synapse/shared"

export type PlatformAccessKey = (typeof PLATFORM_ACCESS_KEYS)[number]
export type WorkspaceAccessKey = (typeof WORKSPACE_ACCESS_KEYS)[number]

/**
 * Platform permission → access keys that grant it. A user holding ANY of the
 * listed keys is allowed. Empty array means "any non-empty platform binding"
 * (used for the generic `manage` gate).
 */
export type PlatformPermissionRule =
  | { kind: "any_access_key" }
  | { kind: "specific_keys"; keys: readonly PlatformAccessKey[] }

export const PLATFORM_PERMISSION_RULES: Record<string, PlatformPermissionRule> =
  {
    manage: { kind: "any_access_key" },
    manage_workspaces: {
      kind: "specific_keys",
      keys: ["super_admin", "workspace_admin"],
    },
    manage_models: {
      kind: "specific_keys",
      keys: ["super_admin", "model_admin"],
    },
    support_access: {
      kind: "specific_keys",
      keys: ["super_admin", "support"],
    },
    audit: { kind: "specific_keys", keys: ["super_admin", "auditor"] },
  }

export function evaluatePlatformPermission(
  permission: string,
  accessKeys: readonly string[]
): boolean {
  const rule = PLATFORM_PERMISSION_RULES[permission]
  if (!rule) return false
  switch (rule.kind) {
    case "any_access_key":
      return accessKeys.length > 0
    case "specific_keys":
      return rule.keys.some((key) => accessKeys.includes(key))
  }
}

/**
 * Workspace permission rule structure. Members satisfy a rule if any of:
 *   - they are owner/admin AND `adminGrants` is true
 *   - they hold any access key in `accessKeys`
 *   - their trust level is NOT in `trustLevelExcludes` (used for "everyone
 *     except guests" style rules)
 *   - the rule is `always` (default-true views)
 */
export type WorkspacePermissionRule =
  | { kind: "always" }
  | {
      kind: "admin_or_keys"
      adminGrants: boolean
      accessKeys?: readonly WorkspaceAccessKey[]
    }
  | { kind: "trust_level_excludes"; excludes: readonly string[] }

export const WORKSPACE_PERMISSION_RULES: Record<
  string,
  WorkspacePermissionRule
> = {
  view: { kind: "always" },
  use_actors: { kind: "always" },
  use_remote_agents: { kind: "always" },
  manage: { kind: "admin_or_keys", adminGrants: true },
  manage_members: { kind: "admin_or_keys", adminGrants: true },
  manage_actors: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["actor_admin"],
  },
  manage_remote_agents: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["remote_agent_admin"],
  },
  manage_conversations: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["conversation_admin"],
  },
  manage_skills: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["skill_admin"],
  },
  manage_plugins: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["plugin_admin"],
  },
  manage_memories: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["memory_admin"],
  },
  manage_devices: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["device_admin"],
  },
  manage_models: {
    kind: "admin_or_keys",
    adminGrants: true,
    accessKeys: ["model_admin"],
  },
  create_conversation: {
    kind: "trust_level_excludes",
    excludes: ["guest"],
  },
}

export function evaluateWorkspacePermission(
  permission: string,
  context: {
    isAdmin: boolean
    accessKeys: readonly string[]
    trustLevel: string
  }
): boolean {
  const rule = WORKSPACE_PERMISSION_RULES[permission]
  if (!rule) return false
  switch (rule.kind) {
    case "always":
      return true
    case "admin_or_keys": {
      if (rule.adminGrants && context.isAdmin) return true
      if (!rule.accessKeys) return false
      return rule.accessKeys.some((key) => context.accessKeys.includes(key))
    }
    case "trust_level_excludes":
      return !rule.excludes.includes(context.trustLevel)
  }
}
