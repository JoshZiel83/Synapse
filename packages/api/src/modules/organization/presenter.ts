import {
  normalizeCanonicalContentBlocks,
  summarizeActorForPrompt,
  summarizeActorForRole,
  ACTOR_PACKAGE_LINK_STATUS,
  ACTOR_PACKAGE_SYNC_MODE,
  MARKETPLACE_ITEM_KIND,
  MARKETPLACE_SOURCE_TYPE,
  MARKETPLACE_SYNC_MODE,
  type Actor,
  type ActorDefinition,
  type ActorDoc,
  type ActorPackageRecord,
  type ActorPackageSourceLink,
  type ActorRole,
  type ActorVersion,
  type ActorVersionSource,
  type MarketplaceItem,
  type MarketplacePublisher,
  type MarketplaceSourceType,
  type MarketplaceVersion,
} from "@synapse/shared"
import {
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import {
  normalizeActorDocInputs,
  readDecodedArray,
  sanitizeSpecialties,
  sortDocs,
} from "./doc-codec.js"
import type {
  ActorPackageRow,
  ActorRow,
  ActorVersionRow,
} from "./repo.types.js"

function mapCatalogSourceKind(
  sourceKind: ActorPackageRow["packageSourceKind"]
): MarketplaceSourceType {
  switch (sourceKind) {
    case "builtin":
      return MARKETPLACE_SOURCE_TYPE.BUILTIN
    case "official":
      return MARKETPLACE_SOURCE_TYPE.OFFICIAL
    case "workspace":
      return MARKETPLACE_SOURCE_TYPE.WORKSPACE_UPLOAD
    case "user":
      return MARKETPLACE_SOURCE_TYPE.USER_UPLOAD
  }
}

function buildActorPackageDefinition(row: ActorPackageRow): ActorDefinition {
  const docs = normalizeActorDocInputs(row.actorDocs)
  return {
    displayName: row.actorDisplayName,
    role: row.actorRole,
    title: row.actorTitle,
    avatarFileId: row.actorAvatarFileId || undefined,
    avatarEmoji: row.actorAvatarEmoji || undefined,
    canRepresentUser: Boolean(row.actorCanRepresentUser),
    docs,
    specialties: sanitizeSpecialties(row.actorSpecialties || []),
    config: row.actorConfig,
  }
}

function buildActorPackagePublisher(
  row: ActorPackageRow
): MarketplacePublisher {
  return {
    id: row.publisherId,
    slug: row.publisherSlug,
    displayName: row.publisherDisplayName,
    description: row.publisherDescription,
    isBuiltin: Boolean(row.publisherIsBuiltin),
    isVerified: Boolean(row.publisherIsVerified),
    ownerUserId: row.publisherOwnerUserId || undefined,
    createdAt: serializeInstant(row.publisherCreatedAt),
    updatedAt: serializeInstant(row.publisherUpdatedAt),
  }
}

function buildActorPackageRevision(
  row: ActorPackageRow,
  actor: ActorDefinition
): MarketplaceVersion {
  const versionMetadata = row.versionMetadata
  const setupGuide = normalizeCanonicalContentBlocks(
    readDecodedArray(versionMetadata.setupGuide)
  )
  const releaseNotes = normalizeCanonicalContentBlocks(
    readDecodedArray(versionMetadata.releaseNotes)
  )

  return {
    id: row.versionId,
    packageId: row.packageId,
    version: row.versionValue,
    status: row.versionStatus,
    manifest: {
      kind: MARKETPLACE_ITEM_KIND.ACTOR,
      actorPackage: {
        actor,
        setupGuide,
        releaseNotes,
      },
    },
    configSchema: {},
    configFields: [],
    defaultConfig: {},
    toolsManifest: [],
    validationRules: [],
    setupSteps: [],
    authBindings: [],
    metadata: versionMetadata,
    createdByUserId: row.versionCreatedByUserId || undefined,
    createdAt: serializeInstant(row.versionCreatedAt),
    assets: [],
  }
}

export function presentActorPackageRecord(
  row: ActorPackageRow
): ActorPackageRecord {
  const actor = buildActorPackageDefinition(row)
  const packageDescription =
    row.packageSummary ||
    summarizeActorForRole(actor.docs, row.actorTitle) ||
    `${row.packageDisplayName} actor`
  const longDescription =
    row.packageLongDescription ||
    summarizeActorForPrompt(actor.docs) ||
    packageDescription
  const latestRevision = buildActorPackageRevision(row, actor)
  const publisher = buildActorPackagePublisher(row)
  const marketplaceItem: MarketplaceItem = {
    id: row.packageId,
    publisherId: row.publisherId,
    workspaceId: row.packageWorkspaceId || undefined,
    kind: MARKETPLACE_ITEM_KIND.ACTOR,
    slug: row.packageSlug,
    displayName: row.packageDisplayName,
    iconUrl: row.packageIconFileId
      ? getFileUrlById(row.packageIconFileId)
      : undefined,
    description: packageDescription,
    longDescription,
    sourceType: mapCatalogSourceKind(row.packageSourceKind),
    tags: row.packageTags || [],
    isActive: Boolean(row.packageIsActive),
    isBuiltin:
      row.packageSourceKind === "builtin" || Boolean(row.publisherIsBuiltin),
    downloadCount: row.packageDownloadCount,
    latestRevisionId: row.versionId,
    defaultReuseScope: "workspace",
    requiresHandshake: false,
    metadata: row.packageMetadata,
    createdAt: serializeInstant(row.packageCreatedAt),
    updatedAt: serializeInstant(row.packageUpdatedAt),
    publisher,
    latestRevision,
  }

  return {
    package: marketplaceItem,
    manifest: {
      actor,
      setupGuide: normalizeCanonicalContentBlocks(
        readDecodedArray(row.versionMetadata.setupGuide)
      ),
      releaseNotes: normalizeCanonicalContentBlocks(
        readDecodedArray(row.versionMetadata.releaseNotes)
      ),
    },
    dependencies: [],
    requirementChecks: [],
  }
}

function buildActorSourceLink(
  row: ActorRow
): ActorPackageSourceLink | undefined {
  if (!row.sourceCatalogItemId) return undefined

  const baselineActorVersion = row.sourceBaselineActorVersion || 1
  const hasLocalChanges = row.currentVersion > baselineActorVersion
  const hasUpstreamUpdate =
    Boolean(row.sourceLatestVersionId) &&
    row.sourceCatalogVersionId !== row.sourceLatestVersionId

  let status: ActorPackageSourceLink["status"] =
    ACTOR_PACKAGE_LINK_STATUS.UP_TO_DATE
  if (
    (row.sourceSyncMode || ACTOR_PACKAGE_SYNC_MODE.NOTIFY) ===
    MARKETPLACE_SYNC_MODE.DETACHED
  ) {
    status = ACTOR_PACKAGE_LINK_STATUS.DETACHED
  } else if (hasLocalChanges && hasUpstreamUpdate) {
    status = ACTOR_PACKAGE_LINK_STATUS.UPDATE_AVAILABLE_WITH_LOCAL_CHANGES
  } else if (hasLocalChanges) {
    status = ACTOR_PACKAGE_LINK_STATUS.DIVERGED
  } else if (hasUpstreamUpdate) {
    status = ACTOR_PACKAGE_LINK_STATUS.UPDATE_AVAILABLE
  }

  return {
    actorId: row.id,
    packageId: row.sourceCatalogItemId,
    importedRevisionId:
      row.sourceCatalogVersionId ||
      row.sourceLatestVersionId ||
      row.sourceCatalogItemId,
    packageSlug: row.sourceSlug || row.sourceCatalogItemId,
    packageDisplayName: row.sourceDisplayName || "Unknown package",
    packagePublisherSlug: row.sourcePublisherSlug || undefined,
    packagePublisherDisplayName: row.sourcePublisherDisplayName || undefined,
    importedVersion: row.sourceImportedVersion || undefined,
    latestRevisionId: row.sourceLatestVersionId || undefined,
    latestVersion: row.sourceLatestVersion || undefined,
    baselineActorVersion,
    syncMode:
      row.sourceSyncMode === ACTOR_PACKAGE_SYNC_MODE.MANUAL_MERGE
        ? ACTOR_PACKAGE_SYNC_MODE.MANUAL_MERGE
        : ACTOR_PACKAGE_SYNC_MODE.NOTIFY,
    hasLocalChanges,
    hasUpstreamUpdate,
    status,
    createdAt:
      serializeOptionalInstant(row.sourceCreatedAt) ||
      serializeInstant(row.createdAt),
    updatedAt:
      serializeOptionalInstant(row.sourceUpdatedAt) ||
      serializeInstant(row.updatedAt),
  }
}

function buildActorDefinition(
  row: {
    displayName?: string
    role: ActorRole
    title: string
    avatarFileId?: string | null
    avatarEmoji?: string | null
    parentId: string | null
    canRepresentUser: boolean
    specialties: string[] | null
    config: Record<string, unknown>
  },
  docs: ActorDoc[]
): ActorDefinition {
  return {
    displayName: row.displayName || "",
    role: row.role,
    title: row.title,
    avatarFileId: row.avatarFileId || undefined,
    avatarEmoji: row.avatarEmoji || undefined,
    parentId: row.parentId || undefined,
    canRepresentUser: Boolean(row.canRepresentUser),
    docs: sortDocs(docs),
    specialties: sanitizeSpecialties(row.specialties || []),
    config: row.config,
  }
}

function buildActorVersionSourceFromRow(
  row: Pick<
    ActorVersionRow,
    | "sourceType"
    | "sourceWorkspaceMemberId"
    | "sourceActorId"
    | "sourceSessionId"
    | "sourceTurnId"
    | "sourceConversationId"
    | "sourceReason"
  >
): ActorVersionSource {
  return {
    type: row.sourceType,
    workspaceMemberId: row.sourceWorkspaceMemberId || undefined,
    actorId: row.sourceActorId || undefined,
    sessionId: row.sourceSessionId || undefined,
    turnId: row.sourceTurnId || undefined,
    conversationId: row.sourceConversationId || undefined,
    reason: row.sourceReason || undefined,
  }
}

export function presentActorRow(row: ActorRow, docs: ActorDoc[]): Actor {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    packageId: row.sourceCatalogItemId || undefined,
    definition: buildActorDefinition(row, docs),
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : undefined,
    currentVersion: row.currentVersion,
    sourceLink: buildActorSourceLink(row),
    isActive: Boolean(row.isActive),
    isPublicShared: Boolean(row.isPublicShared),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

export function presentActorVersionRow(
  row: ActorVersionRow,
  docs: ActorDoc[]
): ActorVersion {
  return {
    id: row.id,
    actorId: row.actorId,
    version: row.version,
    previousVersionId: row.previousVersionId || undefined,
    snapshot: buildActorDefinition(row, docs),
    delta: row.versionDelta || undefined,
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId || undefined,
    source: buildActorVersionSourceFromRow(row),
    createdAt: serializeInstant(row.createdAt),
  }
}
