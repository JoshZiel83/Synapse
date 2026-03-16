import type pg from 'pg';
import { getFileUrl } from '../../infrastructure/storage/index.js';
import { query, transaction } from '../../infrastructure/database/index.js';
import {
  authzEnabled,
  buildWorkspaceUserContextId,
  diffAuthzRelationships,
  flushAuthzOutboxEntries,
  lookupResources,
  queueAuthzRelationships,
  touchRelation,
  touchWorkspaceUserContext,
  type AuthzRelationMutation,
  type AuthzSubject,
} from '../../infrastructure/authz/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { createConversationEvent, getConversationFeedItemById } from '../conversation/service.js';
import {
  createCapabilityPackage,
  createCapabilityPublisher,
  createCapabilityRevision,
  evaluateCapabilityRequirements,
  getCapabilityPackage,
  listCapabilityPackages,
  listRevisionRequirements,
  replaceRevisionRequirements,
} from '../capabilities/service.js';
import { builtinActorTemplateSeeds } from './builtin-actor-templates.js';
import {
  extractText,
  generateId,
  normalizeCanonicalContentBlocks,
  normalizeActorDocs,
  nowISO,
  summarizeActorDoc,
  summarizeActorForPrompt,
  summarizeActorForRole,
  textBlocks,
} from '@synapse/shared';
import type {
  Actor,
  ActorCollaboration,
  ActorDefinition,
  ActorDoc,
  ActorDocInput,
  ActorRole,
  ActorTemplateCloneResult,
  ActorTemplateDependency,
  ActorTemplateLink,
  ActorTemplateLinkStatus,
  ActorTemplateRecord,
  ActorTemplateSyncMode,
  ActorVersion,
  ActorVersionChangedField,
  ActorVersionDelta,
  ActorVersionDocChange,
  CapabilityRequirement,
  UUID,
} from '@synapse/shared';

const ACTOR_ROLES: ActorRole[] = ['secretary', 'manager', 'specialist', 'reviewer', 'archivist', 'receptionist', 'assistant'];

type ActorGrantPermission =
  | 'discover'
  | 'invoke'
  | 'receive_message'
  | 'memory_read'
  | 'memory_edit'
  | 'memory_grant'
  | 'memory_retarget'
  | 'memory_delete';
type ActorGrantScope = 'workspace' | 'user' | 'workspace_user' | 'conversation' | 'actor';
type ActorGrantRow = {
  id?: string;
  actor_id?: string;
  permission: ActorGrantPermission;
  grant_scope: ActorGrantScope;
  workspace_id: string | null;
  user_id: string | null;
  conversation_id: string | null;
  actor_subject_id: string | null;
  status: 'active' | 'revoked';
  granted_by?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  revoked_at?: string | null;
};

const ACTOR_SELECT = `
  a.*,
  avatar_file.stored_name AS avatar_stored_name,
  atl.template_package_id,
  atl.imported_revision_id AS template_imported_revision_id,
  atl.baseline_actor_version AS template_baseline_actor_version,
  atl.sync_mode AS template_sync_mode,
  atl.created_at AS template_link_created_at,
  atl.updated_at AS template_link_updated_at,
  template_pkg.slug AS template_slug,
  template_pkg.display_name AS template_display_name,
  template_pkg.latest_revision_id AS template_latest_revision_id,
  template_publisher.slug AS template_publisher_slug,
  template_publisher.display_name AS template_publisher_display_name,
  imported_template_revision.version AS template_imported_revision_version,
  latest_template_revision.version AS template_latest_revision_version
`;

const ACTOR_JOINS = `
  FROM actors a
  LEFT JOIN files avatar_file ON avatar_file.id = a.avatar_file_id
  LEFT JOIN actor_template_links atl ON atl.actor_id = a.id
  LEFT JOIN capability_packages template_pkg ON template_pkg.id = atl.template_package_id
  LEFT JOIN capability_publishers template_publisher ON template_publisher.id = template_pkg.publisher_id
  LEFT JOIN capability_package_revisions imported_template_revision ON imported_template_revision.id = atl.imported_revision_id
  LEFT JOIN capability_package_revisions latest_template_revision ON latest_template_revision.id = template_pkg.latest_revision_id
`;

type ActorUpdateInput = Partial<{
  name: string;
  role: ActorRole;
  title: string;
  avatarFileId: UUID | null;
  canRepresentUser: boolean;
  docs: ActorDocInput[];
  parentId: UUID | null;
  capabilities: string[];
  config: Record<string, unknown>;
}>;

type ActorTemplateCloneInput = {
  workspaceId: UUID;
  templateId: UUID;
  createdBy?: UUID;
  name?: string;
  title?: string;
  parentId?: UUID | null;
  syncMode?: ActorTemplateSyncMode;
};

function isActorRole(value: unknown): value is ActorRole {
  return typeof value === 'string' && ACTOR_ROLES.includes(value as ActorRole);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseJsonArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeContentBlocks(value: unknown) {
  return normalizeCanonicalContentBlocks(parseJsonArray<any>(value));
}

function sanitizeCapabilities(capabilities?: string[]): string[] {
  return Array.from(new Set((capabilities || []).map((item) => item.trim()).filter(Boolean)));
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (!authzEnabled() || entryIds.length === 0) return;

  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source} relationship updates:`, error);
  }
}

function defaultActorGrantRows(workspaceId: UUID): ActorGrantRow[] {
  return [
    {
      permission: 'discover',
      grant_scope: 'workspace',
      workspace_id: workspaceId,
      user_id: null,
      conversation_id: null,
      actor_subject_id: null,
      status: 'active',
    },
    {
      permission: 'invoke',
      grant_scope: 'workspace',
      workspace_id: workspaceId,
      user_id: null,
      conversation_id: null,
      actor_subject_id: null,
      status: 'active',
    },
  ];
}

async function insertActorGrantRows(
  queryable: Pick<pg.PoolClient, 'query'>,
  actorId: string,
  grants: ActorGrantRow[],
) {
  for (const grant of grants) {
    await queryable.query(
      `INSERT INTO actor_grants (
         actor_id,
         permission,
         grant_scope,
         workspace_id,
         user_id,
         conversation_id,
         actor_subject_id,
         status,
         granted_by,
         reason,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        actorId,
        grant.permission,
        grant.grant_scope,
        grant.workspace_id,
        grant.user_id,
        grant.conversation_id,
        grant.actor_subject_id,
        grant.status,
        grant.granted_by ?? null,
        grant.reason ?? null,
        JSON.stringify(grant.metadata ?? {}),
      ],
    );
  }
}

function actorWorkspaceRelation(permission: ActorGrantPermission) {
  switch (permission) {
    case 'discover':
      return 'discover_workspace';
    case 'invoke':
      return 'invoke_workspace';
    case 'receive_message':
      return 'receive_workspace';
    case 'memory_read':
      return 'memory_reader_workspace';
    case 'memory_edit':
      return 'memory_editor_workspace';
    case 'memory_grant':
      return 'memory_granter_workspace';
    case 'memory_retarget':
      return 'memory_retargeter_workspace';
    case 'memory_delete':
      return 'memory_deleter_workspace';
    default:
      return null;
  }
}

function actorWorkspaceUserRelation(permission: ActorGrantPermission) {
  switch (permission) {
    case 'discover':
      return 'discover_workspace_user';
    case 'invoke':
      return 'invoke_workspace_user';
    case 'receive_message':
      return 'receive_workspace_user';
    case 'memory_read':
      return 'memory_reader_workspace_user';
    case 'memory_edit':
      return 'memory_editor_workspace_user';
    case 'memory_grant':
      return 'memory_granter_workspace_user';
    case 'memory_retarget':
      return 'memory_retargeter_workspace_user';
    case 'memory_delete':
      return 'memory_deleter_workspace_user';
    default:
      return null;
  }
}

function actorPrincipalRelation(permission: ActorGrantPermission) {
  switch (permission) {
    case 'discover':
      return 'discover_principal';
    case 'invoke':
      return 'invoke_principal';
    case 'receive_message':
      return 'receive_principal';
    case 'memory_read':
      return 'memory_reader_principal';
    case 'memory_edit':
      return 'memory_editor_principal';
    case 'memory_grant':
      return 'memory_granter_principal';
    case 'memory_retarget':
      return 'memory_retargeter_principal';
    case 'memory_delete':
      return 'memory_deleter_principal';
    default:
      return null;
  }
}

function actorConversationRelation(permission: ActorGrantPermission) {
  switch (permission) {
    case 'discover':
      return 'discover_conversation';
    case 'invoke':
      return 'invoke_conversation';
    case 'receive_message':
      return 'receive_conversation';
    case 'memory_read':
      return 'memory_reader_conversation';
    case 'memory_edit':
      return 'memory_editor_conversation';
    case 'memory_grant':
      return 'memory_granter_conversation';
    case 'memory_retarget':
      return 'memory_retargeter_conversation';
    case 'memory_delete':
      return 'memory_deleter_conversation';
    default:
      return null;
  }
}

function buildActorGrantRelations(actorId: string, grant: ActorGrantRow): AuthzRelationMutation[] {
  if (grant.status !== 'active') {
    return [];
  }

  switch (grant.grant_scope) {
    case 'workspace': {
      const relation = actorWorkspaceRelation(grant.permission);
      return relation && grant.workspace_id
        ? [touchRelation('actor', actorId, relation, 'workspace', grant.workspace_id)]
        : [];
    }
    case 'user': {
      const relation = actorPrincipalRelation(grant.permission);
      return relation && grant.user_id
        ? [touchRelation('actor', actorId, relation, 'user', grant.user_id)]
        : [];
    }
    case 'workspace_user': {
      const relation = actorWorkspaceUserRelation(grant.permission);
      return relation && grant.workspace_id && grant.user_id
        ? [
            ...touchWorkspaceUserContext(grant.workspace_id, grant.user_id),
            touchRelation(
              'actor',
              actorId,
              relation,
              'workspace_user',
              buildWorkspaceUserContextId(grant.workspace_id, grant.user_id),
            ),
          ]
        : [];
    }
    case 'conversation': {
      const relation = actorConversationRelation(grant.permission);
      return relation && grant.conversation_id
        ? [touchRelation('actor', actorId, relation, 'conversation', grant.conversation_id)]
        : [];
    }
    case 'actor': {
      const relation = actorPrincipalRelation(grant.permission);
      return relation && grant.actor_subject_id
        ? [touchRelation('actor', actorId, relation, 'actor', grant.actor_subject_id)]
        : [];
    }
    default:
      return [];
  }
}

function buildActorAuthzRelations(actorId: string, workspaceId: string, grants: ActorGrantRow[]): AuthzRelationMutation[] {
  return [
    touchRelation('workspace', workspaceId, 'actor', 'actor', actorId),
    touchRelation('actor', actorId, 'workspace', 'workspace', workspaceId),
    ...grants.flatMap((grant) => buildActorGrantRelations(actorId, grant)),
  ];
}

async function listActorGrantRows(actorId: string, workspaceId: string) {
  const result = await query<ActorGrantRow & { id: string; actor_id: string; created_at: string; revoked_at: string | null }>(
    `SELECT *
     FROM actor_grants
     WHERE actor_id = $1
       AND (
         workspace_id = $2
         OR workspace_id IS NULL
       )
     ORDER BY created_at DESC`,
    [actorId, workspaceId],
  );
  return result.rows;
}

function mapActorGrantRow(row: ActorGrantRow & { id: string; actor_id: string; created_at: string; revoked_at: string | null }) {
  return {
    id: row.id,
    actorId: row.actor_id,
    permission: row.permission,
    grantScope: row.grant_scope,
    workspaceId: row.workspace_id || undefined,
    userId: row.user_id || undefined,
    conversationId: row.conversation_id || undefined,
    actorSubjectId: row.actor_subject_id || undefined,
    status: row.status,
    grantedBy: row.granted_by || undefined,
    reason: row.reason || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    revokedAt: row.revoked_at || undefined,
  };
}

async function assertConversationInWorkspace(conversationId: string, workspaceId: string) {
  const result = await query(
    `SELECT 1
     FROM conversations
     WHERE id = $1 AND workspace_id = $2
     LIMIT 1`,
    [conversationId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new Error('Conversation does not belong to this workspace');
  }
}

async function assertActorInWorkspace(actorId: string, workspaceId: string) {
  const result = await query(
    `SELECT 1
     FROM actors
     WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE
     LIMIT 1`,
    [actorId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new Error('Actor does not belong to this workspace');
  }
}

async function assertWorkspaceMember(userId: string, workspaceId: string) {
  const result = await query(
    `SELECT 1
     FROM workspace_members
     WHERE user_id = $1 AND workspace_id = $2
     LIMIT 1`,
    [userId, workspaceId],
  );
  if (result.rows.length === 0) {
    throw new Error('User is not a member of this workspace');
  }
}

async function assertUserExists(userId: string) {
  const result = await query(
    `SELECT 1
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  if (result.rows.length === 0) {
    throw new Error('User does not exist');
  }
}

function buildDocsFromRow(row: any): ActorDoc[] {
  return normalizeActorDocs(parseJsonArray<ActorDoc>(row.docs));
}

function buildDefinitionFromValues(values: {
  name: string;
  role: ActorRole;
  title: string;
  avatarFileId?: UUID;
  parentId?: UUID;
  canRepresentUser: boolean;
  docs: ActorDocInput[];
  capabilities: string[];
  config: Record<string, unknown>;
}): ActorDefinition {
  return {
    name: values.name,
    role: values.role,
    title: values.title,
    avatarFileId: values.avatarFileId,
    parentId: values.parentId,
    canRepresentUser: values.canRepresentUser,
    docs: normalizeActorDocs(values.docs),
    capabilities: sanitizeCapabilities(values.capabilities),
    config: values.config,
  };
}

function buildDefinitionFromRow(row: any): ActorDefinition {
  const docs = buildDocsFromRow(row);
  const capabilities = sanitizeCapabilities(
    Array.isArray(row.capabilities) ? row.capabilities : parseJsonArray<string>(row.capabilities),
  );
  const config = parseJsonObject(row.config);

  return buildDefinitionFromValues({
    name: row.name,
    role: row.role,
    title: row.title || '',
    avatarFileId: row.avatar_file_id ?? undefined,
    parentId: row.parent_id ?? undefined,
    canRepresentUser: Boolean(row.can_represent_user),
    docs,
    capabilities,
    config,
  });
}

function makeDefinitionForWrite(input: {
  existingRow?: any;
  updates: ActorUpdateInput & {
    name?: string;
    role?: ActorRole;
    title?: string;
  };
}): ActorDefinition {
  const previous = input.existingRow ? buildDefinitionFromRow(input.existingRow) : null;
  const storedDocs = input.existingRow ? normalizeActorDocs(parseJsonArray<ActorDoc>(input.existingRow.docs)) : [];
  const hasStoredDocs = storedDocs.length > 0;

  const name = input.updates.name ?? previous?.name ?? '';
  const role = input.updates.role ?? previous?.role ?? 'specialist';
  const title = input.updates.title ?? previous?.title ?? '';
  const avatarFileId = 'avatarFileId' in input.updates
    ? input.updates.avatarFileId ?? undefined
    : previous?.avatarFileId;
  const parentId = 'parentId' in input.updates
    ? input.updates.parentId ?? undefined
    : previous?.parentId;
  const canRepresentUser = input.updates.canRepresentUser ?? previous?.canRepresentUser ?? false;
  const capabilities = sanitizeCapabilities(input.updates.capabilities ?? previous?.capabilities ?? []);
  const config = input.updates.config ?? previous?.config ?? {};
  const docs = 'docs' in input.updates
    ? normalizeActorDocs(input.updates.docs ?? [])
    : hasStoredDocs
      ? storedDocs
      : previous?.docs ?? [];

  return buildDefinitionFromValues({
    name,
    role,
    title,
    avatarFileId,
    parentId,
    canRepresentUser,
    docs,
    capabilities,
    config,
  });
}

function definitionsEqual(left: ActorDefinition, right: ActorDefinition): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function computeFieldChanges(previous: ActorDefinition, next: ActorDefinition): ActorVersionChangedField[] {
  const changed: ActorVersionChangedField[] = [];

  const checks: Array<[ActorVersionChangedField, unknown, unknown]> = [
    ['name', previous.name, next.name],
    ['role', previous.role, next.role],
    ['title', previous.title, next.title],
    ['avatarFileId', previous.avatarFileId ?? null, next.avatarFileId ?? null],
    ['parentId', previous.parentId ?? null, next.parentId ?? null],
    ['canRepresentUser', previous.canRepresentUser, next.canRepresentUser],
    ['capabilities', previous.capabilities, next.capabilities],
    ['config', previous.config, next.config],
  ];

  for (const [field, beforeValue, afterValue] of checks) {
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changed.push(field);
    }
  }

  return changed;
}

function computeDocChanges(previousDocs: ActorDoc[], nextDocs: ActorDoc[]): ActorVersionDocChange[] {
  const previousById = new Map(previousDocs.map((doc) => [doc.id, doc]));
  const nextById = new Map(nextDocs.map((doc) => [doc.id, doc]));
  const docIds = new Set([...previousById.keys(), ...nextById.keys()]);
  const changes: ActorVersionDocChange[] = [];

  for (const docId of docIds) {
    const beforeDoc = previousById.get(docId);
    const afterDoc = nextById.get(docId);

    if (!beforeDoc && afterDoc) {
      changes.push({
        docId: afterDoc.id,
        key: afterDoc.key,
        title: afterDoc.title,
        changeType: 'added',
        visibility: afterDoc.visibility,
        priority: afterDoc.priority,
        after: afterDoc,
        summary: textBlocks(summarizeActorDoc(afterDoc, 200) || `${afterDoc.title} added.`),
      });
      continue;
    }

    if (beforeDoc && !afterDoc) {
      changes.push({
        docId: beforeDoc.id,
        key: beforeDoc.key,
        title: beforeDoc.title,
        changeType: 'removed',
        visibility: beforeDoc.visibility,
        priority: beforeDoc.priority,
        before: beforeDoc,
        summary: textBlocks(summarizeActorDoc(beforeDoc, 200) || `${beforeDoc.title} removed.`),
      });
      continue;
    }

    if (!beforeDoc || !afterDoc) continue;

    if (JSON.stringify(beforeDoc) !== JSON.stringify(afterDoc)) {
      changes.push({
        docId: afterDoc.id,
        key: afterDoc.key,
        title: afterDoc.title,
        changeType: 'updated',
        visibility: afterDoc.visibility,
        priority: afterDoc.priority,
        before: beforeDoc,
        after: afterDoc,
        summary: textBlocks(summarizeActorDoc(afterDoc, 200) || `${afterDoc.title} updated.`),
      });
    }
  }

  return changes.sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.title.localeCompare(right.title);
  });
}

function computeVersionDelta(
  previous: ActorDefinition,
  next: ActorDefinition,
  fromVersion: number,
  toVersion: number,
): ActorVersionDelta | undefined {
  const changedFields = computeFieldChanges(previous, next);
  const changedDocs = computeDocChanges(previous.docs, next.docs);

  if (changedFields.length === 0 && changedDocs.length === 0) {
    return undefined;
  }

  const fragments: string[] = [`Actor profile updated from v${fromVersion} to v${toVersion}.`];
  if (changedFields.length > 0) {
    fragments.push(`Fields changed: ${changedFields.join(', ')}.`);
  }
  if (changedDocs.length > 0) {
    fragments.push(`Docs changed: ${changedDocs.map((change) => change.title).join(', ')}.`);
  }

  return {
    fromVersion,
    toVersion,
    changedFields,
    changedDocs,
    summary: textBlocks(fragments.join(' ')),
  };
}

function deriveTemplateLinkStatus(hasLocalChanges: boolean, hasUpstreamUpdate: boolean): ActorTemplateLinkStatus {
  if (hasLocalChanges && hasUpstreamUpdate) return 'update_available_with_local_changes';
  if (hasUpstreamUpdate) return 'update_available';
  if (hasLocalChanges) return 'diverged';
  return 'up_to_date';
}

function mapTemplateLink(row: any): ActorTemplateLink | undefined {
  if (!row.template_package_id) return undefined;

  const baselineActorVersion = Number(row.template_baseline_actor_version || 1);
  const currentVersion = Number(row.current_version || 1);
  const importedRevisionId = row.template_imported_revision_id;
  const latestRevisionId = row.template_latest_revision_id || undefined;
  const hasLocalChanges = currentVersion > baselineActorVersion;
  const hasUpstreamUpdate = Boolean(latestRevisionId && importedRevisionId && latestRevisionId !== importedRevisionId);

  return {
    actorId: row.id,
    templatePackageId: row.template_package_id,
    importedRevisionId,
    templateSlug: row.template_slug,
    templateDisplayName: row.template_display_name,
    templatePublisherSlug: row.template_publisher_slug || undefined,
    templatePublisherDisplayName: row.template_publisher_display_name || undefined,
    importedTemplateVersion: row.template_imported_revision_version || undefined,
    latestRevisionId,
    latestTemplateVersion: row.template_latest_revision_version || undefined,
    baselineActorVersion,
    syncMode: (row.template_sync_mode || 'notify') as ActorTemplateSyncMode,
    hasLocalChanges,
    hasUpstreamUpdate,
    status: deriveTemplateLinkStatus(hasLocalChanges, hasUpstreamUpdate),
    createdAt: row.template_link_created_at || row.created_at,
    updatedAt: row.template_link_updated_at || row.updated_at,
  };
}

function parseActorTemplateManifest(manifestValue: Record<string, unknown>): ActorTemplateRecord['manifest'] {
  const container = parseJsonObject(manifestValue.actorTemplate ?? manifestValue);
  const actorRaw = parseJsonObject(container.actor);
  const docs = normalizeActorDocs(parseJsonArray<ActorDoc>(actorRaw.docs));
  const role = isActorRole(actorRaw.role) ? actorRaw.role : 'specialist';
  const title = typeof actorRaw.title === 'string' ? actorRaw.title : '';
  const canRepresentUser = Boolean(actorRaw.canRepresentUser);

  const definition = buildDefinitionFromValues({
    name: typeof actorRaw.name === 'string' && actorRaw.name.trim().length > 0 ? actorRaw.name.trim() : 'Template Actor',
    role,
    title,
    avatarFileId: typeof actorRaw.avatarFileId === 'string' ? actorRaw.avatarFileId : undefined,
    parentId: undefined,
    canRepresentUser,
    docs,
    capabilities: parseJsonArray<string>(actorRaw.capabilities),
    config: parseJsonObject(actorRaw.config),
  });

  return {
    actor: definition,
    setupGuide: normalizeContentBlocks(container.setupGuide),
    releaseNotes: normalizeContentBlocks(container.releaseNotes),
  };
}

function mapRequirementToTemplateDependency(requirement: CapabilityRequirement): ActorTemplateDependency | undefined {
  if (requirement.targetKind !== 'package') return undefined;
  if (requirement.requirementKind !== 'required' && requirement.requirementKind !== 'recommended') return undefined;
  if (requirement.targetPackageKind !== 'plugin' && requirement.targetPackageKind !== 'skill') return undefined;
  if (!requirement.targetPackageSlug) return undefined;

  const notesFromMetadata = normalizeContentBlocks(requirement.metadata?.notes);

  return {
    requirementId: requirement.id,
    requirementKind: requirement.requirementKind,
    targetPackageKind: requirement.targetPackageKind,
    targetPublisherSlug: requirement.targetPublisherSlug,
    targetPackageSlug: requirement.targetPackageSlug,
    acceptableInstanceScopes: requirement.acceptableInstanceScopes,
    acceptableReuseScopes: requirement.acceptableReuseScopes,
    description: requirement.description,
    notes: notesFromMetadata.length > 0
      ? notesFromMetadata
      : requirement.description
        ? textBlocks(requirement.description)
        : [],
    metadata: requirement.metadata,
  };
}

async function loadActorTemplateRecord(templateId: UUID, workspaceId: UUID): Promise<ActorTemplateRecord> {
  const pkg = await getCapabilityPackage(templateId);
  if (pkg.kind !== 'actor_template') {
    throw new Error('Actor template not found');
  }
  if (pkg.workspaceId && pkg.workspaceId !== workspaceId) {
    throw new Error('Actor template not visible in this workspace');
  }
  if (!pkg.latestRevisionId || !pkg.latestRevision) {
    throw new Error('Actor template has no active revision');
  }

  const [requirements, requirementChecks] = await Promise.all([
    listRevisionRequirements(pkg.latestRevisionId),
    evaluateCapabilityRequirements({
      workspaceId,
      revisionId: pkg.latestRevisionId,
    }),
  ]);

  return {
    package: pkg,
    manifest: parseActorTemplateManifest(pkg.latestRevision.manifest),
    dependencies: requirements
      .map(mapRequirementToTemplateDependency)
      .filter((dependency): dependency is ActorTemplateDependency => Boolean(dependency)),
    requirementChecks,
  };
}

async function insertActorSnapshot(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, params: {
  actorId: UUID;
  workspaceId: UUID;
  definition: ActorDefinition;
  createdAt: string;
  currentVersion: number;
  delta?: ActorVersionDelta;
}) {
  await client.query(
    `INSERT INTO actors (
       id, workspace_id, name, role, title, avatar_file_id, can_represent_user, docs,
       parent_id, capabilities, config,
       is_active, current_version, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $13)`,
    [
      params.actorId,
      params.workspaceId,
      params.definition.name,
      params.definition.role,
      params.definition.title,
      params.definition.avatarFileId ?? null,
      params.definition.canRepresentUser,
      JSON.stringify(params.definition.docs),
      params.definition.parentId ?? null,
      params.definition.capabilities,
      JSON.stringify(params.definition.config),
      params.currentVersion,
      params.createdAt,
    ],
  );

  await client.query(
    `INSERT INTO actor_versions (
       actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs,
       config, capabilities, version_delta, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      params.actorId,
      params.currentVersion,
      params.definition.name,
      params.definition.role,
      params.definition.title,
      params.definition.avatarFileId ?? null,
      params.definition.parentId ?? null,
      params.definition.canRepresentUser,
      JSON.stringify(params.definition.docs),
      JSON.stringify(params.definition.config),
      params.definition.capabilities,
      params.delta ? JSON.stringify(params.delta) : null,
      params.createdAt,
    ],
  );
}

function mapRow(row: any): Actor {
  const definition = buildDefinitionFromRow(row);

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    definition,
    avatarUrl: row.avatar_stored_name ? getFileUrl(row.avatar_stored_name) : undefined,
    currentVersion: Number(row.current_version || 1),
    templateLink: mapTemplateLink(row),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersionRow(row: any): ActorVersion {
  const definition = buildDefinitionFromRow(row);
  const parsedDelta = row.version_delta
    ? (typeof row.version_delta === 'string' ? JSON.parse(row.version_delta) : row.version_delta)
    : undefined;

  return {
    id: row.id,
    actorId: row.actor_id,
    version: Number(row.version),
    snapshot: definition,
    delta: parsedDelta as ActorVersionDelta | undefined,
    createdAt: row.created_at,
  };
}

function mapCollabRow(row: any): ActorCollaboration {
  return {
    id: row.id,
    actorId: row.actor_id,
    collaboratorId: row.collaborator_id,
    relationship: row.relationship,
    description: row.description ?? undefined,
    createdAt: row.created_at,
  };
}

function docVisibleInConversation(doc: ActorVersionDocChange, conversationKind: 'group' | 'direct' | 'a2a_virtual'): boolean {
  const visibility = doc.after?.visibility ?? doc.before?.visibility ?? doc.visibility;
  if (visibility === 'always') return true;
  if (visibility === 'internal_only') return false;
  if (conversationKind === 'group') return visibility === 'group_only';
  return visibility === 'solo_only';
}

function filterDeltaForConversation(
  delta: ActorVersionDelta,
  conversationKind: 'group' | 'direct' | 'a2a_virtual',
): ActorVersionDelta | undefined {
  const changedDocs = delta.changedDocs.filter((doc) => docVisibleInConversation(doc, conversationKind));
  if (changedDocs.length === 0 && delta.changedFields.length === 0) {
    return undefined;
  }

  const fragments: string[] = [`Actor profile updated from v${delta.fromVersion} to v${delta.toVersion}.`];
  if (delta.changedFields.length > 0) {
    fragments.push(`Fields changed: ${delta.changedFields.join(', ')}.`);
  }
  if (changedDocs.length > 0) {
    fragments.push(`Docs changed: ${changedDocs.map((change) => change.title).join(', ')}.`);
  }

  return {
    ...delta,
    changedDocs,
    summary: textBlocks(fragments.join(' ')),
  };
}

async function emitConversationProfileChanges(params: {
  workspaceId: UUID;
  actorId: UUID;
  actorName: string;
  delta: ActorVersionDelta;
}) {
  const result = await query<{
    conversation_id: string;
    kind: 'group' | 'direct' | 'a2a_virtual';
  }>(
    `SELECT DISTINCT c.id AS conversation_id, c.kind
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.workspace_id = $1
       AND cm.actor_id = $2
       AND cm.state = 'active'`,
    [params.workspaceId, params.actorId],
  );

  for (const row of result.rows) {
    const filteredDelta = filterDeltaForConversation(params.delta, row.kind);
    if (!filteredDelta) continue;

    const created = await createConversationEvent({
      workspaceId: params.workspaceId,
      conversationId: row.conversation_id,
      eventType: 'actor_version_changed',
      timelinePolicy: 'all_members',
      contextPolicy: 'shared',
      metadata: {
        noticeType: 'actor_version_changed',
        actorId: params.actorId,
        fromVersion: filteredDelta.fromVersion,
        toVersion: filteredDelta.toVersion,
      },
      eventPayload: {
        actor: {
          memberType: 'actor',
          actorId: params.actorId,
          name: params.actorName,
        },
        fromVersion: filteredDelta.fromVersion,
        toVersion: filteredDelta.toVersion,
        changedFields: filteredDelta.changedFields,
        changedDocs: filteredDelta.changedDocs.map((change) => ({
          docId: change.docId,
          key: change.key,
          title: change.title,
          changeType: change.changeType,
          visibility: change.visibility,
          priority: change.priority,
          summaryText: extractText(change.summary).trim(),
        })),
      },
    });

    const item = await getConversationFeedItemById(created.item.id);
    if (item && item.workspaceSequence !== undefined) {
      await emitEvent({
        type: 'chat.feed.item.created',
        workspaceId: params.workspaceId,
        payload: {
          workspaceSequence: item.workspaceSequence,
          item,
        },
        timestamp: nowISO(),
      });
    }
  }
}

// ─── Actor CRUD ───

export async function createActor(params: {
  workspaceId: UUID;
  createdBy?: UUID;
  name: string;
  role: ActorRole;
  title: string;
  avatarFileId?: UUID;
  canRepresentUser?: boolean;
  docs?: ActorDocInput[];
  parentId?: UUID;
  capabilities?: string[];
  config?: Record<string, unknown>;
}): Promise<Actor> {
  const id = generateId();
  const now = nowISO();
  const definition = makeDefinitionForWrite({
    updates: {
      name: params.name,
      role: params.role,
      title: params.title,
      avatarFileId: params.avatarFileId,
      canRepresentUser: params.canRepresentUser ?? false,
      docs: params.docs,
      parentId: params.parentId,
      capabilities: params.capabilities,
      config: params.config,
    },
  });

  const authzEntryIds = await transaction(async (client) => {
    await insertActorSnapshot(client as any, {
      actorId: id,
      workspaceId: params.workspaceId,
      definition,
      createdAt: now,
      currentVersion: 1,
    });

    const grants = defaultActorGrantRows(params.workspaceId).map((grant) => ({
      ...grant,
      granted_by: params.createdBy ?? null,
    }));
    await insertActorGrantRows(client as any, id, grants);

    return queueAuthzRelationships(
      client,
      buildActorAuthzRelations(id, params.workspaceId, grants),
      {
        source: 'actor.create',
        workspaceId: params.workspaceId,
        actorId: id,
      },
    );
  });

  await flushQueuedAuthzEntries(authzEntryIds, 'actor.create');

  const actor = await getActor(id, params.workspaceId);
  if (!actor) {
    throw new Error(`Actor ${id} was created but could not be loaded`);
  }
  return actor;
}

export async function listActors(workspaceId: UUID, subject?: AuthzSubject): Promise<Actor[]> {
  if (authzEnabled() && subject) {
    const actorIds = await lookupResources({
      resourceType: 'actor',
      permission: 'discover',
      subject,
    });

    if (actorIds.length === 0) {
      return [];
    }

    const result = await query(
      `SELECT ${ACTOR_SELECT}
       ${ACTOR_JOINS}
       WHERE a.workspace_id = $1 AND a.is_active = true AND a.id = ANY($2)
       ORDER BY a.name`,
      [workspaceId, actorIds],
    );
    return result.rows.map(mapRow);
  }

  const result = await query(
    `SELECT ${ACTOR_SELECT}
     ${ACTOR_JOINS}
     WHERE a.workspace_id = $1 AND a.is_active = true
     ORDER BY a.name`,
    [workspaceId],
  );
  return result.rows.map(mapRow);
}

export async function getActor(actorId: UUID, workspaceId: UUID): Promise<Actor | null> {
  const result = await query(
    `SELECT ${ACTOR_SELECT}
     ${ACTOR_JOINS}
     WHERE a.id = $1 AND a.workspace_id = $2`,
    [actorId, workspaceId],
  );
  return result.rows.length ? mapRow(result.rows[0]) : null;
}

export async function listActorVersions(actorId: UUID, workspaceId: UUID): Promise<ActorVersion[]> {
  const result = await query(
    `SELECT av.*
     FROM actor_versions av
     JOIN actors a ON a.id = av.actor_id
     WHERE av.actor_id = $1 AND a.workspace_id = $2
     ORDER BY av.version DESC`,
    [actorId, workspaceId],
  );
  return result.rows.map(mapVersionRow);
}

export async function listActorGrants(actorId: UUID, workspaceId: UUID) {
  const grants = await listActorGrantRows(actorId, workspaceId);
  return grants.map(mapActorGrantRow);
}

export async function issueActorGrant(params: {
  actorId: UUID;
  workspaceId: UUID;
  permission: ActorGrantPermission;
  grantScope: ActorGrantScope;
  userId?: UUID;
  conversationId?: UUID;
  actorSubjectId?: UUID;
  grantedBy?: UUID;
  reason?: string;
  metadata?: Record<string, unknown>;
}) {
  await assertActorInWorkspace(params.actorId, params.workspaceId);

  if ((params.grantScope === 'user' || params.grantScope === 'workspace_user') && params.userId) {
    await assertUserExists(params.userId);
  }
  if (params.grantScope === 'workspace_user' && params.userId) {
    await assertWorkspaceMember(params.userId, params.workspaceId);
  }
  if (params.grantScope === 'conversation' && params.conversationId) {
    await assertConversationInWorkspace(params.conversationId, params.workspaceId);
  }
  if (params.grantScope === 'actor' && params.actorSubjectId) {
    await assertActorInWorkspace(params.actorSubjectId, params.workspaceId);
  }

  const result = await transaction(async (client) => {
    const previousActiveResult = await client.query<ActorGrantRow>(
      `SELECT *
       FROM actor_grants
       WHERE actor_id = $1
         AND status = 'active'
         AND (workspace_id = $2 OR workspace_id IS NULL)`,
      [params.actorId, params.workspaceId],
    );
    const previousActive = previousActiveResult.rows;

    const existingResult = await client.query<ActorGrantRow & { id: string; actor_id: string; created_at: string; revoked_at: string | null }>(
      `SELECT *
       FROM actor_grants
       WHERE actor_id = $1
         AND permission = $2
         AND grant_scope = $3
         AND COALESCE(workspace_id::text, '') = COALESCE($4::text, '')
         AND COALESCE(user_id::text, '') = COALESCE($5::text, '')
         AND COALESCE(conversation_id::text, '') = COALESCE($6::text, '')
         AND COALESCE(actor_subject_id::text, '') = COALESCE($7::text, '')
         AND status = 'active'
       LIMIT 1`,
      [
        params.actorId,
        params.permission,
        params.grantScope,
        params.grantScope === 'workspace' || params.grantScope === 'workspace_user' || params.grantScope === 'conversation' || params.grantScope === 'actor'
          ? params.workspaceId
          : null,
        params.userId ?? null,
        params.conversationId ?? null,
        params.actorSubjectId ?? null,
      ],
    );

    if (existingResult.rows[0]) {
      return {
        grant: existingResult.rows[0],
        authzEntryIds: [] as string[],
      };
    }

    const insertResult = await client.query<ActorGrantRow & { id: string; actor_id: string; created_at: string; revoked_at: string | null }>(
      `INSERT INTO actor_grants (
         actor_id,
         permission,
         grant_scope,
         workspace_id,
         user_id,
         conversation_id,
         actor_subject_id,
         status,
         granted_by,
         reason,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10::jsonb)
       RETURNING *`,
      [
        params.actorId,
        params.permission,
        params.grantScope,
        params.grantScope === 'workspace' || params.grantScope === 'workspace_user' || params.grantScope === 'conversation' || params.grantScope === 'actor'
          ? params.workspaceId
          : null,
        params.userId ?? null,
        params.conversationId ?? null,
        params.actorSubjectId ?? null,
        params.grantedBy ?? null,
        params.reason ?? null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );

    const nextActive = [...previousActive, insertResult.rows[0]];
    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildActorAuthzRelations(params.actorId, params.workspaceId, previousActive),
        buildActorAuthzRelations(params.actorId, params.workspaceId, nextActive),
      ),
      {
        source: 'actor.issue_grant',
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        permission: params.permission,
      },
    );

    return {
      grant: insertResult.rows[0],
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, 'actor.issue_grant');
  return mapActorGrantRow(result.grant);
}

export async function revokeActorGrant(params: {
  actorId: UUID;
  workspaceId: UUID;
  grantId: UUID;
}) {
  const result = await transaction(async (client) => {
    const previousActiveResult = await client.query<ActorGrantRow>(
      `SELECT *
       FROM actor_grants
       WHERE actor_id = $1
         AND status = 'active'
         AND (workspace_id = $2 OR workspace_id IS NULL)`,
      [params.actorId, params.workspaceId],
    );
    const previousActive = previousActiveResult.rows;

    const revokeResult = await client.query<ActorGrantRow & { id: string; actor_id: string; created_at: string; revoked_at: string | null }>(
      `UPDATE actor_grants
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1
         AND actor_id = $2
         AND (workspace_id = $3 OR workspace_id IS NULL)
         AND status = 'active'
       RETURNING *`,
      [params.grantId, params.actorId, params.workspaceId],
    );

    const revoked = revokeResult.rows[0];
    if (!revoked) {
      return null;
    }

    const nextActive = previousActive.filter((grant) => grant.id !== params.grantId);
    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildActorAuthzRelations(params.actorId, params.workspaceId, previousActive),
        buildActorAuthzRelations(params.actorId, params.workspaceId, nextActive),
      ),
      {
        source: 'actor.revoke_grant',
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        grantId: params.grantId,
      },
    );

    return {
      grant: revoked,
      authzEntryIds,
    };
  });

  if (!result) {
    return null;
  }

  await flushQueuedAuthzEntries(result.authzEntryIds, 'actor.revoke_grant');
  return mapActorGrantRow(result.grant);
}

export async function updateActor(
  actorId: UUID,
  workspaceId: UUID,
  updates: ActorUpdateInput,
): Promise<Actor | null> {
  const now = nowISO();

  const outcome = await transaction(async (client) => {
    const existingResult = await client.query(
      `SELECT *
       FROM actors
       WHERE id = $1 AND workspace_id = $2
       FOR UPDATE`,
      [actorId, workspaceId],
    );

    if (existingResult.rows.length === 0) {
      return null;
    }

    const existingRow = existingResult.rows[0];
    const previousDefinition = buildDefinitionFromRow(existingRow);
    const nextDefinition = makeDefinitionForWrite({
      existingRow,
      updates,
    });

    if (definitionsEqual(previousDefinition, nextDefinition)) {
      return {
        actorId,
        actorName: previousDefinition.name,
        nextVersion: Number(existingRow.current_version || 1),
        delta: undefined,
      };
    }

    const nextVersion = Number(existingRow.current_version || 1) + 1;
    const delta = computeVersionDelta(
      previousDefinition,
      nextDefinition,
      Number(existingRow.current_version || 1),
      nextVersion,
    );

    await client.query(
      `UPDATE actors
       SET name = $1,
           role = $2,
           title = $3,
           avatar_file_id = $4,
           can_represent_user = $5,
           docs = $6,
           parent_id = $7,
           capabilities = $8,
           config = $9,
           current_version = $10,
           updated_at = $11
       WHERE id = $12 AND workspace_id = $13`,
      [
        nextDefinition.name,
        nextDefinition.role,
        nextDefinition.title,
        nextDefinition.avatarFileId ?? null,
        nextDefinition.canRepresentUser,
        JSON.stringify(nextDefinition.docs),
        nextDefinition.parentId ?? null,
        nextDefinition.capabilities,
        JSON.stringify(nextDefinition.config),
        nextVersion,
        now,
        actorId,
        workspaceId,
      ],
    );

    await client.query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs,
         config, capabilities, version_delta, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        actorId,
        nextVersion,
        nextDefinition.name,
        nextDefinition.role,
        nextDefinition.title,
        nextDefinition.avatarFileId ?? null,
        nextDefinition.parentId ?? null,
        nextDefinition.canRepresentUser,
        JSON.stringify(nextDefinition.docs),
        JSON.stringify(nextDefinition.config),
        nextDefinition.capabilities,
        delta ? JSON.stringify(delta) : null,
        now,
      ],
    );

    return {
      actorId,
      actorName: nextDefinition.name,
      nextVersion,
      delta,
      avatarFileId: nextDefinition.avatarFileId,
      avatarEmoji: typeof nextDefinition.config.avatar_emoji === 'string'
        ? nextDefinition.config.avatar_emoji
        : undefined,
    };
  });

  if (!outcome) return null;

  if (outcome.delta) {
    let avatarUrl: string | undefined;
    if (outcome.avatarFileId) {
      const avatarFile = await query(
        `SELECT stored_name
         FROM files
         WHERE id = $1
         LIMIT 1`,
        [outcome.avatarFileId],
      );
      const storedName = avatarFile.rows[0]?.stored_name as string | undefined;
      if (storedName) {
        avatarUrl = getFileUrl(storedName);
      }
    }
    try {
      await emitConversationProfileChanges({
        workspaceId,
        actorId: outcome.actorId,
        actorName: outcome.actorName,
        delta: outcome.delta,
      });
    } catch (error) {
      console.error('[organization.updateActor] Failed to emit conversation profile changes:', error);
    }

    try {
      await emitEvent({
        type: 'actor.version_changed',
        workspaceId,
        payload: {
          actorId: outcome.actorId,
          name: outcome.actorName,
          avatarUrl,
          avatarEmoji: outcome.avatarEmoji,
          currentVersion: outcome.nextVersion,
          delta: {
            ...outcome.delta,
            summaryText: extractText(outcome.delta.summary).trim(),
            changedDocs: outcome.delta.changedDocs.map((change) => ({
              ...change,
              summaryText: extractText(change.summary).trim(),
            })),
          },
        },
        timestamp: nowISO(),
      });
    } catch (error) {
      console.error('[organization.updateActor] Failed to emit actor.version_changed event:', error);
    }
  }

  return getActor(actorId, workspaceId);
}

export async function deleteActor(actorId: UUID, workspaceId: UUID): Promise<boolean> {
  const result = await transaction(async (client) => {
    const grantResult = await client.query<ActorGrantRow>(
      `SELECT *
       FROM actor_grants
       WHERE actor_id = $1
         AND status = 'active'
         AND (workspace_id = $2 OR workspace_id IS NULL)`,
      [actorId, workspaceId],
    );

    const actorResult = await client.query(
      `UPDATE actors SET is_active = false, updated_at = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id`,
      [nowISO(), actorId, workspaceId],
    );

    if ((actorResult.rowCount ?? 0) === 0) {
      return null;
    }

    const authzEntryIds = await queueAuthzRelationships(
      client,
      diffAuthzRelationships(
        buildActorAuthzRelations(actorId, workspaceId, grantResult.rows),
        [],
      ),
      {
        source: 'actor.delete',
        workspaceId,
        actorId,
      },
    );

    return {
      deleted: true,
      authzEntryIds,
    };
  });

  if (!result) {
    return false;
  }

  await flushQueuedAuthzEntries(result.authzEntryIds, 'actor.delete');
  return result.deleted;
}

// ─── Org Tree ───

export async function getChildren(actorId: UUID, workspaceId: UUID): Promise<Actor[]> {
  const result = await query(
    `SELECT ${ACTOR_SELECT}
     ${ACTOR_JOINS}
     WHERE a.parent_id = $1 AND a.workspace_id = $2 AND a.is_active = true
     ORDER BY a.name`,
    [actorId, workspaceId],
  );
  return result.rows.map(mapRow);
}

export async function getSubtree(actorId: UUID): Promise<(Actor & { depth: number })[]> {
  const result = await query(
    `WITH RECURSIVE tree AS (
       SELECT *, 0 AS depth FROM actors WHERE id = $1
       UNION ALL
       SELECT a.*, t.depth + 1 FROM actors a JOIN tree t ON a.parent_id = t.id
     )
     SELECT
       tree.*,
       avatar_file.stored_name AS avatar_stored_name,
       atl.template_package_id,
       atl.imported_revision_id AS template_imported_revision_id,
       atl.baseline_actor_version AS template_baseline_actor_version,
       atl.sync_mode AS template_sync_mode,
       atl.created_at AS template_link_created_at,
       atl.updated_at AS template_link_updated_at,
       template_pkg.slug AS template_slug,
       template_pkg.display_name AS template_display_name,
       template_pkg.latest_revision_id AS template_latest_revision_id,
       template_publisher.slug AS template_publisher_slug,
       template_publisher.display_name AS template_publisher_display_name,
       imported_template_revision.version AS template_imported_revision_version,
       latest_template_revision.version AS template_latest_revision_version
     FROM tree
     LEFT JOIN files avatar_file ON avatar_file.id = tree.avatar_file_id
     LEFT JOIN actor_template_links atl ON atl.actor_id = tree.id
     LEFT JOIN capability_packages template_pkg ON template_pkg.id = atl.template_package_id
     LEFT JOIN capability_publishers template_publisher ON template_publisher.id = template_pkg.publisher_id
     LEFT JOIN capability_package_revisions imported_template_revision ON imported_template_revision.id = atl.imported_revision_id
     LEFT JOIN capability_package_revisions latest_template_revision ON latest_template_revision.id = template_pkg.latest_revision_id
     WHERE tree.is_active = true
     ORDER BY tree.depth, tree.name`,
    [actorId],
  );
  return result.rows.map((row) => ({ ...mapRow(row), depth: Number(row.depth) }));
}

export async function getFullOrgTree(workspaceId: UUID): Promise<(Actor & { depth: number })[]> {
  const result = await query(
    `WITH RECURSIVE tree AS (
       SELECT *, 0 AS depth FROM actors WHERE workspace_id = $1 AND parent_id IS NULL
       UNION ALL
       SELECT a.*, t.depth + 1 FROM actors a JOIN tree t ON a.parent_id = t.id WHERE a.workspace_id = $1
     )
     SELECT
       tree.*,
       avatar_file.stored_name AS avatar_stored_name,
       atl.template_package_id,
       atl.imported_revision_id AS template_imported_revision_id,
       atl.baseline_actor_version AS template_baseline_actor_version,
       atl.sync_mode AS template_sync_mode,
       atl.created_at AS template_link_created_at,
       atl.updated_at AS template_link_updated_at,
       template_pkg.slug AS template_slug,
       template_pkg.display_name AS template_display_name,
       template_pkg.latest_revision_id AS template_latest_revision_id,
       template_publisher.slug AS template_publisher_slug,
       template_publisher.display_name AS template_publisher_display_name,
       imported_template_revision.version AS template_imported_revision_version,
       latest_template_revision.version AS template_latest_revision_version
     FROM tree
     LEFT JOIN files avatar_file ON avatar_file.id = tree.avatar_file_id
     LEFT JOIN actor_template_links atl ON atl.actor_id = tree.id
     LEFT JOIN capability_packages template_pkg ON template_pkg.id = atl.template_package_id
     LEFT JOIN capability_publishers template_publisher ON template_publisher.id = template_pkg.publisher_id
     LEFT JOIN capability_package_revisions imported_template_revision ON imported_template_revision.id = atl.imported_revision_id
     LEFT JOIN capability_package_revisions latest_template_revision ON latest_template_revision.id = template_pkg.latest_revision_id
     WHERE tree.is_active = true
     ORDER BY tree.depth, tree.name`,
    [workspaceId],
  );
  return result.rows.map((row) => ({ ...mapRow(row), depth: Number(row.depth) }));
}

// ─── Actor Templates ───

export async function listActorTemplates(params: {
  workspaceId: UUID;
  search?: string;
}): Promise<ActorTemplateRecord[]> {
  const packages = await listCapabilityPackages({
    workspaceId: params.workspaceId,
    includeGlobal: true,
    kind: 'actor_template',
    search: params.search?.trim() || undefined,
  });

  return Promise.all(packages.map(async (pkg) => {
    if (!pkg.latestRevisionId) {
      throw new Error(`Actor template ${pkg.id} has no active revision`);
    }
    return loadActorTemplateRecord(pkg.id, params.workspaceId);
  }));
}

export async function getActorTemplate(templateId: UUID, workspaceId: UUID): Promise<ActorTemplateRecord> {
  return loadActorTemplateRecord(templateId, workspaceId);
}

export async function cloneActorTemplate(input: ActorTemplateCloneInput): Promise<ActorTemplateCloneResult> {
  const now = nowISO();
  const actorId = generateId();
  const template = await loadActorTemplateRecord(input.templateId, input.workspaceId);
  const actorFromTemplate = template.manifest.actor;

  const definition = makeDefinitionForWrite({
    updates: {
      name: input.name ?? actorFromTemplate.name,
      role: actorFromTemplate.role,
      title: input.title ?? actorFromTemplate.title,
      avatarFileId: actorFromTemplate.avatarFileId,
      canRepresentUser: actorFromTemplate.canRepresentUser,
      docs: actorFromTemplate.docs,
      parentId: input.parentId ?? undefined,
      capabilities: actorFromTemplate.capabilities,
      config: actorFromTemplate.config,
    },
  });

  const authzEntryIds = await transaction(async (client) => {
    await insertActorSnapshot(client as any, {
      actorId,
      workspaceId: input.workspaceId,
      definition,
      createdAt: now,
      currentVersion: 1,
    });

    await client.query(
      `INSERT INTO actor_template_links (
         actor_id, template_package_id, imported_revision_id, baseline_actor_version, sync_mode, created_at, updated_at
       )
       VALUES ($1, $2, $3, 1, $4, $5, $5)`,
      [
        actorId,
        template.package.id,
        template.package.latestRevisionId,
        input.syncMode || 'notify',
        now,
      ],
    );

    await client.query(
      `UPDATE capability_packages
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [template.package.id],
    );

    const grants = defaultActorGrantRows(input.workspaceId).map((grant) => ({
      ...grant,
      granted_by: input.createdBy ?? null,
    }));
    await insertActorGrantRows(client as any, actorId, grants);

    return queueAuthzRelationships(
      client,
      buildActorAuthzRelations(actorId, input.workspaceId, grants),
      {
        source: 'actor.clone_template',
        workspaceId: input.workspaceId,
        actorId,
        templateId: input.templateId,
      },
    );
  });

  await flushQueuedAuthzEntries(authzEntryIds, 'actor.clone_template');

  const actor = await getActor(actorId, input.workspaceId);
  if (!actor || !actor.templateLink) {
    throw new Error('Template clone succeeded but actor link could not be loaded');
  }

  return {
    actor,
    template,
    templateLink: actor.templateLink,
    requirementChecks: template.requirementChecks || [],
  };
}

export async function seedBuiltinActorTemplates() {
  const publisher = await createCapabilityPublisher({
    slug: 'synapse-official',
    displayName: 'Synapse Official',
    description: 'Official Synapse marketplace templates and packages.',
    isBuiltin: true,
    isVerified: true,
  });

  for (const seed of builtinActorTemplateSeeds) {
    const pkg = await createCapabilityPackage({
      publisherId: publisher.id,
      kind: 'actor_template',
      slug: seed.slug,
      displayName: seed.displayName,
      description: seed.description,
      longDescription: seed.longDescription,
      sourceType: 'official',
      tags: seed.tags,
      isBuiltin: true,
      isActive: true,
      defaultInstanceScope: 'workspace',
      defaultReuseScope: 'workspace',
      metadata: {
        seededBy: 'builtin_actor_templates',
      },
    });

    const revision = await createCapabilityRevision({
      packageId: pkg.id,
      version: '1.0.0',
      status: 'active',
      manifest: {
        kind: 'actor_template',
        actorTemplate: {
          actor: seed.actor,
          setupGuide: seed.setupGuide || [],
          releaseNotes: seed.releaseNotes || [],
        },
      },
      metadata: {
        kind: 'actor_template',
        seededBy: 'builtin_actor_templates',
      },
      setLatest: true,
    });

    await replaceRevisionRequirements(
      revision.id,
      seed.dependencies.map((dependency) => ({
        requirementKind: dependency.requirementKind,
        targetKind: 'package' as const,
        targetPackageKind: dependency.targetPackageKind,
        targetPublisherSlug: dependency.targetPublisherSlug,
        targetPackageSlug: dependency.targetPackageSlug,
        acceptableInstanceScopes: dependency.acceptableInstanceScopes,
        acceptableReuseScopes: dependency.acceptableReuseScopes,
        description: dependency.description,
        metadata: {
          ...(dependency.metadata || {}),
          notes: dependency.notes || [],
        },
      })),
    );
  }
}

// ─── Collaborations ───

export async function addCollaboration(params: {
  actorId: UUID;
  collaboratorId: UUID;
  relationship: string;
  description?: string;
}): Promise<ActorCollaboration> {
  const id = generateId();
  const now = nowISO();

  const result = await query(
    `INSERT INTO actor_collaborations (id, actor_id, collaborator_id, relationship, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, params.actorId, params.collaboratorId, params.relationship, params.description ?? null, now],
  );

  return mapCollabRow(result.rows[0]);
}

export async function getCollaborations(actorId: UUID): Promise<ActorCollaboration[]> {
  const result = await query(
    `SELECT *
     FROM actor_collaborations
     WHERE actor_id = $1 OR collaborator_id = $1
     ORDER BY created_at`,
    [actorId],
  );
  return result.rows.map(mapCollabRow);
}
