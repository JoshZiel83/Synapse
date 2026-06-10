import {
  normalizeCanonicalContentBlocks,
  parseJsonObject,
  summarizeActorForPrompt,
  summarizeActorForRole,
  type Actor,
  type ActorDefinition,
  type ActorDoc,
  type ActorPackageRecord,
  type ActorPackageSourceLink,
  type ActorRole,
  type ActorVersion,
  type ActorVersionDelta,
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
  parseJsonArray,
  sanitizeSpecialties,
  sortDocs,
  type ActorPackageRow,
  type ActorRow,
  type ActorVersionRow,
} from "./service.js"

function mapCatalogSourceKind(
  sourceKind: ActorPackageRow["package_source_kind"]
): MarketplaceSourceType {
  switch (sourceKind) {
    case "builtin":
      return "builtin"
    case "official":
      return "official"
    case "workspace":
      return "workspace_upload"
    case "user":
      return "user_upload"
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
    config: parseJsonObject(row.actor_config),
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
  const versionMetadata = parseJsonObject(row.version_metadata)
  const setupGuide = normalizeCanonicalContentBlocks(
    parseJsonArray(versionMetadata.setupGuide)
  )
  const releaseNotes = normalizeCanonicalContentBlocks(
    parseJsonArray(versionMetadata.releaseNotes)
  )

  return {
    id: row.version_id,
    packageId: row.package_id,
    version: row.version_value,
    status: row.version_status,
    manifest: {
      kind: "actor",
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
    kind: "actor",
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
    metadata: parseJsonObject(row.package_metadata),
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
        parseJsonArray(parseJsonObject(row.version_metadata).setupGuide)
      ),
      releaseNotes: normalizeCanonicalContentBlocks(
        parseJsonArray(parseJsonObject(row.version_metadata).releaseNotes)
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

  let status: ActorPackageSourceLink["status"] = "up_to_date"
  if ((row.source_sync_mode || "notify") === "detached") {
    status = "detached"
  } else if (hasLocalChanges && hasUpstreamUpdate) {
    status = "update_available_with_local_changes"
  } else if (hasLocalChanges) {
    status = "diverged"
  } else if (hasUpstreamUpdate) {
    status = "update_available"
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
      row.source_sync_mode === "manual_merge" ? "manual_merge" : "notify",
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
    config: Record<string, unknown> | string | null
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
    config: parseJsonObject(row.config),
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
    delta:
      typeof row.version_delta === "string"
        ? (JSON.parse(row.version_delta) as ActorVersionDelta)
        : row.version_delta || undefined,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    source: buildActorVersionSourceFromRow(row),
    createdAt: serializeInstant(row.created_at),
  }
}
