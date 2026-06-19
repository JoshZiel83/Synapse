import deepEqual from "fast-deep-equal"
import {
  extractText,
  GROUP_CONVERSATION_KIND,
  normalizeActorDocs,
  summarizeActorDoc,
  textBlocks,
  ACTOR_DOC_CHANGED_FIELD,
  ACTOR_PACKAGE_SYNC_MODE,
  ACTOR_VERSION_CHANGED_FIELD,
  ACTOR_VERSION_DOC_CHANGE_TYPE,
  type Actor,
  type CapabilityAccessTarget,
  type ActorDefinition,
  type ActorDoc,
  type ActorDocInput,
  type ActorPackageInstallResult,
  type ActorPackageRecord,
  type ActorPackageSyncMode,
  type ActorRole,
  type ActorVersionChange,
  type ActorVersionSource,
  type ActorVersionChangedField,
  type ActorDocFieldChange,
  type ActorVersionDelta,
  type ActorVersionDocChange,
  type ActorUpdateSourceType,
  type UUID,
  type WorkspaceResourceGrantPermission,
} from "@synapse/shared"
import { createConversationEvent } from "../chat/event-write.js"
import { presentActorPackageRecord, presentActorRow } from "./presenter.js"
import { sanitizeSpecialties, sortDocs } from "./doc-codec.js"
import type {
  ActorPackageRow,
  ActorRow,
  ActorVersionRecord,
  ActorVersionRow,
} from "./repo.types.js"
export type {
  ActorPackageRow,
  ActorRow,
  ActorVersionRecord,
  ActorVersionRow,
} from "./repo.types.js"
import { type AccessSubject } from "../access/service.js"
import {
  actorExists,
  createActorTx,
  deleteActorTx,
  getActorPackageRow,
  getActorRow,
  getActorRowsByIds,
  installActorPackageTx,
  listActorPackageRows,
  listActorVersionRows,
  listAuthorizedActorIds,
  loadActorDocsMap,
  updateActorAvatar,
  updateActorTx,
} from "./repo.js"

export interface ActorUpdateSourceInput {
  type: ActorUpdateSourceType
  workspaceMemberId?: UUID
  actorId?: UUID
  sessionId?: UUID
  turnId?: UUID
  conversationId?: UUID
  reason?: string
}

type ActorTreeNode = Actor & {
  children: ActorTreeNode[]
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function jsonEqual(left: unknown, right: unknown) {
  return deepEqual(left ?? {}, right ?? {})
}

function normalizeAvatarEmoji(value?: string | null) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function buildActorVersionSource(
  source?: ActorUpdateSourceInput | null
): ActorVersionSource | undefined {
  if (!source) return undefined
  return {
    type: source.type,
    workspaceMemberId: source.workspaceMemberId || undefined,
    actorId: source.actorId || undefined,
    sessionId: source.sessionId || undefined,
    turnId: source.turnId || undefined,
    conversationId: source.conversationId || undefined,
    reason: source.reason || undefined,
  }
}

function summarizeUnknownValue(value: unknown): string {
  if (value === null || value === undefined) return "empty"
  if (typeof value === "string") return value.trim() || "empty"
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty"
    return value.map((entry) => summarizeUnknownValue(entry)).join(", ")
  }
  try {
    return JSON.stringify(value)
  } catch {
    return "updated"
  }
}

function buildFieldSummary(
  field: ActorVersionChangedField,
  before: unknown,
  after: unknown
) {
  return textBlocks(
    `${field} changed from "${summarizeUnknownValue(before)}" to "${summarizeUnknownValue(after)}".`
  )
}

function buildFieldChange(
  field: ActorVersionChangedField,
  before: unknown,
  after: unknown
): ActorVersionChange {
  return {
    kind: "field",
    field,
    before,
    after,
    summary: buildFieldSummary(field, before, after),
  }
}

function buildDocFieldChanges(
  beforeDoc: ActorDoc | undefined,
  afterDoc: ActorDoc | undefined
): ActorDocFieldChange[] {
  const changes: ActorDocFieldChange[] = []

  if (!beforeDoc || !afterDoc) {
    return changes
  }

  if (beforeDoc.title !== afterDoc.title) {
    changes.push({
      field: ACTOR_DOC_CHANGED_FIELD.TITLE,
      before: beforeDoc.title,
      after: afterDoc.title,
    })
  }
  if (beforeDoc.visibility !== afterDoc.visibility) {
    changes.push({
      field: ACTOR_DOC_CHANGED_FIELD.VISIBILITY,
      before: beforeDoc.visibility,
      after: afterDoc.visibility,
    })
  }
  if (beforeDoc.priority !== afterDoc.priority) {
    changes.push({
      field: ACTOR_DOC_CHANGED_FIELD.PRIORITY,
      before: beforeDoc.priority,
      after: afterDoc.priority,
    })
  }
  if (!jsonEqual(beforeDoc.content, afterDoc.content)) {
    changes.push({
      field: ACTOR_DOC_CHANGED_FIELD.CONTENT,
      beforeSummaryText: summarizeActorDoc(beforeDoc, 180),
      afterSummaryText: summarizeActorDoc(afterDoc, 180),
    })
  }

  return changes
}

function buildDocChange(
  beforeDoc: ActorDoc | undefined,
  afterDoc: ActorDoc | undefined
): ActorVersionDocChange | null {
  if (!beforeDoc && !afterDoc) return null
  const referenceDoc = afterDoc || beforeDoc!
  const changeType: ActorVersionDocChange["changeType"] =
    beforeDoc && afterDoc
      ? ACTOR_VERSION_DOC_CHANGE_TYPE.UPDATED
      : afterDoc
        ? ACTOR_VERSION_DOC_CHANGE_TYPE.ADDED
        : ACTOR_VERSION_DOC_CHANGE_TYPE.REMOVED
  const summaryText =
    summarizeActorDoc(afterDoc || beforeDoc!, 180) ||
    `${referenceDoc.title} ${changeType}`

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
  }
}

function buildActorVersionDelta(
  before: ActorDefinition,
  after: ActorDefinition,
  fromVersion: number,
  toVersion: number,
  source?: ActorUpdateSourceInput
): ActorVersionDelta | undefined {
  const changes: ActorVersionChange[] = []

  if (before.displayName !== after.displayName) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.DISPLAY_NAME,
        before.displayName,
        after.displayName
      )
    )
  }
  if (before.role !== after.role) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.ROLE,
        before.role,
        after.role
      )
    )
  }
  if (before.title !== after.title) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.TITLE,
        before.title,
        after.title
      )
    )
  }
  if ((before.parentId || null) !== (after.parentId || null)) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.PARENT_ID,
        before.parentId || null,
        after.parentId || null
      )
    )
  }
  if (before.canRepresentUser !== after.canRepresentUser) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.CAN_REPRESENT_USER,
        before.canRepresentUser,
        after.canRepresentUser
      )
    )
  }
  if (!arraysEqual(before.specialties, after.specialties)) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.SPECIALTIES,
        before.specialties,
        after.specialties
      )
    )
  }
  if (!jsonEqual(before.config, after.config)) {
    changes.push(
      buildFieldChange(
        ACTOR_VERSION_CHANGED_FIELD.CONFIG,
        before.config,
        after.config
      )
    )
  }

  const docIds = new Set([
    ...before.docs.map((doc) => doc.id),
    ...after.docs.map((doc) => doc.id),
  ])
  const beforeDocs = new Map(before.docs.map((doc) => [doc.id, doc]))
  const afterDocs = new Map(after.docs.map((doc) => [doc.id, doc]))
  const docChanges = Array.from(docIds)
    .map((docId) => {
      const beforeDoc = beforeDocs.get(docId)
      const afterDoc = afterDocs.get(docId)
      if (beforeDoc && afterDoc) {
        const unchanged =
          beforeDoc.key === afterDoc.key &&
          beforeDoc.title === afterDoc.title &&
          beforeDoc.visibility === afterDoc.visibility &&
          beforeDoc.priority === afterDoc.priority &&
          jsonEqual(beforeDoc.content, afterDoc.content)
        if (unchanged) return null
      }
      return buildDocChange(beforeDoc, afterDoc)
    })
    .filter((value): value is ActorVersionDocChange => Boolean(value))

  changes.push(...docChanges)

  if (changes.length === 0) {
    return undefined
  }

  return {
    fromVersion,
    toVersion,
    source: buildActorVersionSource(source),
    changes,
    summary: changes.flatMap((change) => change.summary),
  }
}

async function buildActorResponseFromRows(rows: ActorRow[]) {
  if (rows.length === 0) return []
  const docsByVersionId = await loadActorDocsMap(
    rows.map((row) => row.currentActorVersionId)
  )
  return rows.map((row) =>
    presentActorRow(row, docsByVersionId.get(row.currentActorVersionId) || [])
  )
}

export async function listActors(
  workspaceId: UUID,
  subject: AccessSubject
): Promise<Actor[]> {
  const actorIds = await listAuthorizedActorIds(subject, "actor.view")
  const rows = await getActorRowsByIds(workspaceId, actorIds)
  return buildActorResponseFromRows(rows)
}

export async function getFullOrgTree(
  workspaceId: UUID,
  subject: AccessSubject
): Promise<ActorTreeNode[]> {
  const actors = await listActors(workspaceId, subject)
  const nodes = new Map<string, ActorTreeNode>(
    actors.map((actor) => [actor.id, { ...actor, children: [] }])
  )
  const roots: ActorTreeNode[] = []

  for (const actor of nodes.values()) {
    const parentId = actor.definition.parentId
    if (parentId && nodes.has(parentId)) {
      nodes.get(parentId)!.children.push(actor)
      continue
    }
    roots.push(actor)
  }

  return roots
}

export async function getActor(
  actorId: UUID,
  workspaceId: UUID
): Promise<Actor | null> {
  const row = await getActorRow(workspaceId, actorId)
  if (!row) return null
  const docsByVersionId = await loadActorDocsMap([row.currentActorVersionId])
  return presentActorRow(
    row,
    docsByVersionId.get(row.currentActorVersionId) || []
  )
}

export async function listActorVersions(
  actorId: UUID,
  workspaceId: UUID
): Promise<ActorVersionRecord[]> {
  const exists = await actorExists(workspaceId, actorId)
  if (!exists) return []

  const rows = await listActorVersionRows(actorId)

  const docsByVersionId = await loadActorDocsMap(rows.map((row) => row.id))

  return rows.map((row) => ({
    row,
    docs: docsByVersionId.get(row.id) || [],
  }))
}

export async function createActor(input: {
  workspaceId: UUID
  createdByWorkspaceMemberId?: UUID
  displayName: string
  role: ActorRole
  title?: string
  avatarFileId?: UUID
  avatarEmoji?: string
  canRepresentUser?: boolean
  docs?: ActorDocInput[]
  parentId?: UUID
  specialties?: string[]
  config?: Record<string, unknown>
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<Actor> {
  if (input.avatarFileId && normalizeAvatarEmoji(input.avatarEmoji)) {
    throw new Error("avatarFileId and avatarEmoji are mutually exclusive")
  }

  const docs = sortDocs(normalizeActorDocs(input.docs || []))
  const specialties = sanitizeSpecialties(input.specialties)

  const result = await createActorTx({
    workspaceId: input.workspaceId,
    createdByWorkspaceMemberId: input.createdByWorkspaceMemberId,
    displayName: input.displayName,
    role: input.role,
    title: input.title,
    avatarFileId: input.avatarFileId,
    avatarEmoji: normalizeAvatarEmoji(input.avatarEmoji) || null,
    canRepresentUser: input.canRepresentUser,
    parentId: input.parentId,
    specialties,
    config: input.config,
    docs,
    grants: input.grants,
  })

  const actor = await getActor(result.actorId, input.workspaceId)
  if (!actor) {
    throw new Error("Failed to create actor")
  }
  return actor
}

export async function updateActor(
  actorId: UUID,
  workspaceId: UUID,
  updates: Partial<{
    displayName: string
    role: ActorRole
    title: string
    avatarFileId: UUID | null
    avatarEmoji: string | null
    canRepresentUser: boolean
    docs: ActorDocInput[]
    parentId: UUID | null
    specialties: string[]
    config: Record<string, unknown>
  }>,
  source: ActorUpdateSourceInput = { type: "system" }
): Promise<Actor | null> {
  const currentActorRow = await getActorRow(workspaceId, actorId)
  if (!currentActorRow) return null
  const currentActor = await getActor(actorId, workspaceId)
  if (!currentActor) return null

  const currentDefinition = currentActor.definition
  const nextAvatarFileId =
    updates.avatarFileId === undefined
      ? currentDefinition.avatarFileId
      : updates.avatarFileId || undefined
  const nextAvatarEmoji =
    updates.avatarEmoji === undefined
      ? currentDefinition.avatarEmoji
      : normalizeAvatarEmoji(updates.avatarEmoji)

  if (nextAvatarFileId && nextAvatarEmoji) {
    throw new Error("avatarFileId and avatarEmoji are mutually exclusive")
  }

  const nextDefinition: ActorDefinition = {
    displayName: updates.displayName ?? currentDefinition.displayName,
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
  }

  const delta = buildActorVersionDelta(
    currentDefinition,
    nextDefinition,
    currentActor.currentVersion,
    currentActor.currentVersion + 1,
    source
  )

  const avatarChanged =
    (currentDefinition.avatarFileId || null) !== (nextAvatarFileId || null) ||
    (currentDefinition.avatarEmoji || null) !== (nextAvatarEmoji || null)

  if (!delta) {
    if (avatarChanged) {
      await updateActorAvatar({
        actorId,
        workspaceId,
        avatarFileId: nextAvatarFileId || null,
        avatarEmoji: nextAvatarEmoji || null,
        displayName: nextDefinition.displayName,
      })
      return getActor(actorId, workspaceId)
    }
    return currentActor
  }

  const nextVersion = currentActor.currentVersion + 1

  await updateActorTx({
    actorId,
    workspaceId,
    nextVersion,
    previousVersionId: currentActorRow.currentActorVersionId,
    displayName: nextDefinition.displayName,
    role: nextDefinition.role,
    title: nextDefinition.title,
    avatarFileId: nextDefinition.avatarFileId || null,
    avatarEmoji: nextDefinition.avatarEmoji || null,
    parentId: nextDefinition.parentId || null,
    canRepresentUser: nextDefinition.canRepresentUser,
    specialties: sanitizeSpecialties(nextDefinition.specialties),
    config: nextDefinition.config || {},
    delta,
    docs: nextDefinition.docs,
    source,
  })

  const actor = await getActor(actorId, workspaceId)
  if (!actor) return null

  return actor
}

export async function deleteActor(
  actorId: UUID,
  workspaceId: UUID
): Promise<boolean> {
  const result = await deleteActorTx(actorId, workspaceId)
  return result.deleted
}

export async function listActorPackages(params: {
  workspaceId: UUID
  search?: string
}): Promise<ActorPackageRecord[]> {
  const rows = await listActorPackageRows(params)
  return rows.map(presentActorPackageRecord)
}

export async function getActorPackage(
  packageId: UUID,
  workspaceId: UUID
): Promise<ActorPackageRecord> {
  const row = await getActorPackageRow(packageId, workspaceId)
  if (!row) {
    throw new Error("Actor package not found")
  }

  return presentActorPackageRecord(row)
}

export async function installActorPackage(input: {
  workspaceId: UUID
  packageId: UUID
  createdByWorkspaceMemberId?: UUID
  displayName?: string
  title?: string
  parentId?: UUID | null
  syncMode?: ActorPackageSyncMode
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<ActorPackageInstallResult> {
  const actorPackage = await getActorPackage(input.packageId, input.workspaceId)
  const packageActor = actorPackage.manifest.actor
  const actorDisplayName =
    input.displayName?.trim() ||
    packageActor.displayName ||
    actorPackage.package.displayName
  const actorTitle = input.title ?? packageActor.title
  const syncMode = input.syncMode || ACTOR_PACKAGE_SYNC_MODE.NOTIFY

  const result = await installActorPackageTx({
    workspaceId: input.workspaceId,
    createdByWorkspaceMemberId: input.createdByWorkspaceMemberId,
    displayName: actorDisplayName,
    role: packageActor.role,
    title: actorTitle,
    avatarFileId: packageActor.avatarFileId || null,
    avatarEmoji: packageActor.avatarEmoji || null,
    parentId: input.parentId || null,
    canRepresentUser: packageActor.canRepresentUser,
    specialties: sanitizeSpecialties(packageActor.specialties),
    config: packageActor.config || {},
    docs: packageActor.docs,
    grants: input.grants,
    sourceCatalogItemId: actorPackage.package.id,
    sourceCatalogVersionId: actorPackage.package.latestRevisionId || null,
    syncMode,
  })

  const actor = await getActor(result.actorId, input.workspaceId)
  if (!actor) {
    throw new Error("Failed to install actor package")
  }

  return {
    actor,
    sourcePackage: actorPackage,
    sourceLink: actor.sourceLink!,
    requirementChecks: [],
  }
}
