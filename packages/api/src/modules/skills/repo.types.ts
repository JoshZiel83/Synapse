import type {
  RuntimeBindingScope,
  WorkspaceResourceStatus,
} from "@synapse/shared"

/**
 * Skills repo layer record/projection shapes. These describe the raw SQL row
 * projections read by the service and mapped by the presenter. They live here
 * (the repo layer) so the repo owns the record shapes — both service.ts and
 * presenter.ts import them from this module. This file is a "repo" file: it may
 * reference generated/db row types, but must never import from ./service.js or
 * ./presenter.js (that would create an import cycle).
 *
 * Boundary refactor (F6): the Kysely instance carries
 * CamelCasePlugin({maintainNestedObjectKeys:true}), which camelCases the
 * top-level keys of EVERY result row — including raw SQL rows. The raw SQL in
 * service.ts now projects camelCase (quoted) aliases so these row shapes are
 * camelCase end-to-end with no re-snake bridge. JSONB column VALUES are left
 * untouched by the plugin, so nested keys inside them are still snake/whatever
 * the JSON stored.
 */

export type SkillSnapshotJoinRow = {
  snapshotId: string | null
  snapshotEntryPath: string | null
  snapshotDisplayName: string | null
  snapshotDescription: string | null
  snapshotArgumentHint: string | null
  snapshotDisableModelInvocation: boolean | null
  snapshotUserInvocable: boolean | null
  snapshotAllowedTools: string[] | null
  snapshotModel: string | null
  snapshotEffort: "low" | "medium" | "high" | "max" | null
  snapshotContext: "fork" | null
  snapshotAgent: string | null
  snapshotHooks: Record<string, unknown>
  snapshotBodyBlocks: unknown
  snapshotContentHash: string | null
  snapshotSourceWarnings: string[] | null
  snapshotResolvedRevision: string | null
  snapshotCreatedAt: Date | null
  mirrorSourceId: string | null
  mirrorSourceType: "github" | "clawhub" | null
  mirrorLocatorKey: string | null
  mirrorLocator: Record<string, unknown>
  mirrorRequestedRef: string | null
  mirrorResolvedRevision: string | null
  mirrorRefreshMode: "manual" | null
  mirrorLastSyncStatus: "pending" | "synced" | "error" | null
  mirrorSourceWarnings: string[] | null
  mirrorLastError: string | null
  mirrorLastSyncedAt: Date | null
  mirrorCreatedAt: Date | null
  mirrorUpdatedAt: Date | null
}

export type SkillPackageRow = {
  itemId: string
  itemSlug: string
  itemDisplayName: string
  itemSummary: string
  itemLongDescription: string
  itemTags: string[] | null
  itemIsActive: boolean
  itemDownloadCount: number
  itemIconFileId: string | null
  itemMetadata: Record<string, unknown>
  itemCreatedAt: Date
  itemUpdatedAt: Date
  latestVersionId: string | null
  latestVersionValue: string | null
  latestVersionChangelog: string | null
  latestVersionCreatedByUserId: string | null
  latestVersionCreatedAt: Date | null
  specDefaultConversationTypeMask: number | null
  publisherId: string
  publisherSlug: string
  publisherDisplayName: string
  publisherOwnerUserId: string | null
} & SkillSnapshotJoinRow

export type InstalledSkillRow = {
  skillId: string
  workspaceId: string
  displayName: string
  iconFileId: string | null
  tags: string[] | null
  currentVersion: number
  // Sourced from workspace_resources.status (5-value enum); use the canonical
  // shared type so it can never drift to a partial inline union.
  skillStatus: WorkspaceResourceStatus
  conversationTypeMaskOverride: number | null
  ownerWorkspaceMemberId: string | null
  createdAt: Date
  updatedAt: Date
  currentSnapshotId: string
  currentSkillVersionId: string
  currentSkillSnapshotId: string
  versionMetadata: Record<string, unknown>
  sourceCatalogItemId: string | null
  sourceCatalogVersionId: string | null
  sourceSyncMode:
    | "notify"
    | "manual_merge"
    | "follow_upstream"
    | "detached"
    | null
  sourceIsCustomized: boolean | null
  sourceSlug: string | null
  sourceLatestVersionId: string | null
  sourceVersionValue: string | null
  latestSourceVersion: string | null
  sourceDefaultConversationTypeMask: number | null
} & SkillSnapshotJoinRow

export type SkillSnapshotFileRow = {
  id: string
  skillSnapshotId: string
  path: string
  mediaType: string | null
  contentBlocks: unknown
  createdAt: Date
  updatedAt: Date
}

export type SkillAccessRow = {
  id: string
  workspaceId: string
  skillId: string
  bindScope: RuntimeBindingScope
  conversationId: string | null
  actorId: string | null
  // Round 9 review (P2): include remoteAgentId so dedup paths that
  // currently key on (actorId, conversationId, workspaceMemberId)
  // can also discriminate remote_agent targets.
  remoteAgentId: string | null
  workspaceMemberId: string | null
  conversationTypeMaskOverride: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  createdByWorkspaceMemberId: string | null
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}

export type VisibleSkillRow = {
  accessBindingId: string
  skillId: string
  workspaceId: string
  accessBindScope: RuntimeBindingScope
  conversationId: string | null
  actorId: string | null
  remoteAgentId: string | null
  workspaceMemberId: string | null
  displayName: string
  currentVersion: number
  currentSkillVersionId: string
  description: string
  sourceSlug: string | null
  sourceVersionValue: string | null
  conversationTypeMaskOverride: number | null
  accessCreatedAt: Date
}

export type InstallationSummary = {
  installed: boolean
  installedCount: number
  installedSkillId?: string
}
