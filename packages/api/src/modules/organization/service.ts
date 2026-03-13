import { getFileUrl } from '../../infrastructure/storage/index.js';
import { query, transaction } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { createConversationEvent } from '../conversation/service.js';
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
    acceptableBindingScopes: requirement.acceptableBindingScopes,
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

    await createConversationEvent({
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
        actorId: params.actorId,
        actorName: params.actorName,
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
        summaryText: extractText(filteredDelta.summary).trim(),
      },
    });
  }
}

// ─── Actor CRUD ───

export async function createActor(params: {
  workspaceId: UUID;
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

  await transaction(async (client) => {
    await insertActorSnapshot(client as any, {
      actorId: id,
      workspaceId: params.workspaceId,
      definition,
      createdAt: now,
      currentVersion: 1,
    });
  });

  const actor = await getActor(id, params.workspaceId);
  if (!actor) {
    throw new Error(`Actor ${id} was created but could not be loaded`);
  }
  return actor;
}

export async function listActors(workspaceId: UUID): Promise<Actor[]> {
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
    };
  });

  if (!outcome) return null;

  if (outcome.delta) {
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
  const result = await query(
    `UPDATE actors SET is_active = false, updated_at = $1 WHERE id = $2 AND workspace_id = $3 RETURNING id`,
    [nowISO(), actorId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
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

  await transaction(async (client) => {
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
  });

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
      defaultBindingScope: 'workspace',
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
        acceptableBindingScopes: dependency.acceptableBindingScopes,
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
