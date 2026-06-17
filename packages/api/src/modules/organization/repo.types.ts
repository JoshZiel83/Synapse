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
  workspaceId: string
  displayName: string
  role: ActorRole
  title: string
  avatarFileId: string | null
  avatarEmoji: string | null
  parentId: string | null
  canRepresentUser: boolean
  specialties: string[] | null
  config: Record<string, unknown>
  currentVersion: number
  isActive: boolean
  isPublicShared: boolean
  createdAt: Date
  updatedAt: Date
  currentActorVersionId: string
  sourceCatalogItemId: string | null
  sourceCatalogVersionId: string | null
  sourceSyncMode: MarketplaceSyncMode | null
  sourceBaselineActorVersion: number | null
  sourceCreatedAt: Date | null
  sourceUpdatedAt: Date | null
  sourceSlug: string | null
  sourceDisplayName: string | null
  sourceLatestVersionId: string | null
  sourcePublisherSlug: string | null
  sourcePublisherDisplayName: string | null
  sourceImportedVersion: string | null
  sourceLatestVersion: string | null
}

export type ActorVersionRow = {
  id: string
  actorId: string
  version: number
  previousVersionId: string | null
  displayName: string
  role: ActorRole
  title: string
  parentId: string | null
  canRepresentUser: boolean
  specialties: string[] | null
  config: Record<string, unknown>
  versionDelta: ActorVersionDelta | null
  createdByWorkspaceMemberId: string | null
  sourceType: ActorUpdateSourceType
  sourceWorkspaceMemberId: string | null
  sourceActorId: string | null
  sourceSessionId: string | null
  sourceTurnId: string | null
  sourceConversationId: string | null
  sourceReason: string | null
  createdAt: Date
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
  packageId: string
  packageWorkspaceId: string | null
  packageSlug: string
  packageDisplayName: string
  packageIconFileId: string | null
  packageSummary: string
  packageLongDescription: string
  packageSourceKind: "builtin" | "official" | "workspace" | "user"
  packageVisibility: "public" | "workspace" | "private"
  packageTags: string[] | null
  packageDownloadCount: number
  packageIsActive: boolean
  packageMetadata: Record<string, unknown>
  packageCreatedAt: Date
  packageUpdatedAt: Date
  publisherId: string
  publisherSlug: string
  publisherDisplayName: string
  publisherDescription: string
  publisherOwnerUserId: string | null
  publisherWorkspaceId: string | null
  publisherIsBuiltin: boolean
  publisherIsVerified: boolean
  publisherCreatedAt: Date
  publisherUpdatedAt: Date
  versionId: string
  versionValue: string
  versionStatus: MarketplaceVersionStatus
  versionChangelog: string
  versionMetadata: Record<string, unknown>
  versionCreatedByUserId: string | null
  versionCreatedAt: Date
  actorRole: ActorRole
  actorDisplayName: string
  actorAvatarFileId: string | null
  actorAvatarEmoji: string | null
  actorTitle: string
  actorCanRepresentUser: boolean
  actorDocs: unknown
  actorSpecialties: string[] | null
  actorConfig: Record<string, unknown>
  actorMetadata: Record<string, unknown>
}
