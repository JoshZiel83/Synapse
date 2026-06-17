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
  sourceKind: ActorPackageRow["package_source_kind"]
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
  const docs = normalizeActorDocInputs(row.actor_docs)
  return {
    displayName: row.actor_display_name,
    role: row.actor_role,
    title: row.actor_title,
    avatarFileId: row.actor_avatar_file_id || undefined,
    avatarEmoji: row.actor_avatar_emoji || undefined,
    canRepresentUser: Boolean(row.actor_can_represent_user),
    docs,
    specialties: sanitizeSpecialties(row.actor_specialties || []),
    config: row.actor_config,
  }
}

function buildActorPackagePublisher(
  row: ActorPackageRow
): MarketplacePublisher {
  return {
    id: row.publisher_id,
    slug: row.publisher_slug,
    displayName: row.publisher_display_name,
    description: row.publisher_description,
    isBuiltin: Boolean(row.publisher_is_builtin),
    isVerified: Boolean(row.publisher_is_verified),
    ownerUserId: row.publisher_owner_user_id || undefined,
    createdAt: serializeInstant(row.publisher_created_at),
    updatedAt: serializeInstant(row.publisher_updated_at),
  }
}

function buildActorPackageRevision(
  row: ActorPackageRow,
  actor: ActorDefinition
): MarketplaceVersion {
  const versionMetadata = row.version_metadata
  const setupGuide = normalizeCanonicalContentBlocks(
    readDecodedArray(versionMetadata.setupGuide)
  )
  const releaseNotes = normalizeCanonicalContentBlocks(
    readDecodedArray(versionMetadata.releaseNotes)
  )

  return {
    id: row.version_id,
    packageId: row.package_id,
    version: row.version_value,
    status: row.version_status,
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
    createdByUserId: row.version_created_by_user_id || undefined,
    createdAt: serializeInstant(row.version_created_at),
    assets: [],
  }
}

export function presentActorPackageRecord(
  row: ActorPackageRow
): ActorPackageRecord {
  const actor = buildActorPackageDefinition(row)
  const packageDescription =
    row.package_summary ||
    summarizeActorForRole(actor.docs, row.actor_title) ||
    `${row.package_display_name} actor`
  const longDescription =
    row.package_long_description ||
    summarizeActorForPrompt(actor.docs) ||
    packageDescription
  const latestRevision = buildActorPackageRevision(row, actor)
  const publisher = buildActorPackagePublisher(row)
  const marketplaceItem: MarketplaceItem = {
    id: row.package_id,
    publisherId: row.publisher_id,
    workspaceId: row.package_workspace_id || undefined,
    kind: MARKETPLACE_ITEM_KIND.ACTOR,
    slug: row.package_slug,
    displayName: row.package_display_name,
    iconUrl: row.package_icon_file_id
      ? getFileUrlById(row.package_icon_file_id)
      : undefined,
    description: packageDescription,
    longDescription,
    sourceType: mapCatalogSourceKind(row.package_source_kind),
    tags: row.package_tags || [],
    isActive: Boolean(row.package_is_active),
    isBuiltin:
      row.package_source_kind === "builtin" ||
      Boolean(row.publisher_is_builtin),
    downloadCount: row.package_download_count,
    latestRevisionId: row.version_id,
    defaultReuseScope: "workspace",
    requiresHandshake: false,
    metadata: row.package_metadata,
    createdAt: serializeInstant(row.package_created_at),
    updatedAt: serializeInstant(row.package_updated_at),
    publisher,
    latestRevision,
  }

  return {
    package: marketplaceItem,
    manifest: {
      actor,
      setupGuide: normalizeCanonicalContentBlocks(
        readDecodedArray(row.version_metadata.setupGuide)
      ),
      releaseNotes: normalizeCanonicalContentBlocks(
        readDecodedArray(row.version_metadata.releaseNotes)
      ),
    },
    dependencies: [],
    requirementChecks: [],
  }
}

function buildActorSourceLink(
  row: ActorRow
): ActorPackageSourceLink | undefined {
  if (!row.source_catalog_item_id) return undefined

  const baselineActorVersion = row.source_baseline_actor_version || 1
  const hasLocalChanges = row.current_version > baselineActorVersion
  const hasUpstreamUpdate =
    Boolean(row.source_latest_version_id) &&
    row.source_catalog_version_id !== row.source_latest_version_id

  let status: ActorPackageSourceLink["status"] =
    ACTOR_PACKAGE_LINK_STATUS.UP_TO_DATE
  if (
    (row.source_sync_mode || ACTOR_PACKAGE_SYNC_MODE.NOTIFY) ===
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
    packageId: row.source_catalog_item_id,
    importedRevisionId:
      row.source_catalog_version_id ||
      row.source_latest_version_id ||
      row.source_catalog_item_id,
    packageSlug: row.source_slug || row.source_catalog_item_id,
    packageDisplayName: row.source_display_name || "Unknown package",
    packagePublisherSlug: row.source_publisher_slug || undefined,
    packagePublisherDisplayName: row.source_publisher_display_name || undefined,
    importedVersion: row.source_imported_version || undefined,
    latestRevisionId: row.source_latest_version_id || undefined,
    latestVersion: row.source_latest_version || undefined,
    baselineActorVersion,
    syncMode:
      row.source_sync_mode === ACTOR_PACKAGE_SYNC_MODE.MANUAL_MERGE
        ? ACTOR_PACKAGE_SYNC_MODE.MANUAL_MERGE
        : ACTOR_PACKAGE_SYNC_MODE.NOTIFY,
    hasLocalChanges,
    hasUpstreamUpdate,
    status,
    createdAt:
      serializeOptionalInstant(row.source_created_at) ||
      serializeInstant(row.created_at),
    updatedAt:
      serializeOptionalInstant(row.source_updated_at) ||
      serializeInstant(row.updated_at),
  }
}

function buildActorDefinition(
  row: {
    display_name?: string
    role: ActorRole
    title: string
    avatar_file_id?: string | null
    avatar_emoji?: string | null
    parent_id: string | null
    can_represent_user: boolean
    specialties: string[] | null
    config: Record<string, unknown>
  },
  docs: ActorDoc[]
): ActorDefinition {
  return {
    displayName: row.display_name || "",
    role: row.role,
    title: row.title,
    avatarFileId: row.avatar_file_id || undefined,
    avatarEmoji: row.avatar_emoji || undefined,
    parentId: row.parent_id || undefined,
    canRepresentUser: Boolean(row.can_represent_user),
    docs: sortDocs(docs),
    specialties: sanitizeSpecialties(row.specialties || []),
    config: row.config,
  }
}

function buildActorVersionSourceFromRow(
  row: Pick<
    ActorVersionRow,
    | "source_type"
    | "source_workspace_member_id"
    | "source_actor_id"
    | "source_session_id"
    | "source_turn_id"
    | "source_conversation_id"
    | "source_reason"
  >
): ActorVersionSource {
  return {
    type: row.source_type,
    workspaceMemberId: row.source_workspace_member_id || undefined,
    actorId: row.source_actor_id || undefined,
    sessionId: row.source_session_id || undefined,
    turnId: row.source_turn_id || undefined,
    conversationId: row.source_conversation_id || undefined,
    reason: row.source_reason || undefined,
  }
}

export function presentActorRow(row: ActorRow, docs: ActorDoc[]): Actor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    packageId: row.source_catalog_item_id || undefined,
    definition: buildActorDefinition(row, docs),
    avatarUrl: row.avatar_file_id
      ? getFileUrlById(row.avatar_file_id)
      : undefined,
    currentVersion: row.current_version,
    sourceLink: buildActorSourceLink(row),
    isActive: Boolean(row.is_active),
    isPublicShared: Boolean(row.is_public_shared),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

export function presentActorVersionRow(
  row: ActorVersionRow,
  docs: ActorDoc[]
): ActorVersion {
  return {
    id: row.id,
    actorId: row.actor_id,
    version: row.version,
    previousVersionId: row.previous_version_id || undefined,
    snapshot: buildActorDefinition(row, docs),
    delta: row.version_delta || undefined,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    source: buildActorVersionSourceFromRow(row),
    createdAt: serializeInstant(row.created_at),
  }
}
