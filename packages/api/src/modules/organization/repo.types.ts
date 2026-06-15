import type {
  ActorDoc,
  ActorRole,
  ActorUpdateSourceType,
  ActorVersionDelta,
  MarketplaceSyncMode,
  MarketplaceVersionStatus,
} from "@synapse/shared"

/**
 * Organization repo layer record/projection shapes. These describe the raw
 * SQL row projections read by the service and mapped by the presenter. They
 * live here (the repo layer) so the repo owns the record shapes — both
 * service.ts and presenter.ts import them from this module. This file is a
 * "repo" file: it may reference generated/db row types, but must never import
 * from ./service.js or ./presenter.js (that would create an import cycle).
 */

export type ActorRow = {
  id: string
  workspace_id: string
  display_name: string
  role: ActorRole
  title: string
  avatar_file_id: string | null
  avatar_emoji: string | null
  parent_id: string | null
  can_represent_user: boolean
  specialties: string[] | null
  config: Record<string, unknown>
  current_version: number
  is_active: boolean
  is_public_shared: boolean
  created_at: Date
  updated_at: Date
  current_actor_version_id: string
  source_catalog_item_id: string | null
  source_catalog_version_id: string | null
  source_sync_mode: MarketplaceSyncMode | null
  source_baseline_actor_version: number | null
  source_created_at: Date | null
  source_updated_at: Date | null
  source_slug: string | null
  source_display_name: string | null
  source_latest_version_id: string | null
  source_publisher_slug: string | null
  source_publisher_display_name: string | null
  source_imported_version: string | null
  source_latest_version: string | null
}

export type ActorVersionRow = {
  id: string
  actor_id: string
  version: number
  previous_version_id: string | null
  display_name: string
  role: ActorRole
  title: string
  parent_id: string | null
  can_represent_user: boolean
  specialties: string[] | null
  config: Record<string, unknown>
  version_delta: ActorVersionDelta | null
  created_by_workspace_member_id: string | null
  source_type: ActorUpdateSourceType
  source_workspace_member_id: string | null
  source_actor_id: string | null
  source_session_id: string | null
  source_turn_id: string | null
  source_conversation_id: string | null
  source_reason: string | null
  created_at: Date
}

/**
 * Presenter input for an actor version: the raw version row paired with its
 * resolved docs. The service assembles this record (row + docs) and the
 * controller maps it through {@link presentActorVersionRow} at the boundary,
 * keeping `serializeInstant` (Date→IsoInstantString) in the presenter layer.
 */
export type ActorVersionRecord = {
  row: ActorVersionRow
  docs: ActorDoc[]
}

export type ActorPackageRow = {
  package_id: string
  package_workspace_id: string | null
  package_slug: string
  package_display_name: string
  package_icon_file_id: string | null
  package_summary: string
  package_long_description: string
  package_source_kind: "builtin" | "official" | "workspace" | "user"
  package_visibility: "public" | "workspace" | "private"
  package_tags: string[] | null
  package_download_count: number
  package_is_active: boolean
  package_metadata: Record<string, unknown>
  package_created_at: Date
  package_updated_at: Date
  publisher_id: string
  publisher_slug: string
  publisher_display_name: string
  publisher_description: string
  publisher_owner_user_id: string | null
  publisher_workspace_id: string | null
  publisher_is_builtin: boolean
  publisher_is_verified: boolean
  publisher_created_at: Date
  publisher_updated_at: Date
  version_id: string
  version_value: string
  version_status: MarketplaceVersionStatus
  version_changelog: string
  version_metadata: Record<string, unknown>
  version_created_by_user_id: string | null
  version_created_at: Date
  actor_role: ActorRole
  actor_display_name: string
  actor_avatar_file_id: string | null
  actor_avatar_emoji: string | null
  actor_title: string
  actor_can_represent_user: boolean
  actor_docs: unknown
  actor_specialties: string[] | null
  actor_config: Record<string, unknown>
  actor_metadata: Record<string, unknown>
}
