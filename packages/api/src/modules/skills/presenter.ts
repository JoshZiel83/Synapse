import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  WORKSPACE_APP_GRANT_PERMISSION,
  resolveNarrowedConversationTypeMask,
  workspaceRef,
  type CapabilityAccessTarget,
  type InstalledSkill,
  type SkillAttachmentFile,
  type SkillMarketplaceEntry,
  type SkillMarketplaceVersion,
  type WorkspaceAppGrant,
} from "@synapse/shared"
import { type IsoInstantString } from "@synapse/shared/datetime"
import {
  requireInstantDate,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import { SKILL_ENTRY_PATH, buildSyntheticEntryFile } from "./manifest.js"
import { normalizeStoredBlocks } from "./content-block-codec.js"
import {
  bodyBlocksFromSnapshotRow,
  descriptionBlockFromSnapshotRow,
  frontmatterFromSnapshotRow,
  resolveInstalledSkillEffectiveConversationTypeMask,
  resolveInstalledSkillSourceConversationTypeMask,
  skillBindingToAccessTarget,
  visibleRowToAccessTarget,
} from "./service.js"
import type {
  InstallationSummary,
  InstalledSkillRow,
  SkillAccessRow,
  SkillPackageRow,
  SkillSnapshotFileRow,
  SkillSnapshotJoinRow,
  VisibleSkillRow,
} from "./repo.types.js"

/**
 * Skills presentation layer: DB row → app-facing view DTO. Owns the outward
 * semantic transforms (Date → IsoInstantString) so the service/controller never
 * call serializeInstant (guard-layering r3). Row inputs are taken structurally
 * via `import type` from repo.types.ts (the repo layer owns the record shapes) —
 * this file must not import generated/db.
 */

export function buildSkillAttachmentFromCatalogFile(
  row: SkillSnapshotFileRow
): SkillAttachmentFile {
  return {
    id: row.id,
    path: row.path,
    mediaType: row.mediaType || undefined,
    contentBlocks: normalizeStoredBlocks(row.contentBlocks),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

export function buildMirrorSourceSummary(row: SkillSnapshotJoinRow) {
  if (!row.mirrorSourceId || !row.mirrorSourceType || !row.mirrorLocatorKey) {
    return undefined
  }

  return {
    id: row.mirrorSourceId,
    sourceType: row.mirrorSourceType,
    locatorKey: row.mirrorLocatorKey,
    locator: row.mirrorLocator,
    requestedRef: row.mirrorRequestedRef || undefined,
    resolvedRevision:
      row.snapshotResolvedRevision || row.mirrorResolvedRevision || undefined,
    refreshMode: row.mirrorRefreshMode || "manual",
    lastSyncStatus: row.mirrorLastSyncStatus || "pending",
    sourceWarnings: row.mirrorSourceWarnings || [],
    lastError: row.mirrorLastError || undefined,
    lastSyncedAt: serializeOptionalInstant(row.mirrorLastSyncedAt),
    createdAt: serializeInstant(
      requireInstantDate(row.mirrorCreatedAt, "mirror source created_at")
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.mirrorUpdatedAt, "mirror source updated_at")
    ),
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
    id: `${row.snapshotId}:entry`,
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
  files?: SkillSnapshotFileRow[]
) {
  return [
    buildSyntheticEntryAttachment(row, timestamp),
    ...(files || []).map(buildSkillAttachmentFromCatalogFile),
  ]
}

function resolveMarketplaceSkillDefaultConversationTypeMask(
  row: SkillPackageRow
) {
  return row.specDefaultConversationTypeMask || DEFAULT_CONVERSATION_TYPE_MASK
}

function mapMarketplaceVersion(
  row: SkillPackageRow,
  files?: SkillSnapshotFileRow[]
): SkillMarketplaceVersion | undefined {
  if (!row.latestVersionId || !row.latestVersionValue) {
    return undefined
  }

  return {
    id: row.latestVersionId,
    skillId: row.itemId,
    version: row.latestVersionValue,
    changelog: row.latestVersionChangelog || "",
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshotEntryPath || SKILL_ENTRY_PATH,
    contentHash: row.snapshotContentHash || "",
    sourceWarnings: row.snapshotSourceWarnings || [],
    resolvedRevision: row.snapshotResolvedRevision || undefined,
    description: descriptionBlockFromSnapshotRow(row),
    defaultConversationTypeMask:
      row.specDefaultConversationTypeMask || DEFAULT_CONVERSATION_TYPE_MASK,
    createdByUserId: row.latestVersionCreatedByUserId || undefined,
    createdAt:
      serializeOptionalInstant(row.latestVersionCreatedAt) ||
      serializeInstant(row.itemUpdatedAt),
    files: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latestVersionCreatedAt) ||
        serializeInstant(row.itemUpdatedAt),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeOptionalInstant(row.latestVersionCreatedAt) ||
        serializeInstant(row.itemUpdatedAt),
      files
    ),
  }
}

export function mapMarketplaceEntry(
  row: SkillPackageRow,
  installation?: InstallationSummary,
  files?: SkillSnapshotFileRow[]
): SkillMarketplaceEntry {
  const defaultConversationTypeMask =
    resolveMarketplaceSkillDefaultConversationTypeMask(row)
  return {
    id: row.itemId,
    slug: row.itemSlug,
    name: row.snapshotDisplayName || row.itemDisplayName,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.itemIconFileId
      ? getFileUrlById(row.itemIconFileId)
      : undefined,
    tags: row.itemTags || [],
    authorUserId: row.publisherOwnerUserId || undefined,
    authorName: row.publisherDisplayName || undefined,
    isActive: Boolean(row.itemIsActive),
    createdAt: serializeInstant(row.itemCreatedAt),
    updatedAt: serializeInstant(row.itemUpdatedAt),
    defaultConversationTypeMask,
    latestVersionId: row.latestVersionId || undefined,
    latestVersion: mapMarketplaceVersion(row, files),
    mirrorSource: buildMirrorSourceSummary(row),
    workspaceInstallation: installation,
  }
}

export function buildInstalledSkillPayload(
  row: InstalledSkillRow,
  binding: SkillAccessRow | undefined,
  workspaceConversationTypeMask: number,
  files?: SkillSnapshotFileRow[]
): InstalledSkill {
  const chosenBinding = binding
  const accessTarget: CapabilityAccessTarget = chosenBinding
    ? skillBindingToAccessTarget(chosenBinding, row.workspaceId)
    : { subject: workspaceRef(row.workspaceId) }
  const sourceDefaultConversationTypeMask =
    resolveInstalledSkillSourceConversationTypeMask(row)
  const effectiveConversationTypeMask =
    resolveInstalledSkillEffectiveConversationTypeMask({
      workspaceConversationTypeMask,
      conversation_type_mask_override: row.conversationTypeMaskOverride,
    })

  return {
    id: row.skillId,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    frontmatter: frontmatterFromSnapshotRow(row),
    bodyBlocks: bodyBlocksFromSnapshotRow(row),
    entryPath: row.snapshotEntryPath || SKILL_ENTRY_PATH,
    contentHash: row.snapshotContentHash || "",
    sourceWarnings: row.snapshotSourceWarnings || [],
    description: descriptionBlockFromSnapshotRow(row),
    iconUrl: row.iconFileId ? getFileUrlById(row.iconFileId) : undefined,
    tags: row.tags || [],
    accessTarget,
    isEnabled: row.skillStatus === "active",
    sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask,
    conversationTypeMaskOverride: row.conversationTypeMaskOverride || undefined,
    effectiveConversationTypeMask,
    isCustomized: Boolean(row.sourceCatalogItemId && row.sourceIsCustomized),
    ownerWorkspaceMemberId: row.ownerWorkspaceMemberId || undefined,
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
    sourceSkillId: row.sourceCatalogItemId || undefined,
    sourcePackageSlug: row.sourceSlug || undefined,
    sourceVersionId: row.sourceCatalogVersionId || undefined,
    sourceVersion: row.sourceVersionValue || undefined,
    upgradeAvailable:
      Boolean(row.sourceCatalogItemId) &&
      Boolean(row.sourceCatalogVersionId) &&
      Boolean(row.sourceLatestVersionId) &&
      row.sourceCatalogVersionId !== row.sourceLatestVersionId,
    latestSourceVersion: row.latestSourceVersion || undefined,
    files: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updatedAt),
      files
    ),
    attachmentFiles: buildSnapshotAttachmentFiles(
      row,
      serializeInstant(row.updatedAt),
      files
    ),
    mirrorSource: buildMirrorSourceSummary(row),
  }
}

export type InstalledSkillPresentationRecord = {
  id: string
  row: InstalledSkillRow
  binding: SkillAccessRow | undefined
  workspaceConversationTypeMask: number
  files: SkillSnapshotFileRow[]
}

export function presentInstalledSkillRecord(
  record: InstalledSkillPresentationRecord
): InstalledSkill {
  return buildInstalledSkillPayload(
    record.row,
    record.binding,
    record.workspaceConversationTypeMask,
    record.files
  )
}

export function presentSkillAccessGrant(
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
        row.conversationTypeMaskOverride
      )
    : undefined
  return {
    id: row.id,
    workspaceAppId: row.skillId,
    workspaceId: row.workspaceId,
    target: visibleRowToAccessTarget({
      skillId: row.skillId,
      workspaceId: row.workspaceId,
      accessBindScope: row.bindScope,
      conversationId: row.conversationId,
      actorId: row.actorId,
      remoteAgentId: row.remoteAgentId,
      workspaceMemberId: row.workspaceMemberId,
    } as VisibleSkillRow),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: row.status,
    source: row.source,
    grantedByWorkspaceMemberId: row.createdByWorkspaceMemberId || undefined,
    reason: row.reason || undefined,
    conversationTypeMaskOverride: row.conversationTypeMaskOverride ?? null,
    effectiveConversationTypeMask,
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, "workspace_app_grant created_at")
    ),
    revokedAt: serializeOptionalInstant(row.revokedAt),
  }
}
