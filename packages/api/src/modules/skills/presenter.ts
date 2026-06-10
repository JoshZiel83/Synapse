import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  WORKSPACE_APP_GRANT_PERMISSION,
  parseJsonObject,
  resolveNarrowedConversationTypeMask,
  workspaceRef,
  type CapabilityAccessTarget,
  type InstalledSkill,
  type SkillAttachmentFile,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  type WorkspaceAppGrant,
} from "@synapse/shared"
import {
  dateToIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import { SKILL_ENTRY_PATH, buildSyntheticEntryFile } from "./manifest.js"
import {
  bodyBlocksFromSnapshotRow,
  descriptionBlockFromSnapshotRow,
  frontmatterFromSnapshotRow,
  normalizeStoredBlocks,
  resolveInstalledSkillEffectiveConversationTypeMask,
  resolveInstalledSkillSourceConversationTypeMask,
  skillBindingToAccessTarget,
  visibleRowToAccessTarget,
  type InstalledSkillRow,
  type InstallationSummary,
  type SkillAccessRow,
  type SkillPackageRow,
  type SkillSnapshotFileRow,
  type SkillSnapshotJoinRow,
  type VisibleSkillRow,
} from "./service.js"

/**
 * Skills presentation layer: DB row → app-facing view DTO. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller never
 * call serializeInstant (guard-layering r3). Row inputs are taken structurally
 * via `import type` from service.ts — this file must not import generated/db.
 */

export function buildSkillAttachmentFromCatalogFile(
  row: SkillSnapshotFileRow
): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    mediaType: row.media_type || undefined,
    contentBlocks: normalizeStoredBlocks(row.content_blocks),
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    updatedAt: serializeInstant(row.updated_at),
  }
}

export function buildMirrorSourceSummary(row: SkillSnapshotJoinRow) {
  if (
    !row.mirror_source_id ||
    !row.mirror_source_type ||
    !row.mirror_locator_key
  ) {
    return undefined
  }

  return {
    id: row.mirror_source_id,
    sourceType: row.mirror_source_type,
    locatorKey: row.mirror_locator_key,
    locator: parseJsonObject(row.mirror_locator),
    requestedRef: row.mirror_requested_ref || undefined,
    resolvedRevision:
      row.snapshot_resolved_revision ||
      row.mirror_resolved_revision ||
      undefined,
    refreshMode: row.mirror_refresh_mode || "manual",
    lastSyncStatus: row.mirror_last_sync_status || "pending",
    sourceWarnings: row.mirror_source_warnings || [],
    lastError: row.mirror_last_error || undefined,
    lastSyncedAt: serializeOptionalInstant(row.mirror_last_synced_at),
    createdAt:
      serializeOptionalInstant(row.mirror_created_at) ||
      serializeOptionalInstant(row.snapshot_created_at) ||
      dateToIsoInstant(new Date(0)),
    updatedAt:
      serializeOptionalInstant(row.mirror_updated_at) ||
      serializeOptionalInstant(row.snapshot_created_at) ||
      dateToIsoInstant(new Date(0)),
  }
}

function buildSyntheticEntryAttachment(
  row: SkillSnapshotJoinRow,
  timestamp: IsoInstantString
): SkillAttachmentFile {
  const synthetic = buildSyntheticEntryFile({
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
  })

  return {
    id: `${row.snapshot_id}:entry`,
    path: synthetic.path,
    mediaType: synthetic.mediaType,
    contentBlocks: synthetic.contentBlocks,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function buildSnapshotAttachmentFiles(
  row: SkillSnapshotJoinRow,
  timestamp: IsoInstantString,
  files?: SkillAttachmentFile[]
) {
  return [buildSyntheticEntryAttachment(row, timestamp), ...(files || [])]
}

function resolveMarketplaceSkillDefaultConversationTypeMask(
  row: SkillPackageRow
) {
  return (
    row.spec_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK
  )
}

function mapMarketplaceVersion(
  row: SkillPackageRow,
  files?: SkillAttachmentFile[]
): SkillMarketplaceVersion | undefined {
  if (!row.latest_version_id || !row.latest_version_value) {
    return undefined
  }

  return {
    id: row.latest_version_id,
    skillId: row.item_id,
    version: row.latest_version_value,
    changelog: row.latest_version_changelog || "",
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshot_entry_path || SKILL_ENTRY_PATH,
    contentHash: row.snapshot_content_hash || "",
    sourceWarnings: row.snapshot_source_warnings || [],
    resolvedRevision: row.snapshot_resolved_revision || undefined,
    description: descriptionBlockFromSnapshotRow(row),
    defaultConversationTypeMask:
      row.spec_default_conversation_type_mask || DEFAULT_CONVERSATION_TYPE_MASK,
    createdByUserId: row.latest_version_created_by_user_id || undefined,
    createdAt:
      serializeOptionalInstant(row.latest_version_created_at) ||
      serializeInstant(row.item_updated_at),
    files: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latest_version_created_at) ||
        serializeInstant(row.item_updated_at),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latest_version_created_at) ||
        serializeInstant(row.item_updated_at),
      files
    ),
  }
}

export function mapMarketplaceEntry(
  row: SkillPackageRow,
  installation?: InstallationSummary,
  files?: SkillAttachmentFile[]
): SkillMarketplaceEntry {
  const defaultConversationTypeMask =
    resolveMarketplaceSkillDefaultConversationTypeMask(row)
  return {
    id: row.item_id,
    slug: row.item_slug,
    name: row.snapshot_display_name || row.item_display_name,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.item_icon_file_id
      ? getFileUrlById(row.item_icon_file_id)
      : undefined,
    tags: row.item_tags || [],
    authorUserId: row.publisher_owner_user_id || undefined,
    authorName: row.publisher_display_name || undefined,
    isActive: Boolean(row.item_is_active),
    createdAt: serializeInstant(row.item_created_at),
    updatedAt: serializeInstant(row.item_updated_at),
    defaultConversationTypeMask,
    latestVersionId: row.latest_version_id || undefined,
    latestVersion: mapMarketplaceVersion(row, files),
    mirrorSource: buildMirrorSourceSummary(row),
    workspaceInstallation: installation,
  }
}

export function buildInstalledSkillPayload(
  row: InstalledSkillRow,
  binding: SkillAccessRow | undefined,
  workspaceConversationTypeMask: number,
  files?: SkillAttachmentFile[]
): InstalledSkill {
  const chosenBinding = binding
  const accessTarget: CapabilityAccessTarget = chosenBinding
    ? skillBindingToAccessTarget(chosenBinding, row.workspace_id)
    : { subject: workspaceRef(row.workspace_id) }
  const sourceDefaultConversationTypeMask =
    resolveInstalledSkillSourceConversationTypeMask(row)
  const effectiveConversationTypeMask =
    resolveInstalledSkillEffectiveConversationTypeMask({
      workspaceConversationTypeMask,
      conversation_type_mask_override: row.conversation_type_mask_override,
    })

  return {
    id: row.skill_id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshot_entry_path || SKILL_ENTRY_PATH,
    contentHash: row.snapshot_content_hash || "",
    sourceWarnings: row.snapshot_source_warnings || [],
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.icon_file_id ? getFileUrlById(row.icon_file_id) : undefined,
    tags: row.tags || [],
    accessTarget,
    isEnabled: row.skill_status === "active",
    sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask,
    conversationTypeMaskOverride:
      row.conversation_type_mask_override || undefined,
    effectiveConversationTypeMask,
    isCustomized: Boolean(
      row.source_catalog_item_id && row.source_is_customized
    ),
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    updatedAt: serializeInstant(row.updated_at),
    sourceSkillId: row.source_catalog_item_id || undefined,
    sourcePackageSlug: row.source_slug || undefined,
    sourceVersionId: row.source_catalog_version_id || undefined,
    sourceVersion: row.source_version_value || undefined,
    upgradeAvailable:
      Boolean(row.source_catalog_item_id) &&
      Boolean(row.source_catalog_version_id) &&
      Boolean(row.source_latest_version_id) &&
      row.source_catalog_version_id !== row.source_latest_version_id,
    latestSourceVersion: row.latest_source_version || undefined,
    files: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updated_at),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updated_at),
      files
    ),
    mirrorSource: buildMirrorSourceSummary(row),
  }
}

export function mapSkillAccessRowToGrant(
  row: SkillAccessRow,
  options?: {
    workspaceConversationTypeMask: number
    instanceConversationTypeMaskOverride: number | null
  }
): WorkspaceAppGrant {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride
        ),
        row.conversation_type_mask_override
      )
    : undefined
  return {
    id: row.id,
    workspaceAppId: row.skill_id,
    workspaceId: row.workspace_id,
    target: visibleRowToAccessTarget({
      skill_id: row.skill_id,
      workspace_id: row.workspace_id,
      access_bind_scope: row.bind_scope,
      conversation_id: row.conversation_id,
      actor_id: row.actor_id,
      remote_agent_id: row.remote_agent_id,
      workspace_member_id: row.workspace_member_id,
    } as VisibleSkillRow),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: row.status,
    source: row.source,
    grantedByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    reason: row.reason || undefined,
    conversationTypeMaskOverride: row.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask,
    createdAt:
      serializeOptionalInstant(row.created_at) || dateToIsoInstant(new Date(0)),
    revokedAt: serializeOptionalInstant(row.revoked_at),
  }
}
