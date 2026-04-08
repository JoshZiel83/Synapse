import type pg from "pg";
import {
  extractText,
  GROUP_CONVERSATION_KIND,
  normalizeActorDocs,
  normalizeCanonicalContentBlocks,
  summarizeActorDoc,
  summarizeActorForPrompt,
  summarizeActorForRole,
  textBlocks,
  type Actor,
  type ActorDefinition,
  type ActorDoc,
  type ActorDocInput,
  type ActorPackageInstallResult,
  type ActorPackageRecord,
  type ActorPackageSourceLink,
  type ActorPackageSyncMode,
  type ActorRole,
  type ActorVersion,
  type ActorVersionChange,
  type ActorVersionSource,
  type ActorVersionChangedField,
  type ActorDocFieldChange,
  type ActorVersionDelta,
  type ActorVersionDocChange,
  type ActorUpdateSourceType,
  type MarketplaceItem,
  type MarketplacePublisher,
  type MarketplaceSourceType,
  type MarketplaceVersion,
  type MarketplaceVersionStatus,
  type UUID,
} from "@synapse/shared";
import { transaction } from "../../infrastructure/database/index.js";
import { executeSql, executeSqlOn } from "../../infrastructure/database/kysely.js";
import { createConversationEvent } from "../chat/service.js";
import { getFileUrlById } from "../files/service.js";
import { listAuthorizedResourceIds, type AccessSubject } from "../access/service.js";

type QueryRow = pg.QueryResultRow;
type QueryResultLike<T extends QueryRow> = { rows: T[] };
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResultLike<T>>;

export interface ActorUpdateSourceInput {
  type: ActorUpdateSourceType;
  workspaceMemberId?: UUID;
  actorId?: UUID;
  sessionId?: UUID;
  turnId?: UUID;
  conversationId?: UUID;
  reason?: string;
}

type ActorRow = {
  id: string;
  workspace_id: string;
  name: string;
  role: ActorRole;
  title: string;
  avatar_file_id: string | null;
  avatar_emoji: string | null;
  parent_id: string | null;
  can_represent_user: boolean;
  specialties: string[] | null;
  config: Record<string, unknown> | string | null;
  current_version: number;
  is_active: boolean;
  is_public_shared: boolean;
  created_at: string;
  updated_at: string;
  current_actor_version_id: string;
  source_catalog_item_id: string | null;
  source_catalog_version_id: string | null;
  source_sync_mode:
    | ActorPackageSyncMode
    | "follow_upstream"
    | "detached"
    | null;
  source_baseline_actor_version: number | null;
  source_created_at: string | null;
  source_updated_at: string | null;
  source_slug: string | null;
  source_display_name: string | null;
  source_latest_version_id: string | null;
  source_publisher_slug: string | null;
  source_publisher_display_name: string | null;
  source_imported_version: string | null;
  source_latest_version: string | null;
};

type ActorVersionRow = {
  id: string;
  actor_id: string;
  version: number;
  previous_version_id: string | null;
  name: string;
  role: ActorRole;
  title: string;
  parent_id: string | null;
  can_represent_user: boolean;
  specialties: string[] | null;
  config: Record<string, unknown> | string | null;
  version_delta: ActorVersionDelta | string | null;
  created_by_workspace_member_id: string | null;
  source_type: ActorUpdateSourceType;
  source_workspace_member_id: string | null;
  source_actor_id: string | null;
  source_session_id: string | null;
  source_turn_id: string | null;
  source_conversation_id: string | null;
  source_reason: string | null;
  created_at: string;
};

type ActorDocRow = {
  id: string;
  actor_version_id: string;
  doc_key: ActorDoc["key"];
  title: string;
  visibility: ActorDoc["visibility"];
  priority: number;
  content_blocks: unknown;
};

type ActorPackageRow = {
  package_id: string;
  package_workspace_id: string | null;
  package_slug: string;
  package_display_name: string;
  package_icon_file_id: string | null;
  package_summary: string;
  package_long_description: string;
  package_source_kind: "builtin" | "official" | "workspace" | "user" | "relay";
  package_visibility: "public" | "workspace" | "private";
  package_tags: string[] | null;
  package_download_count: number;
  package_is_active: boolean;
  package_metadata: Record<string, unknown> | string | null;
  package_created_at: string;
  package_updated_at: string;
  publisher_id: string;
  publisher_slug: string;
  publisher_display_name: string;
  publisher_description: string;
  publisher_owner_user_id: string | null;
  publisher_workspace_id: string | null;
  publisher_is_builtin: boolean;
  publisher_is_verified: boolean;
  publisher_created_at: string;
  publisher_updated_at: string;
  version_id: string;
  version_value: string;
  version_status: MarketplaceVersionStatus;
  version_changelog: string;
  version_metadata: Record<string, unknown> | string | null;
  version_created_by_user_id: string | null;
  version_created_at: string;
  actor_role: ActorRole;
  actor_name: string;
  actor_avatar_file_id: string | null;
  actor_avatar_emoji: string | null;
  actor_title: string;
  actor_can_represent_user: boolean;
  actor_docs: unknown;
  actor_specialties: string[] | null;
  actor_config: Record<string, unknown> | string | null;
  actor_metadata: Record<string, unknown> | string | null;
};

type ActorTreeNode = Actor & {
  children: ActorTreeNode[];
};

const ACTOR_SELECT = `
  SELECT
    a.id,
    a.workspace_id,
    a.name,
    a.role,
    a.title,
    a.avatar_file_id,
    a.avatar_emoji,
    a.parent_id,
    a.can_represent_user,
    a.specialties,
    a.config,
    a.current_version,
    a.is_active,
    a.is_public_shared,
    a.created_at,
    a.updated_at,
    current_version.id AS current_actor_version_id,
    source_ref.source_catalog_item_id,
    source_ref.source_catalog_version_id,
    source_ref.sync_mode AS source_sync_mode,
    source_ref.baseline_actor_version AS source_baseline_actor_version,
    source_ref.created_at AS source_created_at,
    source_ref.updated_at AS source_updated_at,
    source_item.slug AS source_slug,
    source_item.display_name AS source_display_name,
    source_item.latest_version_id AS source_latest_version_id,
    source_publisher.slug AS source_publisher_slug,
    source_publisher.display_name AS source_publisher_display_name,
    imported_version.version AS source_imported_version,
    latest_version.version AS source_latest_version
  FROM actors a
  JOIN actor_versions current_version
    ON current_version.actor_id = a.id
   AND current_version.version = a.current_version
  LEFT JOIN actor_source_refs source_ref
    ON source_ref.actor_id = a.id
  LEFT JOIN catalog_items source_item
    ON source_item.id = source_ref.source_catalog_item_id
  LEFT JOIN publishers source_publisher
    ON source_publisher.id = source_item.publisher_id
  LEFT JOIN catalog_versions imported_version
    ON imported_version.id = source_ref.source_catalog_version_id
  LEFT JOIN catalog_versions latest_version
    ON latest_version.id = source_item.latest_version_id
`;

const ACTOR_PACKAGE_SELECT = `
  SELECT
    item.id AS package_id,
    item.workspace_id AS package_workspace_id,
    item.slug AS package_slug,
    item.display_name AS package_display_name,
    item.icon_file_id AS package_icon_file_id,
    item.summary AS package_summary,
    item.long_description AS package_long_description,
    item.source_kind AS package_source_kind,
    item.visibility AS package_visibility,
    item.tags AS package_tags,
    item.download_count AS package_download_count,
    item.is_active AS package_is_active,
    item.metadata AS package_metadata,
    item.created_at AS package_created_at,
    item.updated_at AS package_updated_at,
    publisher.id AS publisher_id,
    publisher.slug AS publisher_slug,
    publisher.display_name AS publisher_display_name,
    publisher.description AS publisher_description,
    publisher.owner_user_id AS publisher_owner_user_id,
    publisher.workspace_id AS publisher_workspace_id,
    publisher.is_builtin AS publisher_is_builtin,
    publisher.is_verified AS publisher_is_verified,
    publisher.created_at AS publisher_created_at,
    publisher.updated_at AS publisher_updated_at,
    version.id AS version_id,
    version.version AS version_value,
    version.status AS version_status,
    version.changelog AS version_changelog,
    version.metadata AS version_metadata,
    version.created_by_user_id AS version_created_by_user_id,
    version.created_at AS version_created_at,
    spec.role AS actor_role,
    spec.name AS actor_name,
    spec.avatar_file_id AS actor_avatar_file_id,
    spec.avatar_emoji AS actor_avatar_emoji,
    spec.title AS actor_title,
    spec.can_represent_user AS actor_can_represent_user,
    spec.docs AS actor_docs,
    spec.specialties AS actor_specialties,
    spec.config AS actor_config,
    spec.metadata AS actor_metadata
  FROM catalog_items item
  JOIN publishers publisher ON publisher.id = item.publisher_id
  JOIN catalog_versions version ON version.id = item.latest_version_id
  JOIN actor_template_version_specs spec ON spec.catalog_version_id = version.id
  WHERE item.item_kind = 'actor_template'
    AND item.is_active = TRUE
`;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as T[]) : [];
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function sortDocs(docs: ActorDoc[]) {
  return [...docs].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.title.localeCompare(right.title);
  });
}

function normalizeActorDocInputs(docs: unknown): ActorDoc[] {
  return sortDocs(normalizeActorDocs(parseJsonArray<ActorDocInput>(docs)));
}

function sanitizeSpecialties(specialties?: string[]) {
  return Array.from(
    new Set((specialties || []).map((value) => value.trim()).filter(Boolean)),
  );
}

function normalizeAvatarEmoji(value?: string | null) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function mapCatalogSourceKind(sourceKind: ActorPackageRow["package_source_kind"]): MarketplaceSourceType {
  switch (sourceKind) {
    case "builtin":
      return "builtin";
    case "official":
      return "official";
    case "workspace":
      return "workspace_upload";
    case "user":
      return "user_upload";
    case "relay":
      return "relay_derived";
  }
}

function buildActorPackageDefinition(row: ActorPackageRow): ActorDefinition {
  const docs = normalizeActorDocInputs(row.actor_docs);
  return {
    name: row.actor_name,
    role: row.actor_role,
    title: row.actor_title,
    avatarFileId: row.actor_avatar_file_id || undefined,
    avatarEmoji: row.actor_avatar_emoji || undefined,
    canRepresentUser: Boolean(row.actor_can_represent_user),
    docs,
    specialties: sanitizeSpecialties(row.actor_specialties || []),
    config: parseJsonObject(row.actor_config),
  };
}

function buildActorPackagePublisher(row: ActorPackageRow): MarketplacePublisher {
  return {
    id: row.publisher_id,
    slug: row.publisher_slug,
    displayName: row.publisher_display_name,
    description: row.publisher_description,
    isBuiltin: Boolean(row.publisher_is_builtin),
    isVerified: Boolean(row.publisher_is_verified),
    ownerUserId: row.publisher_owner_user_id || undefined,
    createdAt: row.publisher_created_at,
    updatedAt: row.publisher_updated_at,
  };
}

function buildActorPackageRevision(
  row: ActorPackageRow,
  actor: ActorDefinition,
): MarketplaceVersion {
  const versionMetadata = parseJsonObject(row.version_metadata);
  const setupGuide = normalizeCanonicalContentBlocks(
    parseJsonArray(versionMetadata.setupGuide),
  );
  const releaseNotes = normalizeCanonicalContentBlocks(
    parseJsonArray(versionMetadata.releaseNotes),
  );

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
    createdAt: row.version_created_at,
    assets: [],
  };
}

function buildActorPackageRecord(row: ActorPackageRow): ActorPackageRecord {
  const actor = buildActorPackageDefinition(row);
  const packageDescription =
    row.package_summary || summarizeActorForRole(actor.docs, row.actor_title) || `${row.package_display_name} actor`;
  const longDescription =
    row.package_long_description ||
    summarizeActorForPrompt(actor.docs) ||
    packageDescription;
  const latestRevision = buildActorPackageRevision(row, actor);
  const publisher = buildActorPackagePublisher(row);
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
    isBuiltin: row.package_source_kind === "builtin" || Boolean(row.publisher_is_builtin),
    downloadCount: row.package_download_count,
    latestRevisionId: row.version_id,
    defaultInstanceScope: "workspace",
    defaultReuseScope: "workspace",
    requiresHandshake: false,
    metadata: parseJsonObject(row.package_metadata),
    createdAt: row.package_created_at,
    updatedAt: row.package_updated_at,
    publisher,
    latestRevision,
  };

  return {
    package: marketplaceItem,
    manifest: {
      actor,
      setupGuide: normalizeCanonicalContentBlocks(
        parseJsonArray(parseJsonObject(row.version_metadata).setupGuide),
      ),
      releaseNotes: normalizeCanonicalContentBlocks(
        parseJsonArray(parseJsonObject(row.version_metadata).releaseNotes),
      ),
    },
    dependencies: [],
    requirementChecks: [],
  };
}

function buildActorSourceLink(row: ActorRow): ActorPackageSourceLink | undefined {
  if (!row.source_catalog_item_id) return undefined;

  const baselineActorVersion = row.source_baseline_actor_version || 1;
  const hasLocalChanges = row.current_version > baselineActorVersion;
  const hasUpstreamUpdate =
    Boolean(row.source_latest_version_id) &&
    row.source_catalog_version_id !== row.source_latest_version_id;

  let status: ActorPackageSourceLink["status"] = "up_to_date";
  if ((row.source_sync_mode || "notify") === "detached") {
    status = "detached";
  } else if (hasLocalChanges && hasUpstreamUpdate) {
    status = "update_available_with_local_changes";
  } else if (hasLocalChanges) {
    status = "diverged";
  } else if (hasUpstreamUpdate) {
    status = "update_available";
  }

  return {
    actorId: row.id,
    packageId: row.source_catalog_item_id,
    importedRevisionId: row.source_catalog_version_id || row.source_latest_version_id || row.source_catalog_item_id,
    packageSlug: row.source_slug || row.source_catalog_item_id,
    packageDisplayName: row.source_display_name || "Unknown package",
    packagePublisherSlug: row.source_publisher_slug || undefined,
    packagePublisherDisplayName: row.source_publisher_display_name || undefined,
    importedVersion: row.source_imported_version || undefined,
    latestRevisionId: row.source_latest_version_id || undefined,
    latestVersion: row.source_latest_version || undefined,
    baselineActorVersion,
    syncMode: row.source_sync_mode === "manual_merge" ? "manual_merge" : "notify",
    hasLocalChanges,
    hasUpstreamUpdate,
    status,
    createdAt: row.source_created_at || row.created_at,
    updatedAt: row.source_updated_at || row.updated_at,
  };
}

function buildActorDefinition(row: {
  name: string;
  role: ActorRole;
  title: string;
  avatar_file_id?: string | null;
  avatar_emoji?: string | null;
  parent_id: string | null;
  can_represent_user: boolean;
  specialties: string[] | null;
  config: Record<string, unknown> | string | null;
}, docs: ActorDoc[]): ActorDefinition {
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    avatarFileId: row.avatar_file_id || undefined,
    avatarEmoji: row.avatar_emoji || undefined,
    parentId: row.parent_id || undefined,
    canRepresentUser: Boolean(row.can_represent_user),
    docs: sortDocs(docs),
    specialties: sanitizeSpecialties(row.specialties || []),
    config: parseJsonObject(row.config),
  };
}

function buildActorVersionSource(
  source?: ActorUpdateSourceInput | null,
): ActorVersionSource | undefined {
  if (!source) return undefined;
  return {
    type: source.type,
    workspaceMemberId: source.workspaceMemberId || undefined,
    actorId: source.actorId || undefined,
    sessionId: source.sessionId || undefined,
    turnId: source.turnId || undefined,
    conversationId: source.conversationId || undefined,
    reason: source.reason || undefined,
  };
}

function buildActorVersionSourceFromRow(row: Pick<
  ActorVersionRow,
  | "source_type"
  | "source_workspace_member_id"
  | "source_actor_id"
  | "source_session_id"
  | "source_turn_id"
  | "source_conversation_id"
  | "source_reason"
>): ActorVersionSource {
  return {
    type: row.source_type,
    workspaceMemberId: row.source_workspace_member_id || undefined,
    actorId: row.source_actor_id || undefined,
    sessionId: row.source_session_id || undefined,
    turnId: row.source_turn_id || undefined,
    conversationId: row.source_conversation_id || undefined,
    reason: row.source_reason || undefined,
  };
}

function mapActorRow(row: ActorRow, docs: ActorDoc[]): Actor {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.source_catalog_item_id || undefined,
    definition: buildActorDefinition(row, docs),
    avatarUrl: row.avatar_file_id
      ? getFileUrlById(row.avatar_file_id)
      : undefined,
    currentVersion: row.current_version,
    sourceLink: buildActorSourceLink(row),
    isActive: Boolean(row.is_active),
    isPublicShared: Boolean(row.is_public_shared),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActorVersionRow(row: ActorVersionRow, docs: ActorDoc[]): ActorVersion {
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
    createdByWorkspaceMemberId:
      row.created_by_workspace_member_id || undefined,
    source: buildActorVersionSourceFromRow(row),
    createdAt: row.created_at,
  };
}

function summarizeUnknownValue(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "string") return value.trim() || "empty";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty";
    return value.map((entry) => summarizeUnknownValue(entry)).join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "updated";
  }
}

function buildFieldSummary(
  field: ActorVersionChangedField,
  before: unknown,
  after: unknown,
) {
  return textBlocks(
    `${field} changed from "${summarizeUnknownValue(before)}" to "${summarizeUnknownValue(after)}".`,
  );
}

function buildFieldChange(
  field: ActorVersionChangedField,
  before: unknown,
  after: unknown,
): ActorVersionChange {
  return {
    kind: "field",
    field,
    before,
    after,
    summary: buildFieldSummary(field, before, after),
  };
}

function buildDocFieldChanges(
  beforeDoc: ActorDoc | undefined,
  afterDoc: ActorDoc | undefined,
): ActorDocFieldChange[] {
  const changes: ActorDocFieldChange[] = [];

  if (!beforeDoc || !afterDoc) {
    return changes;
  }

  if (beforeDoc.title !== afterDoc.title) {
    changes.push({
      field: "title",
      before: beforeDoc.title,
      after: afterDoc.title,
    });
  }
  if (beforeDoc.visibility !== afterDoc.visibility) {
    changes.push({
      field: "visibility",
      before: beforeDoc.visibility,
      after: afterDoc.visibility,
    });
  }
  if (beforeDoc.priority !== afterDoc.priority) {
    changes.push({
      field: "priority",
      before: beforeDoc.priority,
      after: afterDoc.priority,
    });
  }
  if (!jsonEqual(beforeDoc.content, afterDoc.content)) {
    changes.push({
      field: "content",
      beforeSummaryText: summarizeActorDoc(beforeDoc, 180),
      afterSummaryText: summarizeActorDoc(afterDoc, 180),
    });
  }

  return changes;
}

function buildDocChange(beforeDoc: ActorDoc | undefined, afterDoc: ActorDoc | undefined): ActorVersionDocChange | null {
  if (!beforeDoc && !afterDoc) return null;
  const referenceDoc = afterDoc || beforeDoc!;
  const changeType: ActorVersionDocChange["changeType"] = beforeDoc && afterDoc
    ? "updated"
    : afterDoc
      ? "added"
      : "removed";
  const summaryText =
    summarizeActorDoc(afterDoc || beforeDoc!, 180) ||
    `${referenceDoc.title} ${changeType}`;

  return {
    kind: "doc",
    docId: referenceDoc.id,
    key: referenceDoc.key,
    title: referenceDoc.title,
    changeType,
    visibility: referenceDoc.visibility,
    priority: referenceDoc.priority,
    fieldChanges: buildDocFieldChanges(beforeDoc, afterDoc),
    summary: textBlocks(summaryText),
  };
}

function buildActorVersionDelta(
  before: ActorDefinition,
  after: ActorDefinition,
  fromVersion: number,
  toVersion: number,
  source?: ActorUpdateSourceInput,
): ActorVersionDelta | undefined {
  const changes: ActorVersionChange[] = [];

  if (before.name !== after.name) {
    changes.push(buildFieldChange("name", before.name, after.name));
  }
  if (before.role !== after.role) {
    changes.push(buildFieldChange("role", before.role, after.role));
  }
  if (before.title !== after.title) {
    changes.push(buildFieldChange("title", before.title, after.title));
  }
  if ((before.parentId || null) !== (after.parentId || null)) {
    changes.push(buildFieldChange("parentId", before.parentId || null, after.parentId || null));
  }
  if (before.canRepresentUser !== after.canRepresentUser) {
    changes.push(buildFieldChange("canRepresentUser", before.canRepresentUser, after.canRepresentUser));
  }
  if (!arraysEqual(before.specialties, after.specialties)) {
    changes.push(buildFieldChange("specialties", before.specialties, after.specialties));
  }
  if (!jsonEqual(before.config, after.config)) {
    changes.push(buildFieldChange("config", before.config, after.config));
  }

  const docIds = new Set([
    ...before.docs.map((doc) => doc.id),
    ...after.docs.map((doc) => doc.id),
  ]);
  const beforeDocs = new Map(before.docs.map((doc) => [doc.id, doc]));
  const afterDocs = new Map(after.docs.map((doc) => [doc.id, doc]));
  const docChanges = Array.from(docIds)
    .map((docId) => {
      const beforeDoc = beforeDocs.get(docId);
      const afterDoc = afterDocs.get(docId);
      if (beforeDoc && afterDoc) {
        const unchanged =
          beforeDoc.key === afterDoc.key &&
          beforeDoc.title === afterDoc.title &&
          beforeDoc.visibility === afterDoc.visibility &&
          beforeDoc.priority === afterDoc.priority &&
          jsonEqual(beforeDoc.content, afterDoc.content);
        if (unchanged) return null;
      }
      return buildDocChange(beforeDoc, afterDoc);
    })
    .filter((value): value is ActorVersionDocChange => Boolean(value));

  changes.push(...docChanges);

  if (changes.length === 0) {
    return undefined;
  }

  return {
    fromVersion,
    toVersion,
    source: buildActorVersionSource(source),
    changes,
    summary: changes.flatMap((change) => change.summary),
  };
}

function toActorVersionChangeWire(change: ActorVersionChange) {
  if (change.kind === "field") {
    return {
      kind: "field" as const,
      field: change.field,
      before: change.before,
      after: change.after,
      summaryText: extractText(change.summary).replace(/\s+/g, " ").trim() || undefined,
    };
  }

  return {
    kind: "doc" as const,
    docId: change.docId,
    key: change.key,
    title: change.title,
    changeType: change.changeType,
    visibility: change.visibility,
    priority: change.priority,
    fieldChanges: change.fieldChanges,
    summaryText: extractText(change.summary).replace(/\s+/g, " ").trim() || undefined,
  };
}

async function emitActorVersionChangedEvents(params: {
  workspaceId: UUID;
  actorId: UUID;
  actorName: string;
  actorTitle: string;
  actorAvatarUrl?: string;
  actorAvatarEmoji?: string;
  delta: ActorVersionDelta;
}) {
  const memberships = await runQuery<{ conversation_id: string }>(
    `SELECT DISTINCT cp.conversation_id
     FROM conversation_participants cp
     JOIN conversations c ON c.id = cp.conversation_id
     WHERE cp.actor_id = $1
       AND cp.state = 'active'
       AND c.kind = $2`,
    [params.actorId, GROUP_CONVERSATION_KIND],
  );

  if (memberships.rows.length === 0) return;

  const changes = params.delta.changes.map(toActorVersionChangeWire);

  await Promise.all(
    memberships.rows.map((membership) =>
      createConversationEvent({
        workspaceId: params.workspaceId,
        conversationId: membership.conversation_id,
        eventType: "actor_version_changed",
        timelinePolicy: "all_members",
        contextPolicy: "shared",
        metadata: {
          actorId: params.actorId,
          fromVersion: params.delta.fromVersion,
          toVersion: params.delta.toVersion,
        },
        eventPayload: {
          actor: {
            participantType: "actor",
            actorId: params.actorId,
            name: params.actorName,
            title: params.actorTitle,
            avatarUrl: params.actorAvatarUrl,
            avatarEmoji: params.actorAvatarEmoji,
          },
          fromVersion: params.delta.fromVersion,
          toVersion: params.delta.toVersion,
          changes,
          source: params.delta.source,
        },
      }),
    ),
  );
}

async function runQuery<T extends QueryRow>(text: string, params?: unknown[]) {
  return executeSql<T>(text, params);
}

function clientQuery(client: pg.PoolClient): QueryRunner {
  return async <T extends QueryRow>(text: string, params?: unknown[]) =>
    executeSqlOn<T>(client, text, params);
}

async function loadActorDocsMap(
  runner: QueryRunner,
  actorVersionIds: string[],
): Promise<Map<string, ActorDoc[]>> {
  if (actorVersionIds.length === 0) {
    return new Map();
  }

  const result = await runner<ActorDocRow>(
    `SELECT id, actor_version_id, doc_key, title, visibility, priority, content_blocks
     FROM actor_version_docs
     WHERE actor_version_id = ANY($1::uuid[])
     ORDER BY priority DESC, created_at ASC`,
    [actorVersionIds],
  );

  const docsByVersionId = new Map<string, ActorDoc[]>();
  for (const row of result.rows) {
    const docs = docsByVersionId.get(row.actor_version_id) || [];
    docs.push({
      id: row.id,
      key: row.doc_key,
      title: row.title,
      visibility: row.visibility,
      priority: row.priority,
      content: normalizeCanonicalContentBlocks(parseJsonArray(row.content_blocks)),
    });
    docsByVersionId.set(row.actor_version_id, docs);
  }

  for (const [versionId, docs] of docsByVersionId.entries()) {
    docsByVersionId.set(versionId, sortDocs(docs));
  }

  return docsByVersionId;
}

async function getActorRowsByIds(
  workspaceId: UUID,
  actorIds: UUID[],
): Promise<ActorRow[]> {
  if (actorIds.length === 0) return [];

  const result = await runQuery<ActorRow>(
    `${ACTOR_SELECT}
     WHERE a.workspace_id = $1
       AND a.id = ANY($2::uuid[])
     ORDER BY a.created_at DESC`,
    [workspaceId, actorIds],
  );

  return result.rows;
}

async function getActorRow(
  workspaceId: UUID,
  actorId: UUID,
  runner: QueryRunner = runQuery,
): Promise<ActorRow | null> {
  const result = await runner<ActorRow>(
    `${ACTOR_SELECT}
     WHERE a.workspace_id = $1
       AND a.id = $2
     LIMIT 1`,
    [workspaceId, actorId],
  );
  return result.rows[0] || null;
}

async function ensureParentActor(
  workspaceId: UUID,
  parentId: UUID | null | undefined,
  actorId?: UUID,
  runner: QueryRunner = runQuery,
) {
  if (!parentId) return;
  if (actorId && parentId === actorId) {
    throw new Error("Actor cannot be its own parent");
  }

  const parent = await runner<{ id: string }>(
    `SELECT id
     FROM actors
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [parentId, workspaceId],
  );

  if (parent.rows.length === 0) {
    throw new Error("Parent actor not found");
  }
}

async function buildActorResponseFromRows(rows: ActorRow[]) {
  if (rows.length === 0) return [];
  const docsByVersionId = await loadActorDocsMap(
    runQuery,
    rows.map((row) => row.current_actor_version_id),
  );
  return rows.map((row) =>
    mapActorRow(row, docsByVersionId.get(row.current_actor_version_id) || []),
  );
}

export async function listActors(
  workspaceId: UUID,
  subject: AccessSubject,
): Promise<Actor[]> {
  const actorIds = await listAuthorizedResourceIds({
    subject,
    action: "actor.view",
  });
  const rows = await getActorRowsByIds(workspaceId, actorIds as UUID[]);
  return buildActorResponseFromRows(rows);
}

export async function getFullOrgTree(
  workspaceId: UUID,
  subject: AccessSubject,
): Promise<ActorTreeNode[]> {
  const actors = await listActors(workspaceId, subject);
  const nodes = new Map<string, ActorTreeNode>(
    actors.map((actor) => [actor.id, { ...actor, children: [] }]),
  );
  const roots: ActorTreeNode[] = [];

  for (const actor of nodes.values()) {
    const parentId = actor.definition.parentId;
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId)!.children.push(actor);
      continue;
    }
    roots.push(actor);
  }

  return roots;
}

export async function getActor(
  actorId: UUID,
  workspaceId: UUID,
): Promise<Actor | null> {
  const row = await getActorRow(workspaceId, actorId);
  if (!row) return null;
  const docsByVersionId = await loadActorDocsMap(runQuery, [row.current_actor_version_id]);
  return mapActorRow(row, docsByVersionId.get(row.current_actor_version_id) || []);
}

export async function listActorVersions(
  actorId: UUID,
  workspaceId: UUID,
): Promise<ActorVersion[]> {
  const actorExists = await runQuery<{ id: string }>(
    `SELECT id
     FROM actors
     WHERE id = $1
       AND workspace_id = $2
     LIMIT 1`,
    [actorId, workspaceId],
  );
  if (actorExists.rows.length === 0) return [];

  const result = await runQuery<ActorVersionRow>(
    `SELECT
        id,
        actor_id,
        version,
        previous_version_id,
        name,
        role,
        title,
        parent_id,
        can_represent_user,
        specialties,
        config,
        version_delta,
        created_by_workspace_member_id,
        source_type,
        source_workspace_member_id,
        source_actor_id,
        source_session_id,
        source_turn_id,
        source_conversation_id,
        source_reason,
        created_at
     FROM actor_versions
     WHERE actor_id = $1
     ORDER BY version DESC`,
    [actorId],
  );

  const docsByVersionId = await loadActorDocsMap(
    runQuery,
    result.rows.map((row) => row.id),
  );

  return result.rows.map((row) =>
    mapActorVersionRow(row, docsByVersionId.get(row.id) || []),
  );
}

export async function createActor(input: {
  workspaceId: UUID;
  createdByWorkspaceMemberId?: UUID;
  name: string;
  role: ActorRole;
  title?: string;
  avatarFileId?: UUID;
  avatarEmoji?: string;
  canRepresentUser?: boolean;
  docs?: ActorDocInput[];
  parentId?: UUID;
  specialties?: string[];
  config?: Record<string, unknown>;
}): Promise<Actor> {
  if (input.avatarFileId && normalizeAvatarEmoji(input.avatarEmoji)) {
    throw new Error("avatarFileId and avatarEmoji are mutually exclusive");
  }

  const docs = sortDocs(normalizeActorDocs(input.docs || []));
  const specialties = sanitizeSpecialties(input.specialties);

  const result = await transaction(async (client) => {
    const runner = clientQuery(client);
    await ensureParentActor(input.workspaceId, input.parentId, undefined, runner);

    const actorResult = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO actors (
         workspace_id,
         name,
         role,
         title,
         avatar_file_id,
         avatar_emoji,
         parent_id,
         can_represent_user,
         specialties,
         config,
         current_version,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 1, $11)
       RETURNING id`,
      [
        input.workspaceId,
        input.name,
        input.role,
        input.title || "",
        input.avatarFileId || null,
        normalizeAvatarEmoji(input.avatarEmoji) || null,
        input.parentId || null,
        Boolean(input.canRepresentUser),
        specialties,
        JSON.stringify(input.config || {}),
        input.createdByWorkspaceMemberId || null,
      ],
    );
    const actorId = actorResult.rows[0]!.id;

    const versionResult = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO actor_versions (
         actor_id,
         version,
         name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
         source_reason
       )
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        actorId,
        input.name,
        input.role,
        input.title || "",
        input.parentId || null,
        Boolean(input.canRepresentUser),
        specialties,
        JSON.stringify(input.config || {}),
        input.createdByWorkspaceMemberId || null,
        input.createdByWorkspaceMemberId ? "workspace_member" : "system",
        input.createdByWorkspaceMemberId || null,
        "actor_create",
      ],
    );
    const actorVersionId = versionResult.rows[0]!.id;

    for (const doc of docs) {
      await executeSqlOn(client, 
        `INSERT INTO actor_version_docs (
           actor_version_id,
           doc_key,
           title,
           visibility,
           priority,
           content_blocks
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          actorVersionId,
          doc.key,
          doc.title,
          doc.visibility,
          doc.priority,
          JSON.stringify(doc.content),
        ],
      );
    }

    return {
      actorId,
    };
  });

  const actor = await getActor(result.actorId, input.workspaceId);
  if (!actor) {
    throw new Error("Failed to create actor");
  }
  return actor;
}

export async function updateActor(
  actorId: UUID,
  workspaceId: UUID,
  updates: Partial<{
    name: string;
    role: ActorRole;
    title: string;
    avatarFileId: UUID | null;
    avatarEmoji: string | null;
    canRepresentUser: boolean;
    docs: ActorDocInput[];
    parentId: UUID | null;
    specialties: string[];
    config: Record<string, unknown>;
  }>,
  source: ActorUpdateSourceInput = { type: "system" },
): Promise<Actor | null> {
  const currentActorRow = await getActorRow(workspaceId, actorId);
  if (!currentActorRow) return null;
  const currentActor = await getActor(actorId, workspaceId);
  if (!currentActor) return null;

  const currentDefinition = currentActor.definition;
  const nextAvatarFileId =
    updates.avatarFileId === undefined
      ? currentDefinition.avatarFileId
      : updates.avatarFileId || undefined;
  const nextAvatarEmoji =
    updates.avatarEmoji === undefined
      ? currentDefinition.avatarEmoji
      : normalizeAvatarEmoji(updates.avatarEmoji);

  if (nextAvatarFileId && nextAvatarEmoji) {
    throw new Error("avatarFileId and avatarEmoji are mutually exclusive");
  }

  const nextDefinition: ActorDefinition = {
    name: updates.name ?? currentDefinition.name,
    role: updates.role ?? currentDefinition.role,
    title: updates.title ?? currentDefinition.title,
    avatarFileId: nextAvatarFileId,
    avatarEmoji: nextAvatarEmoji,
    parentId:
      updates.parentId === undefined
        ? currentDefinition.parentId
        : updates.parentId || undefined,
    canRepresentUser:
      updates.canRepresentUser ?? currentDefinition.canRepresentUser,
    docs:
      updates.docs === undefined
        ? currentDefinition.docs
        : sortDocs(normalizeActorDocs(updates.docs)),
    specialties:
      updates.specialties === undefined
        ? currentDefinition.specialties
        : sanitizeSpecialties(updates.specialties),
    config:
      updates.config === undefined
        ? currentDefinition.config
        : updates.config || {},
  };

  const delta = buildActorVersionDelta(
    currentDefinition,
    nextDefinition,
    currentActor.currentVersion,
    currentActor.currentVersion + 1,
    source,
  );

  const avatarChanged =
    (currentDefinition.avatarFileId || null) !== (nextAvatarFileId || null) ||
    (currentDefinition.avatarEmoji || null) !== (nextAvatarEmoji || null);

  if (!delta) {
    if (avatarChanged) {
      await runQuery(
        `UPDATE actors
         SET avatar_file_id = $2,
             avatar_emoji = $3,
             updated_at = NOW()
         WHERE id = $1
           AND workspace_id = $4`,
        [actorId, nextAvatarFileId || null, nextAvatarEmoji || null, workspaceId],
      );
      return getActor(actorId, workspaceId);
    }
    return currentActor;
  }

  const nextVersion = currentActor.currentVersion + 1;

  await transaction(async (client) => {
    const runner = clientQuery(client);
    await ensureParentActor(
      workspaceId,
      nextDefinition.parentId || null,
      actorId,
      runner,
    );

    const versionResult = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO actor_versions (
         actor_id,
         version,
         previous_version_id,
         name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         version_delta,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
	         source_actor_id,
	         source_session_id,
	         source_turn_id,
	         source_conversation_id,
	         source_reason
	       )
	       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19)
	       RETURNING id`,
      [
        actorId,
        nextVersion,
        currentActorRow.current_actor_version_id,
        nextDefinition.name,
        nextDefinition.role,
        nextDefinition.title,
        nextDefinition.parentId || null,
        nextDefinition.canRepresentUser,
        sanitizeSpecialties(nextDefinition.specialties),
        JSON.stringify(nextDefinition.config || {}),
        JSON.stringify(delta),
        source.workspaceMemberId || null,
        source.type,
        source.workspaceMemberId || null,
        source.actorId || null,
        source.sessionId || null,
        source.turnId || null,
        source.conversationId || null,
        source.reason || null,
      ],
    );
    const actorVersionId = versionResult.rows[0]!.id;

    for (const doc of nextDefinition.docs) {
      await executeSqlOn(client, 
        `INSERT INTO actor_version_docs (
           actor_version_id,
           doc_key,
           title,
           visibility,
           priority,
           content_blocks
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          actorVersionId,
          doc.key,
          doc.title,
          doc.visibility,
          doc.priority,
          JSON.stringify(doc.content),
        ],
      );
    }

    await executeSqlOn(client, 
      `UPDATE actors
      SET name = $2,
           role = $3,
           title = $4,
           avatar_file_id = $5,
           avatar_emoji = $6,
           parent_id = $7,
           can_represent_user = $8,
           specialties = $9,
           config = $10::jsonb,
           current_version = $11,
           updated_at = NOW()
       WHERE id = $1
         AND workspace_id = $12`,
      [
        actorId,
        nextDefinition.name,
        nextDefinition.role,
        nextDefinition.title,
        nextDefinition.avatarFileId || null,
        nextDefinition.avatarEmoji || null,
        nextDefinition.parentId || null,
        nextDefinition.canRepresentUser,
        sanitizeSpecialties(nextDefinition.specialties),
        JSON.stringify(nextDefinition.config || {}),
        nextVersion,
        workspaceId,
      ],
    );
  });

  const actor = await getActor(actorId, workspaceId);
  if (!actor) return null;

  try {
    await emitActorVersionChangedEvents({
      workspaceId,
      actorId,
      actorName: actor.definition.name,
      actorTitle: actor.definition.title,
      actorAvatarUrl: actor.avatarUrl,
      actorAvatarEmoji: actor.definition.avatarEmoji,
      delta,
    });
  } catch (error) {
    console.error("[actor.update] Failed to emit actor_version_changed events:", error);
  }

  return actor;
}

export async function deleteActor(
  actorId: UUID,
  workspaceId: UUID,
): Promise<boolean> {
  const result = await transaction(async (client) => {
    const existing = await executeSqlOn<{ id: string }>(client, 
      `SELECT id
       FROM actors
       WHERE id = $1
         AND workspace_id = $2
       LIMIT 1`,
      [actorId, workspaceId],
    );
    if (existing.rows.length === 0) {
      return { deleted: false };
    }

    await executeSqlOn(client, 
      `DELETE FROM actors
       WHERE id = $1
         AND workspace_id = $2`,
      [actorId, workspaceId],
    );

    return { deleted: true };
  });

  return result.deleted;
}

export async function listActorPackages(params: {
  workspaceId: UUID;
  search?: string;
}): Promise<ActorPackageRecord[]> {
  const values: unknown[] = [params.workspaceId];
  const searchSql = params.search?.trim()
    ? `AND (
         item.display_name ILIKE $2
         OR item.slug ILIKE $2
         OR item.summary ILIKE $2
         OR publisher.display_name ILIKE $2
       )`
    : "";
  if (searchSql) {
    values.push(`%${params.search!.trim()}%`);
  }

  const result = await runQuery<ActorPackageRow>(
    `${ACTOR_PACKAGE_SELECT}
       AND (
         (item.workspace_id IS NULL AND item.visibility <> 'private')
         OR item.workspace_id = $1
       )
       ${searchSql}
     ORDER BY item.download_count DESC, item.updated_at DESC`,
    values,
  );

  return result.rows.map(buildActorPackageRecord);
}

export async function getActorPackage(
  packageId: UUID,
  workspaceId: UUID,
): Promise<ActorPackageRecord> {
  const result = await runQuery<ActorPackageRow>(
    `${ACTOR_PACKAGE_SELECT}
       AND item.id = $1
       AND (
         (item.workspace_id IS NULL AND item.visibility <> 'private')
         OR item.workspace_id = $2
       )
     LIMIT 1`,
    [packageId, workspaceId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Actor package not found");
  }

  return buildActorPackageRecord(row);
}

export async function installActorPackage(input: {
  workspaceId: UUID;
  packageId: UUID;
  createdByWorkspaceMemberId?: UUID;
  name?: string;
  title?: string;
  parentId?: UUID | null;
  syncMode?: ActorPackageSyncMode;
}): Promise<ActorPackageInstallResult> {
  const actorPackage = await getActorPackage(input.packageId, input.workspaceId);
  const packageActor = actorPackage.manifest.actor;
  const actorName = input.name?.trim() || packageActor.name || actorPackage.package.displayName;
  const actorTitle = input.title ?? packageActor.title;
  const syncMode = input.syncMode || "notify";

  const result = await transaction(async (client) => {
    const runner = clientQuery(client);
    await ensureParentActor(input.workspaceId, input.parentId || null, undefined, runner);

    const actorResult = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO actors (
         workspace_id,
         name,
         role,
         title,
         avatar_file_id,
         avatar_emoji,
         parent_id,
         can_represent_user,
         specialties,
         config,
         current_version,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 1, $11)
       RETURNING id`,
      [
        input.workspaceId,
        actorName,
        packageActor.role,
        actorTitle,
        packageActor.avatarFileId || null,
        packageActor.avatarEmoji || null,
        input.parentId || null,
        packageActor.canRepresentUser,
        sanitizeSpecialties(packageActor.specialties),
        JSON.stringify(packageActor.config || {}),
        input.createdByWorkspaceMemberId || null,
      ],
    );
    const actorId = actorResult.rows[0]!.id;

    const versionResult = await executeSqlOn<{ id: string }>(client, 
      `INSERT INTO actor_versions (
         actor_id,
         version,
         name,
         role,
         title,
         parent_id,
         can_represent_user,
         specialties,
         config,
         created_by_workspace_member_id,
         source_type,
         source_workspace_member_id,
         source_reason
       )
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        actorId,
        actorName,
        packageActor.role,
        actorTitle,
        input.parentId || null,
        packageActor.canRepresentUser,
        sanitizeSpecialties(packageActor.specialties),
        JSON.stringify(packageActor.config || {}),
        input.createdByWorkspaceMemberId || null,
        input.createdByWorkspaceMemberId ? "workspace_member" : "system",
        input.createdByWorkspaceMemberId || null,
        "actor_package_install",
      ],
    );
    const actorVersionId = versionResult.rows[0]!.id;

    for (const doc of packageActor.docs) {
      await executeSqlOn(client, 
        `INSERT INTO actor_version_docs (
           actor_version_id,
           doc_key,
           title,
           visibility,
           priority,
           content_blocks
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          actorVersionId,
          doc.key,
          doc.title,
          doc.visibility,
          doc.priority,
          JSON.stringify(doc.content),
        ],
      );
    }

    await executeSqlOn(client, 
      `INSERT INTO actor_source_refs (
         actor_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         baseline_actor_version
       )
       VALUES ($1, $2, $3, $4, 1)`,
      [
        actorId,
        actorPackage.package.id,
        actorPackage.package.latestRevisionId || null,
        syncMode,
      ],
    );

    await executeSqlOn(client, 
      `UPDATE catalog_items
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [actorPackage.package.id],
    );

    return {
      actorId,
    };
  });

  const actor = await getActor(result.actorId, input.workspaceId);
  if (!actor) {
    throw new Error("Failed to install actor package");
  }

  return {
    actor,
    sourcePackage: actorPackage,
    sourceLink: actor.sourceLink!,
    requirementChecks: [],
  };
}
