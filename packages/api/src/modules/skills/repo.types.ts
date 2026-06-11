import type { RuntimeBindingScope } from "@synapse/shared"

/**
 * Skills repo layer record/projection shapes. These describe the raw SQL row
 * projections read by the service and mapped by the presenter. They live here
 * (the repo layer) so the repo owns the record shapes — both service.ts and
 * presenter.ts import them from this module. This file is a "repo" file: it may
 * reference generated/db row types, but must never import from ./service.js or
 * ./presenter.js (that would create an import cycle).
 */

export type SkillSnapshotJoinRow = {
  snapshot_id: string | null
  snapshot_entry_path: string | null
  snapshot_display_name: string | null
  snapshot_description: string | null
  snapshot_argument_hint: string | null
  snapshot_disable_model_invocation: boolean | null
  snapshot_user_invocable: boolean | null
  snapshot_allowed_tools: string[] | null
  snapshot_model: string | null
  snapshot_effort: "low" | "medium" | "high" | "max" | null
  snapshot_context: "fork" | null
  snapshot_agent: string | null
  snapshot_hooks: unknown
  snapshot_body_blocks: unknown
  snapshot_content_hash: string | null
  snapshot_source_warnings: string[] | null
  snapshot_resolved_revision: string | null
  snapshot_created_at: Date | null
  mirror_source_id: string | null
  mirror_source_type: "github" | "clawhub" | null
  mirror_locator_key: string | null
  mirror_locator: unknown
  mirror_requested_ref: string | null
  mirror_resolved_revision: string | null
  mirror_refresh_mode: "manual" | null
  mirror_last_sync_status: "pending" | "synced" | "error" | null
  mirror_source_warnings: string[] | null
  mirror_last_error: string | null
  mirror_last_synced_at: Date | null
  mirror_created_at: Date | null
  mirror_updated_at: Date | null
}

export type SkillPackageRow = {
  item_id: string
  item_slug: string
  item_display_name: string
  item_summary: string
  item_long_description: string
  item_tags: string[] | null
  item_is_active: boolean
  item_download_count: number
  item_icon_file_id: string | null
  item_metadata: unknown
  item_created_at: Date
  item_updated_at: Date
  latest_version_id: string | null
  latest_version_value: string | null
  latest_version_changelog: string | null
  latest_version_created_by_user_id: string | null
  latest_version_created_at: Date | null
  spec_default_conversation_type_mask: number | null
  publisher_id: string
  publisher_slug: string
  publisher_display_name: string
  publisher_owner_user_id: string | null
} & SkillSnapshotJoinRow

export type InstalledSkillRow = {
  skill_id: string
  workspace_id: string
  display_name: string
  icon_file_id: string | null
  tags: string[] | null
  current_version: number
  skill_status: "active" | "disabled" | "archived"
  conversation_type_mask_override: number | null
  owner_workspace_member_id: string | null
  created_at: Date
  updated_at: Date
  current_snapshot_id: string
  current_skill_version_id: string
  current_skill_snapshot_id: string
  version_metadata: unknown
  source_catalog_item_id: string | null
  source_catalog_version_id: string | null
  source_sync_mode:
    | "notify"
    | "manual_merge"
    | "follow_upstream"
    | "detached"
    | null
  source_is_customized: boolean | null
  source_slug: string | null
  source_latest_version_id: string | null
  source_version_value: string | null
  latest_source_version: string | null
  source_default_conversation_type_mask: number | null
} & SkillSnapshotJoinRow

export type SkillSnapshotFileRow = {
  id: string
  skill_snapshot_id: string
  path: string
  media_type: string | null
  content_blocks: unknown
  created_at: Date
  updated_at: Date
}

export type SkillAccessRow = {
  id: string
  workspace_id: string
  skill_id: string
  bind_scope: RuntimeBindingScope
  conversation_id: string | null
  actor_id: string | null
  // Round 9 review (P2): include remote_agent_id so dedup paths that
  // currently key on (actor_id, conversation_id, workspace_member_id)
  // can also discriminate remote_agent targets.
  remote_agent_id: string | null
  workspace_member_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: Date | null
  revoked_at: Date | null
}

export type VisibleSkillRow = {
  access_binding_id: string
  skill_id: string
  workspace_id: string
  access_bind_scope: RuntimeBindingScope
  conversation_id: string | null
  actor_id: string | null
  remote_agent_id: string | null
  workspace_member_id: string | null
  display_name: string
  current_version: number
  current_skill_version_id: string
  description: string
  source_slug: string | null
  source_version_value: string | null
  conversation_type_mask_override: number | null
  access_created_at: Date
}

export type InstallationSummary = {
  installed: boolean
  installedCount: number
  installedSkillId?: string
}
