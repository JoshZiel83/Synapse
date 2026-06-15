import crypto from "node:crypto"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  FILE_ORIGIN_SYSTEMS,
  actorRef,
  conversationRef,
  maskAllowsConversationTypeKey,
  normalizeConversationTypeMask,
  remoteAgentRef,
  resolveConversationTypeKey,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  slugify,
  subjectScopeLabel,
  workspaceMemberRef,
  workspaceRef,
  type AvailableSkillSummary,
  type CapabilityAccessTarget,
  type WorkspaceAppGrantPermission,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  normalizeCanonicalContentBlocks,
  type RuntimeBindingScope,
  type ScopedSubjectTarget,
  type SkillFrontmatter,
  type WorkspaceAppGrantTargetInput,
  textBlock,
} from "@synapse/shared"
import { ACCESS_ACTIONS } from "../access/actions.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"
import {
  insertWorkspaceAppGrant,
  listActiveWorkspaceAppGrants,
  revokeWorkspaceAppGrantsForApp,
} from "../workspace-apps/grant-storage.js"
import { type Executor } from "../../infrastructure/database/kysely.js"
import {
  withSkillsTransaction,
  clientRunner,
  ensureMarketplacePublisher,
  allocateMarketplaceItemSlug,
  upsertSkillMirrorSource,
  insertSkillSnapshot,
  insertInstalledSkillRecord,
  insertSkillVersionRecord,
  updateInstalledSkillContentState,
  updateInstalledSkillProfileState,
  updateInstalledSkillMarketplaceState,
  insertSkillSourceRefRecord,
  incrementSkillCatalogDownloadCount,
  markSkillSourceRefCustomized,
  updateSkillSourceRefVersion,
  loadSkillSnapshotFilesMap,
  buildMarketplaceInstallationMap,
  getMarketplaceRowById,
  getMarketplaceRowBySlug,
  getMarketplaceRowByMirrorSourceId,
  updateMarketplaceCatalogItemSummary,
  updateMarketplaceCatalogItemRecord,
  insertMarketplaceCatalogItemRecord,
  getCatalogVersionId,
  insertCatalogVersionRecord,
  updateCatalogVersionRecord,
  updateRepublishedCatalogVersionRecord,
  upsertSkillPackageVersionSpecRecord,
  updateCatalogItemLatestVersion,
  loadInstalledSkillRows,
  getInstalledSkillRowForWorkspace,
  loadAccessBindingsBySkillIds,
  findSkillIdsByBindingFilter as findSkillIdsByBindingFilterRepo,
  listMarketplaceRows,
  loadVisibleSkillRows,
  loadSkillSnapshotFileByPath,
  updateInstalledSkillGrantConversationTypeMaskOverride,
  revokeWorkspaceAppGrantDefault,
  validateConversationScopedAccessTargetDefault,
  buildConversationCapabilitySubjectsDefault,
  computeRuntimeScopeSubjectIdsDefault,
  computeRuntimeSubjectIdsForVisibilityDefault,
  lookupSkillResourcesDefault,
} from "./repo.js"
import {
  getWorkspaceCapabilityConversationTypeMask,
  getWorkspaceCapabilityConversationTypePolicyMap,
} from "../capabilities/conversation-type-policies.js"
import { type AutomationEventSourceBindingTarget } from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
} from "../access/policy.js"
import {
  buildSystemGeneratedOrigin,
  canUserAccessFileWorkspace,
  duplicateFileRecord,
  getFileAccessInfo,
} from "../files/service.js"
// subject-scope-refactor merge: relay-auto-skills was deleted in
// device-runtime-v3 (PR #20). Replace imports with empty stubs so the existing
// skill aggregation logic compiles; relay_auto_loaded sourceKind is dead.
async function listAutoLoadedSkills(
  _args: unknown
): Promise<AvailableSkillSummary[]> {
  return []
}
import { compareAvailableSkillDiscoveryOrder } from "./discovery-order.js"
import {
  SKILL_ENTRY_PATH,
  buildSyntheticEntryFile,
  buildSkillMarkdown,
  normalizeSkillCommandName,
  normalizeSkillFiles,
  normalizeSkillFilePath,
  renderCanonicalBlocksToText,
  type SkillFileInput,
} from "./manifest.js"
import {
  buildPreparedSnapshotFromExistingData,
  buildSyntheticSkillFilesFromSnapshot,
  importClawhubSeedSkillPackage,
  importClawhubSkillPackage,
  importGitHubSkillPackage,
  prepareSkillSnapshotFromFiles,
  type ImportedMirrorSkillPackage,
  type PreparedSkillSnapshot,
} from "./mirror-import.js"
import {
  mapMarketplaceEntry,
  presentSkillAccessGrant,
  type InstalledSkillPresentationRecord,
} from "./presenter.js"
import { normalizeStoredBlocks } from "./content-block-codec.js"
import type {
  InstallationSummary,
  InstalledSkillRow,
  SkillAccessRow,
  SkillPackageRow,
  SkillSnapshotFileRow,
  SkillSnapshotJoinRow,
  VisibleSkillRow,
} from "./repo.types.js"
export type {
  InstallationSummary,
  InstalledSkillRow,
  SkillAccessRow,
  SkillPackageRow,
  SkillSnapshotFileRow,
  SkillSnapshotJoinRow,
  VisibleSkillRow,
} from "./repo.types.js"

type SkillUseScope =
  | "workspace"
  | "workspace_member"
  | "conversation"
  | "actor"
  | "remote_agent"
type SkillAccessSuggestion =
  | SkillUseScope
  | "actor_conversation"
  | "remote_agent_conversation"

/**
 * Build a ScopedSubjectTarget from the public scope label + ids.
 */
function scopedTargetFromSkillUseScope(input: {
  useScope: SkillUseScope
  workspaceId: string
  workspaceMemberId?: string | null
  actorId?: string | null
  remoteAgentId?: string | null
  conversationId?: string | null
}): ScopedSubjectTarget {
  switch (input.useScope) {
    case "workspace":
      return { subject: workspaceRef(input.workspaceId) }
    case "workspace_member":
      if (!input.workspaceMemberId) {
        throw new SkillError(
          400,
          "workspaceMemberId is required for workspace_member scope"
        )
      }
      return { subject: workspaceMemberRef(input.workspaceMemberId) }
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(
          400,
          "conversationId is required for conversation scope"
        )
      }
      return { subject: conversationRef(input.conversationId) }
    case "actor":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor scope")
      }
      return {
        subject: actorRef(input.actorId),
        ...(input.conversationId
          ? { scope: conversationRef(input.conversationId) }
          : {}),
      }
    case "remote_agent":
      if (!input.remoteAgentId) {
        throw new SkillError(
          400,
          "remoteAgentId is required for remote_agent scope"
        )
      }
      return {
        subject: remoteAgentRef(input.remoteAgentId),
        ...(input.conversationId
          ? { scope: conversationRef(input.conversationId) }
          : {}),
      }
  }
}

/**
 * Collapse a ScopedSubjectTarget back to the public subject label.
 */
function skillUseScopeFromTarget(target: ScopedSubjectTarget): SkillUseScope {
  const label = subjectScopeLabel(target)
  switch (label) {
    case "workspace":
    case "workspace_member":
    case "conversation":
    case "actor":
    case "remote_agent":
      return label
    default:
      return "workspace"
  }
}

type JsonObject = Record<string, unknown>

type SkillAttachmentInput = {
  path: string
  contentBlocks: CanonicalContentBlockInput[]
  mediaType?: string
}

export type SkillScopeTarget = {
  bindScope: RuntimeBindingScope
  useScope: SkillUseScope
  actorId: string | null
  remoteAgentId: string | null
  // Round 11 review (P2): same fix for workspace_member — controller
  // accepts workspace_member targets, scopedTargetFromSkillUseScope
  // requires workspaceMemberId, but SkillScopeTarget previously didn't
  // carry it. ensureSkillBinding would then call
  // scopedTargetFromSkillUseScope with workspaceMemberId=undefined and
  // crash on the "workspaceMemberId is required" error — making the
  // public skill-grant flow broken for workspace_member targets.
  workspaceMemberId: string | null
  conversationId: string | null
}

const GITHUB_MARKETPLACE_PUBLISHER_SLUG = "github-mirror"
const GITHUB_MARKETPLACE_PUBLISHER_NAME = "GitHub Mirror"
const CLAWHUB_MARKETPLACE_PUBLISHER_SLUG = "clawhub-official"
const CLAWHUB_MARKETPLACE_PUBLISHER_NAME = "ClawHub Mirror"

export class SkillError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

function sanitizeSlug(value: string) {
  return slugify(value, { maxLength: 120 })
}

function normalizePath(assetPath: string) {
  try {
    return normalizeSkillFilePath(assetPath)
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message)
    }
    throw error
  }
}

function defaultDescriptionBlock(text = ""): CanonicalContentBlock {
  return textBlock(text)
}

function normalizeSkillDescription(description?: CanonicalContentBlockInput) {
  const normalized = normalizeCanonicalContentBlocks(
    description ? [description] : [defaultDescriptionBlock()]
  )

  return normalized[0] || defaultDescriptionBlock()
}

function normalizeSkillAttachments(files?: SkillAttachmentInput[]) {
  try {
    return normalizeSkillFiles(
      (files || []).map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentBlocks: Array.isArray(file.contentBlocks)
          ? file.contentBlocks
          : [],
      }))
    )
  } catch (error) {
    if (error instanceof Error) {
      throw new SkillError(400, error.message)
    }
    throw error
  }
}

function assertRequiredSkillFile(
  files: Array<{ path: string; contentBlocks: CanonicalContentBlock[] }>
) {
  if (!files.some((file) => file.path === SKILL_ENTRY_PATH)) {
    throw new SkillError(
      400,
      `Skill must include required path: ${SKILL_ENTRY_PATH}`
    )
  }
}

function normalizeScopeTarget(input: {
  useScope: SkillUseScope
  actorId?: string | null
  remoteAgentId?: string | null
  workspaceMemberId?: string | null
  conversationId?: string | null
}): SkillScopeTarget {
  switch (input.useScope) {
    case "workspace":
      return {
        bindScope: "workspace",
        useScope: "workspace",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: null,
      }
    case "workspace_member":
      // workspace_member-scoped skill bindings are individual approvals.
      // Round 11 review (P2): the intermediate SkillScopeTarget now
      // carries `workspaceMemberId` so the write path (ensureSkillBinding
      // → scopedTargetFromSkillUseScope) doesn't crash on a legitimate
      // workspace_member grant. We tolerate `input.workspaceMemberId
      // == null` here (filter-mode callers may not have it) — the
      // write-side `scopedTargetFromSkillUseScope` is still strict and
      // throws when actually building the SubjectRef.
      return {
        bindScope: "workspace_member",
        useScope: "workspace_member",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: input.workspaceMemberId ?? null,
        conversationId: null,
      }
    case "conversation":
      if (!input.conversationId) {
        throw new SkillError(
          400,
          "conversationId is required for conversation scope"
        )
      }
      return {
        bindScope: "conversation",
        useScope: "conversation",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: input.conversationId,
      }
    case "actor":
      if (!input.actorId) {
        throw new SkillError(400, "actorId is required for actor scope")
      }
      return {
        bindScope: "actor",
        useScope: "actor",
        actorId: input.actorId,
        remoteAgentId: null,
        workspaceMemberId: null,
        conversationId: input.conversationId ?? null,
      }
    case "remote_agent":
      if (!input.remoteAgentId) {
        throw new SkillError(
          400,
          "remoteAgentId is required for remote_agent scope"
        )
      }
      return {
        bindScope: "remote_agent",
        useScope: "remote_agent",
        actorId: null,
        remoteAgentId: input.remoteAgentId,
        workspaceMemberId: null,
        conversationId: input.conversationId ?? null,
      }
    default:
      throw new SkillError(
        400,
        `Unsupported skill scope: ${String(input.useScope)}`
      )
  }
}

function descriptionBlockFromStored(value: unknown) {
  return normalizeStoredBlocks(value)[0] || defaultDescriptionBlock()
}

function renderSkillBlocksToText(blocks: CanonicalContentBlock[]) {
  return renderCanonicalBlocksToText(blocks)
    .split("\n")
    .filter((chunk) => chunk.trim().length > 0)
    .join("\n")
}

async function normalizeWorkspaceSkillIconFileId(
  iconFileId: string,
  workspaceId: string
) {
  const fileInfo = await getFileAccessInfo(iconFileId)
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found")
  }

  if (fileInfo.workspaceId && fileInfo.workspaceId !== workspaceId) {
    throw new SkillError(
      400,
      "Skill icon file must belong to the current workspace"
    )
  }

  return iconFileId
}

async function normalizeMarketplaceSkillIconFileId(
  iconFileId: string,
  authorUserId?: string
) {
  const fileInfo = await getFileAccessInfo(iconFileId)
  if (!fileInfo) {
    throw new SkillError(400, "Skill icon file not found")
  }

  if (authorUserId) {
    const canAccess = await canUserAccessFileWorkspace(
      fileInfo.workspaceId ?? null,
      authorUserId
    )
    if (!canAccess) {
      throw new SkillError(403, "Skill icon file is not accessible")
    }
  } else if (fileInfo.workspaceId) {
    throw new SkillError(
      400,
      "Marketplace skill icon file must be platform-accessible"
    )
  }

  if (!fileInfo.workspaceId) {
    return iconFileId
  }

  const duplicated = await duplicateFileRecord(iconFileId, {
    workspaceId: null,
    uploaderUserId: authorUserId || null,
    origin: buildSystemGeneratedOrigin({
      system: FILE_ORIGIN_SYSTEMS.MARKETPLACE_SKILL_ICON_COPY,
      initiatorUserId: authorUserId || null,
      details: {
        parentFileId: iconFileId,
      },
    }),
  })
  if (!duplicated) {
    throw new SkillError(400, "Skill icon file not found")
  }

  return duplicated.id
}

export function frontmatterFromSnapshotRow(
  row: SkillSnapshotJoinRow
): SkillFrontmatter {
  if (
    !row.snapshotId ||
    !row.snapshotDisplayName ||
    row.snapshotDescription === null
  ) {
    throw new SkillError(500, "Skill snapshot metadata is missing")
  }

  return {
    name: row.snapshotDisplayName,
    description: row.snapshotDescription,
    argumentHint: row.snapshotArgumentHint || undefined,
    disableModelInvocation: Boolean(row.snapshotDisableModelInvocation),
    userInvocable:
      row.snapshotUserInvocable === null
        ? true
        : Boolean(row.snapshotUserInvocable),
    allowedTools: row.snapshotAllowedTools || [],
    model: row.snapshotModel || undefined,
    effort: row.snapshotEffort || undefined,
    context: row.snapshotContext || undefined,
    agent: row.snapshotAgent || undefined,
    hooks: row.snapshotHooks,
  }
}

export function bodyBlocksFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return normalizeStoredBlocks(row.snapshotBodyBlocks)
}

export function descriptionBlockFromSnapshotRow(row: SkillSnapshotJoinRow) {
  return defaultDescriptionBlock(row.snapshotDescription || "")
}

function resolvePublicUseScope(row: SkillAccessRow): SkillAccessSuggestion {
  if (row.bindScope === "actor" && row.conversationId) {
    return "actor_conversation"
  }
  if (row.bindScope === "remote_agent" && row.conversationId) {
    return "remote_agent_conversation"
  }
  switch (row.bindScope) {
    case "workspace":
    case "conversation":
    case "actor":
    case "remote_agent":
      return row.bindScope
    case "workspace_member":
      // workspace_member-scoped skill bindings are individual approvals.
      // For UI grouping purposes treat them as workspace-level visibility.
      return "workspace"
    default:
      return "workspace"
  }
}

function skillAccessCreatedAtMs(row: SkillAccessRow): number {
  return row.createdAt?.getTime?.() ?? 0
}

function compareBindingPriority(left: SkillAccessRow, right: SkillAccessRow) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  }
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor: 0,
    remote_agent: 0,
    workspace_member: 2,
    conversation: 3,
    workspace: 4,
  }

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status]
  }
  if (scopeOrder[left.bindScope] !== scopeOrder[right.bindScope]) {
    return scopeOrder[left.bindScope] - scopeOrder[right.bindScope]
  }
  return skillAccessCreatedAtMs(right) - skillAccessCreatedAtMs(left)
}

function compareVisibleBindingPriority(
  left: SkillAccessRow,
  right: SkillAccessRow
) {
  const statusOrder: Record<SkillAccessRow["status"], number> = {
    active: 0,
    revoked: 1,
  }
  const scopeOrder: Record<RuntimeBindingScope, number> = {
    actor: 0,
    remote_agent: 0,
    workspace_member: 2,
    conversation: 3,
    workspace: 4,
  }

  if (statusOrder[left.status] !== statusOrder[right.status]) {
    return statusOrder[left.status] - statusOrder[right.status]
  }
  if (scopeOrder[left.bindScope] !== scopeOrder[right.bindScope]) {
    return scopeOrder[left.bindScope] - scopeOrder[right.bindScope]
  }
  return skillAccessCreatedAtMs(right) - skillAccessCreatedAtMs(left)
}

function selectInitialSkillGrant(accessRows: SkillAccessRow[]) {
  const activeRows = accessRows.filter((row) => row.status === "active")
  return [...activeRows].sort(
    (left, right) =>
      skillAccessCreatedAtMs(left) - skillAccessCreatedAtMs(right)
  )[0]
}

export function matchesScopeTarget(
  binding: SkillAccessRow,
  filter?: SkillScopeTarget
) {
  if (!filter) {
    return true
  }
  return (
    binding.bindScope === filter.bindScope &&
    binding.actorId === filter.actorId &&
    binding.conversationId === filter.conversationId &&
    // Round 13 review (P3): comparing only (bind_scope, actor_id,
    // conversation_id) means two grants on the same skill with
    // different workspace_member targets (A vs B) both match a query
    // for A and the preferred-binding selection is arbitrary. Same
    // hazard exists for remote_agent grants — bring both ids into the
    // discriminator now so a future remote_agent list filter doesn't
    // repeat the same bug.
    binding.workspaceMemberId === filter.workspaceMemberId &&
    binding.remoteAgentId === filter.remoteAgentId
  )
}

export function resolveInstalledSkillSourceConversationTypeMask(
  row: InstalledSkillRow
) {
  return row.sourceDefaultConversationTypeMask || DEFAULT_CONVERSATION_TYPE_MASK
}

export function resolveInstalledSkillEffectiveConversationTypeMask(row: {
  workspaceConversationTypeMask: number
  conversation_type_mask_override: number | null
}) {
  return resolveNarrowedConversationTypeMask(
    row.workspaceConversationTypeMask,
    row.conversation_type_mask_override
  )
}

/**
 * Collapse the label switch into a direct
 * call to readAutomationEventSourceAccessBindingTarget. The old switch fell back to
 * `workspace` for any unrecognized `bind_scope`. The mapper feeds into
 * `validateConversationScopedAccessTarget` and
 * `assertGrantConversationTypeOverrideAllowed` from
 * updateInstalledSkill / updateInstalledSkillGrant — so a
 * remote_agent grant being updated would silently
 * decode as workspace, skipping the conversation-scoped policy check
 * and the active-participant check.
 *
 * The row at runtime carries the bindingRowSelectFor `subject_kind` +
 * `subject_*_via_join` + `scope_kind` + `scope_*_via_join` projection
 * that readAutomationEventSourceAccessBindingTarget needs (loadAccessBindingsBySkillIds runs
 * the full SELECT). SkillAccessRow's type doesn't expose those fields,
 * hence the `as any` cast.
 */
export function skillBindingToAccessTarget(
  binding: SkillAccessRow,
  _fallbackWorkspaceId: string
): WorkspaceAppGrantTargetInput {
  switch (binding.bindScope) {
    case "workspace":
      return { subject: workspaceRef(binding.workspaceId) }
    case "workspace_member":
      if (!binding.workspaceMemberId) {
        throw new Error(
          "workspace_member skill binding missing workspace_member_id"
        )
      }
      return { subject: workspaceMemberRef(binding.workspaceMemberId) }
    case "conversation":
      if (!binding.conversationId) {
        throw new Error("conversation skill binding missing conversation_id")
      }
      return { subject: conversationRef(binding.conversationId) }
    case "actor":
      if (!binding.actorId) {
        throw new Error("actor skill binding missing actor_id")
      }
      return {
        subject: actorRef(binding.actorId),
        ...(binding.conversationId
          ? { scope: conversationRef(binding.conversationId) }
          : {}),
      }
    case "remote_agent":
      if (!binding.remoteAgentId) {
        throw new Error("remote_agent skill binding missing remote_agent_id")
      }
      return {
        subject: remoteAgentRef(binding.remoteAgentId),
        ...(binding.conversationId
          ? { scope: conversationRef(binding.conversationId) }
          : {}),
      }
  }
}

function buildAvailableSkillPayload(
  row: VisibleSkillRow
): AvailableSkillSummary {
  return {
    instanceId: row.skillId,
    packageId: row.skillId,
    revisionId: row.currentSkillVersionId,
    name: row.displayName,
    description: row.description,
    version: row.sourceVersionValue || `local-${row.currentVersion}`,
    accessTarget: visibleRowToAccessTarget(row),
    sourcePackageSlug: row.sourceSlug || undefined,
    sourceKind: "installed",
  }
}

export function visibleRowToAccessTarget(
  row: VisibleSkillRow
): WorkspaceAppGrantTargetInput {
  switch (row.accessBindScope) {
    case "workspace":
      return { subject: workspaceRef(row.workspaceId) }
    case "workspace_member":
      return row.workspaceMemberId
        ? { subject: workspaceMemberRef(row.workspaceMemberId) }
        : { subject: workspaceRef(row.workspaceId) }
    case "actor":
      return row.actorId
        ? {
            subject: actorRef(row.actorId),
            ...(row.conversationId
              ? { scope: conversationRef(row.conversationId) }
              : {}),
          }
        : { subject: workspaceRef(row.workspaceId) }
    case "remote_agent":
      return row.remoteAgentId
        ? {
            subject: remoteAgentRef(row.remoteAgentId),
            ...(row.conversationId
              ? { scope: conversationRef(row.conversationId) }
              : {}),
          }
        : { subject: workspaceRef(row.workspaceId) }
    case "conversation":
      return row.conversationId
        ? { subject: conversationRef(row.conversationId) }
        : { subject: workspaceRef(row.workspaceId) }
    default:
      return { subject: workspaceRef(row.workspaceId) }
  }
}

function descriptionTextFromInput(description?: CanonicalContentBlockInput) {
  return renderSkillBlocksToText(
    normalizeCanonicalContentBlocks(
      description ? [description] : [defaultDescriptionBlock()]
    )
  ).trim()
}

function buildPreparedSnapshotFromInput(params: {
  fallbackName: string
  explicitName?: string
  explicitDescription?: CanonicalContentBlockInput
  files?: SkillAttachmentInput[]
  existingSnapshot?: {
    frontmatter: SkillFrontmatter
    bodyBlocks: CanonicalContentBlock[]
    files: SkillSnapshotFileRow[]
  }
}) {
  const descriptionText = descriptionTextFromInput(params.explicitDescription)

  if (params.files && params.files.length > 0) {
    return prepareSkillSnapshotFromFiles({
      files: params.files.map((file) => ({
        path: file.path,
        mediaType: file.mediaType,
        contentBlocks: file.contentBlocks,
      })),
      fallbackName: params.fallbackName,
      frontmatterOverrides: {
        name: params.explicitName?.trim() || undefined,
        description: descriptionText || undefined,
      },
    })
  }

  if (params.existingSnapshot) {
    return buildPreparedSnapshotFromExistingData({
      fallbackName: params.fallbackName,
      existingFiles: buildSyntheticSkillFilesFromSnapshot({
        frontmatter: params.existingSnapshot.frontmatter,
        bodyBlocks: params.existingSnapshot.bodyBlocks,
        files: params.existingSnapshot.files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType || undefined,
          contentBlocks: normalizeStoredBlocks(file.contentBlocks),
        })),
      }),
      frontmatterOverrides: {
        name: params.explicitName?.trim() || undefined,
        description: descriptionText || undefined,
      },
    })
  }

  const frontmatterName = normalizeSkillCommandName(
    params.explicitName?.trim() || params.fallbackName
  )
  if (!frontmatterName) {
    throw new SkillError(400, "Skill name is required")
  }

  return prepareSkillSnapshotFromFiles({
    files: [
      {
        path: SKILL_ENTRY_PATH,
        mediaType: "text/markdown",
        contentBlocks: [
          {
            type: "text",
            text: buildSkillMarkdown(
              {
                name: frontmatterName,
                description:
                  descriptionText || `Skill package for ${frontmatterName}.`,
                disableModelInvocation: false,
                userInvocable: true,
                allowedTools: [],
              },
              []
            ),
          },
        ],
      },
    ],
    fallbackName: frontmatterName,
  })
}

// D3: legacy `legacyCapabilityAccessTargetOrThrow` / `legacyAccessGrantTargetOrThrow`
// helpers removed — all CapabilityAccessTarget values are now ScopedSubjectTarget.

export function buildSkillAccessRow(row: SkillAccessRow): SkillAccessRow {
  const target = skillBindingToAccessTarget(row, row.workspaceId)
  const label = subjectScopeLabel(target)
  let bindScope: RuntimeBindingScope
  switch (label) {
    case "workspace":
    case "workspace_member":
    case "conversation":
    case "actor":
    case "remote_agent":
      bindScope = label
      break
    default:
      bindScope = "workspace"
  }
  const actorId =
    target.subject.kind === "actor"
      ? (target.subject as { actorId: string }).actorId
      : null
  const remoteAgentId =
    target.subject.kind === "remote_agent"
      ? (target.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const conversationId =
    target.scope?.kind === "conversation"
      ? (target.scope as { conversationId: string }).conversationId
      : target.subject.kind === "conversation"
        ? (target.subject as { conversationId: string }).conversationId
        : null
  const workspaceMemberId =
    target.subject.kind === "workspace_member"
      ? (target.subject as { memberId: string }).memberId
      : null
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    skillId: row.skillId,
    bindScope: bindScope,
    conversationId: conversationId,
    actorId: actorId,
    remoteAgentId: remoteAgentId,
    workspaceMemberId: workspaceMemberId,
    conversationTypeMaskOverride: row.conversationTypeMaskOverride,
    status: row.status,
    source: row.source as SkillAccessRow["source"],
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId,
    reason: row.reason,
    createdAt: row.createdAt || new Date(0),
    revokedAt: row.revokedAt,
  }
}

async function loadAccessBindingsBySkillIdsForContext(
  skillIds: string[],
  context: {
    contextWorkspaceId: string
    workspaceMemberId?: string
    actorId?: string
    remoteAgentId?: string
    conversationId?: string
  }
) {
  if (skillIds.length === 0) return new Map<string, SkillAccessRow[]>()
  const bindings = await loadAccessBindingsBySkillIds(skillIds)

  const map = new Map<string, SkillAccessRow[]>()
  for (const [skillId, rows] of bindings.entries()) {
    const filtered = rows.filter((row) => {
      switch (row.bindScope) {
        case "workspace":
          return true
        case "workspace_member":
          return row.workspaceMemberId === (context.workspaceMemberId || null)
        case "conversation":
          return row.conversationId === (context.conversationId || null)
        case "actor":
          return (
            row.actorId === (context.actorId || null) &&
            (!row.conversationId ||
              row.conversationId === (context.conversationId || null))
          )
        case "remote_agent":
          return (
            row.remoteAgentId === (context.remoteAgentId || null) &&
            (!row.conversationId ||
              row.conversationId === (context.conversationId || null))
          )
      }
    })
    if (filtered.length > 0) {
      map.set(skillId, filtered)
    }
  }
  return map
}

async function listSkillAccessRows(skillId: string, includeRevoked = false) {
  const rows = await loadAccessBindingsBySkillIds([skillId], includeRevoked)
  return rows.get(skillId) || []
}

async function loadInstalledSkillForUpdate(
  workspaceId: string,
  skillId: string
) {
  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: [skillId],
  })
  return rows[0] || null
}

async function loadInstalledSkillById(skillId: string) {
  const rows = await loadInstalledSkillRows({
    skillIds: [skillId],
  })
  return rows[0] || null
}

async function chooseBindingMap(
  skillIds: string[],
  filters?: {
    accessTargetType?: SkillUseScope
    actorId?: string
    remoteAgentId?: string
    workspaceMemberId?: string
    conversationId?: string
  }
) {
  const bindingsBySkillId = await loadAccessBindingsBySkillIds(skillIds)
  const preferredTarget = filters?.accessTargetType
    ? normalizeScopeTarget({
        useScope: filters.accessTargetType,
        actorId: filters.actorId,
        remoteAgentId: filters.remoteAgentId,
        workspaceMemberId: filters.workspaceMemberId,
        conversationId: filters.conversationId,
      })
    : undefined

  const map = new Map<string, SkillAccessRow | undefined>()
  for (const skillId of skillIds) {
    const candidates = bindingsBySkillId.get(skillId) || []
    const matching = preferredTarget
      ? candidates.filter((binding) =>
          matchesScopeTarget(binding, preferredTarget)
        )
      : candidates
    const chosen = [...(matching.length > 0 ? matching : candidates)].sort(
      compareBindingPriority
    )[0]
    map.set(skillId, chosen)
  }

  return map
}

async function findSkillIdsByBindingFilter(params: {
  workspaceId: string
  accessTargetType?: SkillUseScope
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
  conversationId?: string
}) {
  if (
    !params.accessTargetType &&
    !params.actorId &&
    !params.remoteAgentId &&
    !params.workspaceMemberId &&
    !params.conversationId
  ) {
    return null
  }

  const target = params.accessTargetType
    ? await resolveAccessGrantTarget({
        workspaceId: params.workspaceId,
        target: scopedTargetFromSkillUseScope({
          useScope: params.accessTargetType,
          workspaceId: params.workspaceId,
          actorId: params.actorId,
          remoteAgentId: params.remoteAgentId,
          workspaceMemberId: params.workspaceMemberId,
          conversationId: params.conversationId,
        }),
      })
    : null

  return findSkillIdsByBindingFilterRepo({
    workspaceId: params.workspaceId,
    resolvedTarget: target,
    actorId: params.actorId,
    remoteAgentId: params.remoteAgentId,
    workspaceMemberId: params.workspaceMemberId,
    conversationId: params.conversationId,
  })
}

async function ensureSkillBinding(
  client: Executor,
  input: {
    skillId: string
    workspaceId: string
    target: SkillScopeTarget
    createdByWorkspaceMemberId?: string
  }
) {
  const grantTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: scopedTargetFromSkillUseScope({
      useScope: input.target.useScope,
      workspaceId: input.workspaceId,
      actorId: input.target.actorId || undefined,
      remoteAgentId: input.target.remoteAgentId || undefined,
      workspaceMemberId: input.target.workspaceMemberId || undefined,
      conversationId: input.target.conversationId || undefined,
    }),
  })
  const existingRows = await loadAccessBindingsBySkillIds([input.skillId])
  const existingBinding = (existingRows.get(input.skillId) || []).find((row) =>
    matchesScopeTarget(
      row,
      normalizeScopeTarget({
        useScope: input.target.useScope,
        actorId: input.target.actorId,
        remoteAgentId: input.target.remoteAgentId,
        workspaceMemberId: input.target.workspaceMemberId,
        conversationId: input.target.conversationId,
      })
    )
  )

  if (existingBinding) {
    return {
      bindingId: existingBinding.id,
    }
  }

  const inserted = await insertWorkspaceAppGrant(client as any, {
    workspaceId: input.workspaceId,
    workspaceAppId: input.skillId,
    target: grantTarget,
    permissions: ["use"],
    createdByWorkspaceMemberId: input.createdByWorkspaceMemberId || null,
  })

  return {
    bindingId: inserted.id,
  }
}

async function getInstalledSkillRecord(
  workspaceId: string,
  installedSkillId: string
): Promise<InstalledSkillPresentationRecord> {
  const row = await loadInstalledSkillForUpdate(workspaceId, installedSkillId)
  if (!row) {
    throw new SkillError(404, "Installed skill not found")
  }

  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap([installedSkillId]),
    loadSkillSnapshotFilesMap([row.currentSnapshotId]),
  ])
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      row.workspaceId,
      "installed_skill"
    )

  return {
    id: row.skillId,
    row,
    binding: bindingMap.get(installedSkillId),
    workspaceConversationTypeMask,
    files: fileMap.get(row.currentSnapshotId) || [],
  }
}

export async function listMarketplaceSkills(filters?: {
  search?: string
  tags?: string[]
  workspaceId?: string
}) {
  const rows = await listMarketplaceRows({
    search: filters?.search,
    tags: filters?.tags,
  })

  const latestSnapshotIds = rows
    .map((row) => row.snapshotId)
    .filter((value): value is string => Boolean(value))
  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(latestSnapshotIds),
    filters?.workspaceId
      ? buildMarketplaceInstallationMap(filters.workspaceId)
      : Promise.resolve(null),
  ])

  return rows.map((row) =>
    mapMarketplaceEntry(
      row,
      installationMap?.get(row.itemId),
      row.snapshotId ? filesMap.get(row.snapshotId) || [] : undefined
    )
  )
}

export async function getMarketplaceSkill(
  skillId: string,
  workspaceId?: string
) {
  const row = await getMarketplaceRowById(skillId)
  if (!row) {
    throw new SkillError(404, "Skill not found")
  }

  const [filesMap, installationMap] = await Promise.all([
    loadSkillSnapshotFilesMap(row.snapshotId ? [row.snapshotId] : []),
    workspaceId
      ? buildMarketplaceInstallationMap(workspaceId)
      : Promise.resolve(null),
  ])

  return mapMarketplaceEntry(
    row,
    installationMap?.get(row.itemId),
    row.snapshotId ? filesMap.get(row.snapshotId) || [] : undefined
  )
}

function publisherOptionsForMirrorSource(
  sourceType: ImportedMirrorSkillPackage["mirrorSource"]["sourceType"]
) {
  if (sourceType === "github") {
    return {
      slug: GITHUB_MARKETPLACE_PUBLISHER_SLUG,
      displayName: GITHUB_MARKETPLACE_PUBLISHER_NAME,
    }
  }

  return {
    slug: CLAWHUB_MARKETPLACE_PUBLISHER_SLUG,
    displayName: CLAWHUB_MARKETPLACE_PUBLISHER_NAME,
  }
}

async function upsertImportedMarketplaceSkill(
  imported: ImportedMirrorSkillPackage,
  authorUserId?: string
) {
  const result = await withSkillsTransaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(client, {
      ownerUserId: authorUserId,
      ...publisherOptionsForMirrorSource(imported.mirrorSource.sourceType),
    })
    const mirrorSourceId = await upsertSkillMirrorSource(
      client,
      imported.mirrorSource
    )
    const existing = await getMarketplaceRowByMirrorSourceId(
      mirrorSourceId,
      clientRunner(client)
    )

    if (
      existing &&
      existing.latestVersionValue === imported.version &&
      existing.snapshotContentHash === imported.contentHash
    ) {
      await updateMarketplaceCatalogItemSummary(client, {
        itemId: existing.itemId,
        displayName: imported.frontmatter.name,
        summary: imported.frontmatter.description,
        longDescription: imported.frontmatter.description,
        tags: imported.tags,
        metadata: imported.itemMetadata,
      })
      return existing.itemId
    }

    const itemSlug = existing
      ? existing.itemSlug
      : await allocateMarketplaceItemSlug(
          client,
          publisherId,
          sanitizeSlug(imported.catalogSlug) || "skill"
        )

    let itemId = existing?.itemId || null
    if (existing) {
      await updateMarketplaceCatalogItemRecord(client, {
        itemId: existing.itemId,
        slug: itemSlug,
        displayName: imported.frontmatter.name,
        summary: imported.frontmatter.description,
        longDescription: imported.frontmatter.description,
        mirrorSourceId: mirrorSourceId,
        sourceKind: "official",
        visibility: "public",
        tags: imported.tags,
        isActive: true,
        metadata: imported.itemMetadata,
      })
      itemId = existing.itemId
    } else {
      itemId = await insertMarketplaceCatalogItemRecord(client, {
        publisherId: publisherId,
        slug: itemSlug,
        displayName: imported.frontmatter.name,
        summary: imported.frontmatter.description,
        longDescription: imported.frontmatter.description,
        mirrorSourceId: mirrorSourceId,
        sourceKind: "official",
        visibility: "public",
        tags: imported.tags,
        isActive: true,
        metadata: imported.itemMetadata,
      })
    }

    const snapshotId = await insertSkillSnapshot(client, imported, {
      mirrorSourceId,
      resolvedRevision: imported.mirrorSource.resolvedRevision || null,
    })

    const existingVersionId = await getCatalogVersionId(client, {
      catalogItemId: itemId!,
      version: imported.version,
    })

    const versionId =
      existingVersionId ||
      (await insertCatalogVersionRecord(client, {
        catalogItemId: itemId!,
        version: imported.version,
        changelog: imported.changelog,
        metadata: imported.itemMetadata,
        createdByUserId: authorUserId || null,
      }))

    if (existingVersionId) {
      await updateCatalogVersionRecord(client, {
        versionId,
        changelog: imported.changelog,
        metadata: imported.itemMetadata,
      })
    }

    await upsertSkillPackageVersionSpecRecord(client, {
      catalogVersionId: versionId,
      skillSnapshotId: snapshotId,
      defaultConversationTypeMask: DEFAULT_CONVERSATION_TYPE_MASK,
    })

    await updateCatalogItemLatestVersion(client, {
      itemId: itemId!,
      versionId,
    })

    return itemId
  })

  return getMarketplaceSkill(result)
}

export async function importMarketplaceMirrorSkill(
  input:
    | {
        sourceType: "github"
        repoUrl: string
        path: string
        ref?: string
        authorUserId?: string
      }
    | {
        sourceType: "clawhub"
        ownerId?: string
        slug: string
        version?: string
        authorUserId?: string
      }
) {
  const imported =
    input.sourceType === "github"
      ? await importGitHubSkillPackage({
          repoUrl: input.repoUrl,
          path: input.path,
          ref: input.ref,
        })
      : await importClawhubSkillPackage({
          ownerId: input.ownerId,
          slug: input.slug,
          version: input.version,
        })

  return upsertImportedMarketplaceSkill(imported, input.authorUserId)
}

export async function importSeededClawhubMarketplaceSkill(input: {
  skillDir: string
  authorUserId?: string
}) {
  const imported = await importClawhubSeedSkillPackage({
    skillDir: input.skillDir,
  })
  return upsertImportedMarketplaceSkill(imported, input.authorUserId)
}

export async function refreshMarketplaceSkill(input: {
  skillId: string
  authorUserId?: string
}) {
  const existing = await getMarketplaceRowById(input.skillId)
  if (!existing || !existing.mirrorSourceId || !existing.mirrorSourceType) {
    throw new SkillError(400, "Marketplace skill has no mirror source")
  }

  if (existing.mirrorSourceType === "github") {
    const locator = existing.mirrorLocator
    return importMarketplaceMirrorSkill({
      sourceType: "github",
      repoUrl: String(locator.repoUrl || ""),
      path: String(locator.path || "."),
      ref: existing.mirrorRequestedRef || undefined,
      authorUserId: input.authorUserId,
    })
  }

  const locator = existing.mirrorLocator
  return importMarketplaceMirrorSkill({
    sourceType: "clawhub",
    ownerId:
      typeof locator.ownerId === "string" && locator.ownerId.trim().length > 0
        ? locator.ownerId
        : undefined,
    slug: String(locator.slug || ""),
    version: existing.mirrorRequestedRef || undefined,
    authorUserId: input.authorUserId,
  })
}

export async function publishMarketplaceSkill(input: {
  skillId?: string
  slug: string
  name: string
  description?: CanonicalContentBlockInput
  iconFileId?: string | null
  tags?: string[]
  version: string
  changelog?: string
  attachmentFiles?: SkillAttachmentInput[]
  defaultConversationTypeMask?: number
  authorUserId?: string
  isActive?: boolean
  metadata?: JsonObject
}) {
  const canonicalSlug = sanitizeSlug(input.slug || input.name)
  if (!canonicalSlug) {
    throw new SkillError(400, "Skill slug is required")
  }

  const name = input.name.trim()
  if (!name) {
    throw new SkillError(400, "Skill name is required")
  }

  const version = input.version.trim()
  if (!version) {
    throw new SkillError(400, "Skill version is required")
  }

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles)
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: canonicalSlug || name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  })
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: input.defaultConversationTypeMask,
    overrideMask: null,
  })

  const result = await withSkillsTransaction(async (client) => {
    const publisherId = await ensureMarketplacePublisher(client, {
      ownerUserId: input.authorUserId,
    })
    const existing = input.skillId
      ? await getMarketplaceRowById(input.skillId, clientRunner(client))
      : await getMarketplaceRowBySlug(
          publisherId,
          canonicalSlug,
          clientRunner(client)
        )

    let itemId = existing?.itemId || null
    if (existing && existing.itemId !== input.skillId && input.skillId) {
      throw new SkillError(404, "Skill not found")
    }

    const itemMetadata: JsonObject = {
      ...(existing?.itemMetadata || {}),
      canonicalSlug,
      frontmatterName: preparedSnapshot.frontmatter.name,
      ...(input.metadata || {}),
    }
    const nextIconFileId =
      input.iconFileId === undefined
        ? (existing?.itemIconFileId ?? null)
        : input.iconFileId
          ? await normalizeMarketplaceSkillIconFileId(
              input.iconFileId,
              input.authorUserId
            )
          : null

    if (existing) {
      await updateMarketplaceCatalogItemRecord(client, {
        itemId: existing.itemId,
        slug: canonicalSlug,
        displayName: preparedSnapshot.frontmatter.name,
        summary: preparedSnapshot.frontmatter.description,
        longDescription: preparedSnapshot.frontmatter.description,
        mirrorSourceId: null,
        sourceKind: "official",
        visibility: "public",
        tags: input.tags || [],
        isActive: input.isActive ?? true,
        iconFileId: nextIconFileId,
        metadata: itemMetadata,
      })
      itemId = existing.itemId
    } else {
      itemId = await insertMarketplaceCatalogItemRecord(client, {
        publisherId: publisherId,
        slug: canonicalSlug,
        displayName: preparedSnapshot.frontmatter.name,
        summary: preparedSnapshot.frontmatter.description,
        longDescription: preparedSnapshot.frontmatter.description,
        mirrorSourceId: null,
        sourceKind: "official",
        visibility: "public",
        tags: input.tags || [],
        isActive: input.isActive ?? true,
        iconFileId: nextIconFileId,
        metadata: itemMetadata,
      })
    }

    const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)

    const existingVersionId = await getCatalogVersionId(client, {
      catalogItemId: itemId!,
      version,
    })

    const versionMetadata = input.metadata || {}
    const versionId =
      existingVersionId ||
      (await insertCatalogVersionRecord(client, {
        catalogItemId: itemId!,
        version,
        changelog: input.changelog || "",
        metadata: versionMetadata,
        createdByUserId: input.authorUserId || null,
      }))

    if (existingVersionId) {
      await updateRepublishedCatalogVersionRecord(client, {
        versionId,
        changelog: input.changelog || "",
        metadata: versionMetadata,
        createdByUserId: input.authorUserId || null,
      })
    }

    await upsertSkillPackageVersionSpecRecord(client, {
      catalogVersionId: versionId,
      skillSnapshotId: snapshotId,
      defaultConversationTypeMask: defaultConversationTypeMask,
    })

    await updateCatalogItemLatestVersion(client, {
      itemId: itemId!,
      versionId,
    })

    return itemId
  })

  return getMarketplaceSkill(result)
}

export async function createWorkspaceSkill(input: {
  workspaceId: string
  name: string
  description?: CanonicalContentBlockInput
  iconFileId?: string
  tags?: string[]
  attachmentFiles?: SkillAttachmentInput[]
  accessTarget?: CapabilityAccessTarget
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  installedByWorkspaceMemberId?: string
}) {
  const name = input.name.trim()
  if (!name) {
    throw new SkillError(400, "Skill name is required")
  }

  const attachmentFiles = normalizeSkillAttachments(input.attachmentFiles)
  const preparedSnapshot = buildPreparedSnapshotFromInput({
    fallbackName: name,
    explicitName: name,
    explicitDescription: input.description,
    files: attachmentFiles,
  })
  const iconFileId = input.iconFileId
    ? await normalizeWorkspaceSkillIconFileId(
        input.iconFileId,
        input.workspaceId
      )
    : null
  // D3: input.accessTarget is now a ScopedSubjectTarget; collapse to the
  // legacy SkillUseScope label for downstream SkillScopeTarget bookkeeping.
  // Round 10 review (P2): also extract remoteAgentId so SkillScopeTarget
  // doesn't drop the remote_agent identity when the target subject is
  // a remote agent.
  // Round 11 review (P2): same for workspace_member — without this the
  // workspace_member skill grant path would crash in ensureSkillBinding.
  const target = input.accessTarget
    ? normalizeScopeTarget({
        useScope: skillUseScopeFromTarget(input.accessTarget),
        actorId:
          input.accessTarget.subject.kind === "actor"
            ? (input.accessTarget.subject as { actorId: string }).actorId
            : null,
        remoteAgentId:
          input.accessTarget.subject.kind === "remote_agent"
            ? (input.accessTarget.subject as { remoteAgentId: string })
                .remoteAgentId
            : null,
        workspaceMemberId:
          input.accessTarget.subject.kind === "workspace_member"
            ? (input.accessTarget.subject as { memberId: string }).memberId
            : null,
        conversationId:
          input.accessTarget.scope?.kind === "conversation"
            ? (input.accessTarget.scope as { conversationId: string })
                .conversationId
            : input.accessTarget.subject.kind === "conversation"
              ? (input.accessTarget.subject as { conversationId: string })
                  .conversationId
              : null,
      })
    : null

  const result = await withSkillsTransaction(async (client) => {
    const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)
    const skillId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: skillId,
      workspaceId: input.workspaceId,
      kind: "installed_skill",
      displayName: preparedSnapshot.frontmatter.name,
      ownerWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      status: "active",
      conversationTypeMaskOverride: null,
    })
    const insertedSkillId = await insertInstalledSkillRecord(client, {
      id: skillId,
      iconFileId: iconFileId,
      tags: input.tags || [],
      currentVersion: 1,
      currentSnapshotId: snapshotId,
    })

    await insertSkillVersionRecord(client, {
      skillId: insertedSkillId,
      version: 1,
      skillSnapshotId: snapshotId,
      metadata: {},
      createdByWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
    })

    if (input.grants?.length) {
      for (const grant of input.grants) {
        await insertWorkspaceAppGrant(client as any, {
          workspaceId: input.workspaceId,
          workspaceAppId: insertedSkillId,
          target: await resolveAccessGrantTarget({
            workspaceId: input.workspaceId,
            target: grant.target,
          }),
          permissions: grant.permissions,
          conversationTypeMaskOverride:
            grant.conversationTypeMaskOverride ?? null,
          createdByWorkspaceMemberId:
            input.installedByWorkspaceMemberId || null,
          reason: grant.reason ?? null,
        })
      }
    } else if (target) {
      await ensureSkillBinding(client, {
        skillId: insertedSkillId,
        workspaceId: input.workspaceId,
        target,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
      })
    }

    return {
      skillId: insertedSkillId,
    }
  })

  return getInstalledSkillRecord(input.workspaceId, result.skillId)
}

export async function listInstalledSkills(
  workspaceId: string,
  filters?: {
    skillIds?: string[]
    accessTargetType?: SkillUseScope
    actorId?: string
    // Round 12 review (P3): workspace_member filter requires the id so
    // the underlying scopedTargetFromSkillUseScope("workspace_member")
    // call can build a SubjectRef. Previously the filter mode accepted
    // accessTargetType=workspace_member from the controller but the
    // service had no way to receive the id, so the filter crashed at
    // "workspaceMemberId is required for workspace_member scope".
    workspaceMemberId?: string
    conversationId?: string
    remoteAgentId?: string
    sourceSkillId?: string
  }
) {
  const filteredSkillIds = await findSkillIdsByBindingFilter({
    workspaceId,
    accessTargetType: filters?.accessTargetType,
    actorId: filters?.actorId,
    remoteAgentId: filters?.remoteAgentId,
    workspaceMemberId: filters?.workspaceMemberId,
    conversationId: filters?.conversationId,
  })
  if (filteredSkillIds && filteredSkillIds.length === 0) {
    return []
  }

  const rows = await loadInstalledSkillRows({
    workspaceId,
    skillIds: filters?.skillIds || filteredSkillIds || undefined,
    sourceSkillId: filters?.sourceSkillId,
  })
  if (rows.length === 0) return []

  const skillIds = rows.map((row) => row.skillId)
  const [bindingMap, fileMap] = await Promise.all([
    chooseBindingMap(skillIds, {
      accessTargetType: filters?.accessTargetType,
      actorId: filters?.actorId,
      remoteAgentId: filters?.remoteAgentId,
      workspaceMemberId: filters?.workspaceMemberId,
      conversationId: filters?.conversationId,
    }),
    loadSkillSnapshotFilesMap(rows.map((row) => row.currentSnapshotId)),
  ])
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      "installed_skill"
    )

  return rows.map(
    (row): InstalledSkillPresentationRecord => ({
      id: row.skillId,
      row,
      binding: bindingMap.get(row.skillId),
      workspaceConversationTypeMask,
      files: fileMap.get(row.currentSnapshotId) || [],
    })
  )
}

export async function getInstalledSkill(
  workspaceId: string,
  installedSkillId: string
) {
  return getInstalledSkillRecord(workspaceId, installedSkillId)
}

export async function getInstalledSkillGrantState(
  workspaceId: string,
  installedSkillId: string
) {
  const skillRow = await loadInstalledSkillForUpdate(
    workspaceId,
    installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspaceId,
      "installed_skill"
    )
  const accessRows = await listSkillAccessRows(installedSkillId)
  const grants = accessRows.map((row) =>
    presentSkillAccessGrant(row, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversationTypeMaskOverride ?? null,
    })
  )
  const initialGrant = selectInitialSkillGrant(accessRows)
  const suggestedGrantScope = initialGrant
    ? resolvePublicUseScope(initialGrant)
    : ("workspace" as SkillAccessSuggestion)

  return {
    grants,
    summary: {
      requiredPermissions: [ACCESS_ACTIONS["installed_skill.use"].permission],
      suggestedAccessTargetType: suggestedGrantScope,
      sourceDefaultConversationTypeMask:
        resolveInstalledSkillSourceConversationTypeMask(skillRow),
      workspaceConversationTypeMask,
      conversationTypeMaskOverride:
        skillRow.conversationTypeMaskOverride ?? null,
      effectiveConversationTypeMask:
        resolveInstalledSkillEffectiveConversationTypeMask({
          workspaceConversationTypeMask,
          conversation_type_mask_override:
            skillRow.conversationTypeMaskOverride,
        }),
      reason: "Choose who can use this installed skill.",
      effectivePermissions:
        grants.length > 0
          ? [ACCESS_ACTIONS["installed_skill.use"].permission]
          : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  }
}

export async function createInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  accessTarget?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  grantedByWorkspaceMemberId?: string
  reason?: string
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspaceId,
      "installed_skill"
    )

  const accessRows = await listSkillAccessRows(input.installedSkillId)
  const initialGrant = selectInitialSkillGrant(accessRows)
  const accessTargetInput =
    input.accessTarget ||
    (initialGrant
      ? skillBindingToAccessTarget(initialGrant, input.workspaceId)
      : ({
          subject: workspaceRef(input.workspaceId),
        } satisfies CapabilityAccessTarget))

  const accessTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: accessTargetInput,
  })
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversationTypeMaskOverride ?? null
  )
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    })
  await validateConversationScopedAccessTargetDefault({
    target: accessTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  })

  // P2/P3 fix: include workspace_member_id in the dedupe key. Without it, two
  // different members both look like {workspace_member, null, null} and the
  // second grant is incorrectly treated as already-existing — silently
  // dropping the new member's binding.
  //
  // Round 9 review (P2): include remote_agent_id for the same reason. Two
  // remote_agent grants for different remote agents both have
  // bind_scope="remote_agent" and were silently deduped against each
  // other before this fix.
  const accessTargetLabel = subjectScopeLabel(accessTarget)
  const accessTargetActorId =
    accessTarget.subject.kind === "actor"
      ? (accessTarget.subject as { actorId: string }).actorId
      : null
  const accessTargetRemoteAgentId =
    accessTarget.subject.kind === "remote_agent"
      ? (accessTarget.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const accessTargetConversationId =
    accessTarget.scope?.kind === "conversation"
      ? (accessTarget.scope as { conversationId: string }).conversationId
      : accessTarget.subject.kind === "conversation"
        ? (accessTarget.subject as { conversationId: string }).conversationId
        : null
  const accessTargetWorkspaceMemberId =
    accessTarget.subject.kind === "workspace_member"
      ? (accessTarget.subject as { memberId: string }).memberId
      : null
  const existing = accessRows.find(
    (row) =>
      row.status === "active" &&
      row.bindScope === accessTargetLabel &&
      row.actorId === accessTargetActorId &&
      row.remoteAgentId === accessTargetRemoteAgentId &&
      row.conversationId === accessTargetConversationId &&
      row.workspaceMemberId === accessTargetWorkspaceMemberId
  )
  if (existing) {
    return presentSkillAccessGrant(existing, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        skillRow.conversationTypeMaskOverride ?? null,
    })
  }

  const result = await withSkillsTransaction(async (client) => {
    const inserted = await insertWorkspaceAppGrant(client as any, {
      workspaceId: input.workspaceId,
      workspaceAppId: input.installedSkillId,
      target: accessTarget,
      permissions: ["use"],
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || null,
    })
    return {
      accessRow: {
        id: inserted.id,
        workspaceId: inserted.workspaceId,
        skillId: inserted.workspaceAppId,
        bindScope: accessTarget.subject.kind as RuntimeBindingScope,
        conversationId:
          accessTarget.scope?.kind === "conversation"
            ? accessTarget.scope.conversationId
            : accessTarget.subject.kind === "conversation"
              ? accessTarget.subject.conversationId
              : null,
        actorId:
          accessTarget.subject.kind === "actor"
            ? accessTarget.subject.actorId
            : null,
        remoteAgentId:
          accessTarget.subject.kind === "remote_agent"
            ? accessTarget.subject.remoteAgentId
            : null,
        workspaceMemberId:
          accessTarget.subject.kind === "workspace_member"
            ? accessTarget.subject.memberId
            : null,
        conversationTypeMaskOverride: inserted.conversationTypeMaskOverride,
        status: inserted.status,
        source: inserted.source,
        createdByWorkspaceMemberId: inserted.createdByWorkspaceMemberId,
        reason: inserted.reason,
        createdAt: inserted.createdAt,
        revokedAt: inserted.revokedAt,
      } satisfies SkillAccessRow,
    }
  })

  return presentSkillAccessGrant(result.accessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversationTypeMaskOverride ?? null,
  })
}

export async function updateInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  grantId: string
  conversationTypeMaskOverride?: number | null
}) {
  const skillRow = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!skillRow) {
    throw new SkillError(404, "Installed skill not found")
  }

  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      skillRow.workspaceId,
      "installed_skill"
    )
  const accessRows = await listSkillAccessRows(input.installedSkillId, true)
  const accessRow = accessRows.find((row) => row.id === input.grantId)
  if (!accessRow || accessRow.workspaceId !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found")
  }
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    skillRow.conversationTypeMaskOverride ?? null
  )
  const accessRowTarget = skillBindingToAccessTarget(
    accessRow,
    input.workspaceId
  )
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessRowTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new SkillError(400, message),
      invalidMaskMessage:
        "Skill access grant conversation policy must allow at least one conversation type from the installed skill policy.",
    })
  await validateConversationScopedAccessTargetDefault({
    target: accessRowTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new SkillError(400, message),
  })

  if (input.conversationTypeMaskOverride !== undefined) {
    await updateInstalledSkillGrantConversationTypeMaskOverride(
      input.grantId,
      input.workspaceId,
      input.conversationTypeMaskOverride
    )
  }

  const updatedRows = await listSkillAccessRows(input.installedSkillId)
  const updatedRow = updatedRows.find((row) => row.id === input.grantId)
  if (!updatedRow) {
    throw new SkillError(404, "Access grant not found")
  }

  return presentSkillAccessGrant(updatedRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      skillRow.conversationTypeMaskOverride ?? null,
  })
}

export async function revokeInstalledSkillGrant(input: {
  workspaceId: string
  installedSkillId: string
  grantId: string
}) {
  const accessRows = await listSkillAccessRows(input.installedSkillId, true)
  const accessRow = accessRows.find((row) => row.id === input.grantId)
  if (!accessRow || accessRow.workspaceId !== input.workspaceId) {
    throw new SkillError(404, "Access grant not found")
  }
  if (accessRow.status === "revoked") {
    return presentSkillAccessGrant(accessRow)
  }

  await revokeWorkspaceAppGrantDefault(accessRow.id)

  return { success: true }
}

export async function installMarketplaceSkill(input: {
  workspaceId: string
  marketSkillId: string
  accessTarget?: CapabilityAccessTarget
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
  installedByWorkspaceMemberId?: string
}) {
  const target = input.accessTarget
    ? normalizeScopeTarget({
        useScope: skillUseScopeFromTarget(input.accessTarget),
        actorId:
          input.accessTarget.subject.kind === "actor"
            ? (input.accessTarget.subject as { actorId: string }).actorId
            : null,
        remoteAgentId:
          input.accessTarget.subject.kind === "remote_agent"
            ? (input.accessTarget.subject as { remoteAgentId: string })
                .remoteAgentId
            : null,
        workspaceMemberId:
          input.accessTarget.subject.kind === "workspace_member"
            ? (input.accessTarget.subject as { memberId: string }).memberId
            : null,
        conversationId:
          input.accessTarget.scope?.kind === "conversation"
            ? (input.accessTarget.scope as { conversationId: string })
                .conversationId
            : input.accessTarget.subject.kind === "conversation"
              ? (input.accessTarget.subject as { conversationId: string })
                  .conversationId
              : null,
      })
    : null

  const marketplaceSkill = await getMarketplaceRowById(input.marketSkillId)
  if (
    !marketplaceSkill ||
    !marketplaceSkill.latestVersionId ||
    !marketplaceSkill.snapshotId
  ) {
    throw new SkillError(404, "Marketplace skill not found")
  }

  const result = await withSkillsTransaction(async (client) => {
    const skillId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: skillId,
      workspaceId: input.workspaceId,
      kind: "installed_skill",
      displayName:
        marketplaceSkill.snapshotDisplayName ||
        marketplaceSkill.itemDisplayName,
      ownerWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
      status: "active",
      conversationTypeMaskOverride:
        marketplaceSkill.specDefaultConversationTypeMask ?? null,
    })

    const insertedSkillId = await insertInstalledSkillRecord(client, {
      id: skillId,
      iconFileId: marketplaceSkill.itemIconFileId,
      tags: marketplaceSkill.itemTags || [],
      currentVersion: 1,
      currentSnapshotId: marketplaceSkill.snapshotId!,
    })

    await insertSkillVersionRecord(client, {
      skillId: insertedSkillId,
      version: 1,
      skillSnapshotId: marketplaceSkill.snapshotId!,
      metadata: {},
      createdByWorkspaceMemberId: input.installedByWorkspaceMemberId || null,
    })

    await insertSkillSourceRefRecord(client, {
      skillId: insertedSkillId,
      sourceCatalogItemId: marketplaceSkill.itemId,
      sourceCatalogVersionId: marketplaceSkill.latestVersionId,
      syncMode: "manual_merge",
      isCustomized: false,
    })

    await incrementSkillCatalogDownloadCount(client, marketplaceSkill.itemId)

    if (input.grants?.length) {
      for (const grant of input.grants) {
        await insertWorkspaceAppGrant(client as any, {
          workspaceId: input.workspaceId,
          workspaceAppId: insertedSkillId,
          target: await resolveAccessGrantTarget({
            workspaceId: input.workspaceId,
            target: grant.target,
          }),
          permissions: grant.permissions,
          conversationTypeMaskOverride:
            grant.conversationTypeMaskOverride ?? null,
          createdByWorkspaceMemberId:
            input.installedByWorkspaceMemberId || null,
          reason: grant.reason ?? null,
        })
      }
    } else if (target) {
      await ensureSkillBinding(client, {
        skillId: insertedSkillId,
        workspaceId: input.workspaceId,
        target,
        createdByWorkspaceMemberId: input.installedByWorkspaceMemberId,
      })
    }

    return {
      skillId: insertedSkillId,
    }
  })

  return getInstalledSkillRecord(input.workspaceId, result.skillId)
}

export async function updateInstalledSkill(input: {
  workspaceId: string
  installedSkillId: string
  name?: string
  description?: CanonicalContentBlockInput
  iconFileId?: string | null
  tags?: string[]
  isEnabled?: boolean
  conversationTypeMaskOverride?: number | null
  attachmentFiles?: SkillAttachmentInput[]
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!existing) {
    throw new SkillError(404, "Installed skill not found")
  }
  if (input.conversationTypeMaskOverride !== undefined) {
    const workspaceConversationTypeMask =
      await getWorkspaceCapabilityConversationTypeMask(
        existing.workspaceId,
        "installed_skill"
      )
    const nextInstanceConversationTypeMask =
      assertConversationTypeMaskWithinParent({
        parentConversationTypeMask: workspaceConversationTypeMask,
        conversationTypeMaskOverride: input.conversationTypeMaskOverride,
        buildError: (message) => new SkillError(400, message),
        invalidMaskMessage:
          "Installed skill conversation policy must allow at least one workspace conversation type.",
      })
    const accessRows = await listSkillAccessRows(input.installedSkillId)
    for (const accessRow of accessRows) {
      await validateConversationScopedAccessTargetDefault({
        target: skillBindingToAccessTarget(accessRow, input.workspaceId),
        effectiveConversationTypeMask: nextInstanceConversationTypeMask,
        buildError: (message) => new SkillError(400, message),
      })
    }
  }

  const currentFilesMap = await loadSkillSnapshotFilesMap([
    existing.currentSnapshotId,
  ])
  const currentFiles = currentFilesMap.get(existing.currentSnapshotId) || []
  const touchesContent =
    input.name !== undefined ||
    input.description !== undefined ||
    input.attachmentFiles !== undefined

  await withSkillsTransaction(async (client) => {
    let nextVersion = existing.currentVersion
    let nextDisplayName = existing.displayName

    if (touchesContent) {
      nextVersion = existing.currentVersion + 1
      nextDisplayName = input.name?.trim() || existing.displayName

      const preparedSnapshot = buildPreparedSnapshotFromInput({
        fallbackName: existing.displayName,
        explicitName: nextDisplayName,
        explicitDescription: input.description,
        files: input.attachmentFiles
          ? normalizeSkillAttachments(input.attachmentFiles)
          : undefined,
        existingSnapshot: {
          frontmatter: frontmatterFromSnapshotRow(existing),
          bodyBlocks: bodyBlocksFromSnapshotRow(existing),
          files: currentFiles,
        },
      })
      const snapshotId = await insertSkillSnapshot(client, preparedSnapshot)
      nextDisplayName = preparedSnapshot.frontmatter.name

      await insertSkillVersionRecord(client, {
        skillId: existing.skillId,
        version: nextVersion,
        skillSnapshotId: snapshotId,
        metadata: existing.versionMetadata,
        createdByWorkspaceMemberId: existing.ownerWorkspaceMemberId || null,
      })

      const nextIconFileId =
        input.iconFileId === undefined
          ? existing.iconFileId
          : input.iconFileId
            ? await normalizeWorkspaceSkillIconFileId(
                input.iconFileId,
                input.workspaceId
              )
            : null
      await updateInstalledSkillContentState(client, {
        skillId: existing.skillId,
        iconFileId: nextIconFileId,
        tags: input.tags || existing.tags || [],
        currentVersion: nextVersion,
        currentSnapshotId: snapshotId,
      })
      await updateWorkspaceAppRoot(client, {
        id: existing.skillId,
        displayName: nextDisplayName,
        status:
          input.isEnabled === undefined
            ? existing.skillStatus === "active"
              ? "active"
              : "disabled"
            : input.isEnabled
              ? "active"
              : "disabled",
      })

      if (existing.sourceCatalogItemId) {
        await markSkillSourceRefCustomized(client, existing.skillId)
      }

      return
    }

    if (
      input.isEnabled !== undefined ||
      input.iconFileId !== undefined ||
      input.tags !== undefined ||
      input.conversationTypeMaskOverride !== undefined
    ) {
      const nextIconFileId =
        input.iconFileId === undefined
          ? existing.iconFileId
          : input.iconFileId
            ? await normalizeWorkspaceSkillIconFileId(
                input.iconFileId,
                input.workspaceId
              )
            : null
      await updateInstalledSkillProfileState(client, {
        skillId: existing.skillId,
        iconFileId: nextIconFileId,
        tags: input.tags === undefined ? existing.tags || [] : input.tags,
      })
      await updateWorkspaceAppRoot(client, {
        id: existing.skillId,
        status:
          input.isEnabled === undefined
            ? existing.skillStatus === "active"
              ? "active"
              : "disabled"
            : input.isEnabled
              ? "active"
              : "disabled",
        conversationTypeMaskOverride:
          input.conversationTypeMaskOverride === undefined
            ? existing.conversationTypeMaskOverride
            : input.conversationTypeMaskOverride,
      })
    }
  })

  return getInstalledSkillRecord(input.workspaceId, input.installedSkillId)
}

export async function upgradeInstalledSkill(input: {
  workspaceId: string
  installedSkillId: string
}) {
  const existing = await loadInstalledSkillForUpdate(
    input.workspaceId,
    input.installedSkillId
  )
  if (!existing) {
    throw new SkillError(404, "Installed skill not found")
  }
  if (!existing.sourceCatalogItemId) {
    throw new SkillError(400, "Installed skill has no marketplace source")
  }

  const marketplaceSkill = await getMarketplaceRowById(
    existing.sourceCatalogItemId
  )
  if (
    !marketplaceSkill ||
    !marketplaceSkill.latestVersionId ||
    !marketplaceSkill.snapshotId
  ) {
    throw new SkillError(400, "Marketplace source has no latest version")
  }

  if (
    existing.sourceCatalogVersionId &&
    existing.sourceCatalogVersionId === marketplaceSkill.latestVersionId
  ) {
    return getInstalledSkillRecord(input.workspaceId, input.installedSkillId)
  }
  const nextSourceVersionId = marketplaceSkill.latestVersionId
  const nextSnapshotId = marketplaceSkill.snapshotId

  await withSkillsTransaction(async (client) => {
    await insertSkillVersionRecord(client, {
      skillId: existing.skillId,
      version: existing.currentVersion + 1,
      skillSnapshotId: nextSnapshotId,
      metadata: existing.versionMetadata,
      createdByWorkspaceMemberId: existing.ownerWorkspaceMemberId || null,
    })

    await updateInstalledSkillMarketplaceState(client, {
      skillId: existing.skillId,
      iconFileId: marketplaceSkill.itemIconFileId,
      tags: marketplaceSkill.itemTags || [],
      currentVersion: existing.currentVersion + 1,
      currentSnapshotId: nextSnapshotId,
    })
    await updateWorkspaceAppRoot(client, {
      id: existing.skillId,
      displayName:
        marketplaceSkill.snapshotDisplayName ||
        marketplaceSkill.itemDisplayName,
    })

    await updateSkillSourceRefVersion(client, {
      skillId: existing.skillId,
      sourceCatalogVersionId: nextSourceVersionId,
      isCustomized: false,
    })
  })

  return getInstalledSkillRecord(input.workspaceId, input.installedSkillId)
}

export async function uninstallInstalledSkill(
  workspaceId: string,
  installedSkillId: string
) {
  const result = await withSkillsTransaction(async (client) => {
    const skill = await getInstalledSkillRowForWorkspace(client, {
      workspaceId,
      installedSkillId,
    })
    if (!skill) {
      return {
        deleted: false,
      }
    }

    // Root lifecycle lives on workspace_apps. The detail row stays until purge.
    await updateWorkspaceAppRoot(client, {
      id: installedSkillId,
      status: "archived",
      deletedAt: new Date(),
    })

    await revokeWorkspaceAppGrantsForApp(client, installedSkillId)

    return {
      deleted: true,
    }
  })

  return result.deleted
}

async function buildVisibilitySubjects(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  conversationId?: string
}) {
  return buildConversationCapabilitySubjectsDefault({
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
}

function visibleRowToAccessRow(
  row: VisibleSkillRow,
  workspaceId: string
): SkillAccessRow {
  return {
    id: row.accessBindingId,
    workspaceId: workspaceId,
    conversationTypeMaskOverride: null,
    status: "active",
    source: "manual",
    createdByWorkspaceMemberId: null,
    reason: null,
    createdAt: row.accessCreatedAt,
    revokedAt: null,
    skillId: row.skillId,
    bindScope: row.accessBindScope,
    actorId: row.actorId,
    conversationId: row.conversationId,
    remoteAgentId: row.remoteAgentId,
    workspaceMemberId: row.workspaceMemberId,
  }
}

export async function listVisibleSkills(input: {
  workspaceId: string
  workspaceMemberId?: string
  actorId?: string
  remoteAgentId?: string
  sessionId?: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
}) {
  const subjects = await buildVisibilitySubjects(input)
  // PR-fix-round-4: compute the scope subject set for this conversation
  // context once and pass it through to every lookupResources call so
  // scoped grants (subject=actor + scope=conversation) show up in the
  // skill list. Without this scoped grants were silently filtered out by
  // listGrantedResourceIds's default "scope IS NULL only" branch.
  const runtimeScopeSubjectIds = await computeRuntimeScopeSubjectIdsDefault({
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
  // P1 fix (post-D4): subject_ids the principal can claim, including the
  // conversation subject when an active participant. Without this,
  // `subject=conversation C` bindings on skills are written + UI-visible
  // but the evaluator never surfaces them to participants of C.
  const runtimeSubjectIds = await computeRuntimeSubjectIdsForVisibilityDefault({
    workspaceId: input.workspaceId,
    workspaceMemberId: input.workspaceMemberId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    conversationId: input.conversationId,
  })
  const autoLoadedSkills = await listAutoLoadedSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    isImConversation: input.isImConversation,
  })
  if (subjects.length === 0) {
    return autoLoadedSkills
  }

  const visibleSkillIds = new Set<string>()
  const lookups = await Promise.all(
    subjects.map((subject) =>
      lookupSkillResourcesDefault({
        subject,
        runtimeScopeSubjectIds,
        runtimeSubjectIds,
      })
    )
  )

  for (const ids of lookups) {
    for (const id of ids) {
      visibleSkillIds.add(id)
    }
  }

  const installedSkills =
    visibleSkillIds.size === 0
      ? []
      : await (async () => {
          const [visibleRows, bindingsBySkillId] = await Promise.all([
            loadVisibleSkillRows(Array.from(visibleSkillIds)),
            loadAccessBindingsBySkillIdsForContext(
              Array.from(visibleSkillIds),
              {
                contextWorkspaceId: input.workspaceId,
                workspaceMemberId: input.workspaceMemberId,
                actorId: input.actorId,
                remoteAgentId: input.remoteAgentId,
                conversationId: input.conversationId,
              }
            ),
          ])
          const workspacePolicyMap =
            await getWorkspaceCapabilityConversationTypePolicyMap(
              visibleRows.map((row) => row.workspaceId)
            )
          // type-key is loop-invariant (a property of the conversation, not the
          // skill binding), so resolve it once and use the pure key check below.
          const conversationTypeKey = resolveConversationTypeKey(
            input.conversationKind,
            input.isImConversation ?? false
          )

          const deduped = new Map<string, VisibleSkillRow>()
          for (const row of visibleRows) {
            const workspaceConversationTypeMask =
              workspacePolicyMap.get(row.workspaceId)?.installed_skill ||
              DEFAULT_CONVERSATION_TYPE_MASK
            const instanceConversationTypeMask =
              resolveInstalledSkillEffectiveConversationTypeMask({
                workspaceConversationTypeMask,
                conversation_type_mask_override:
                  row.conversationTypeMaskOverride,
              })
            const bindings = (bindingsBySkillId.get(row.skillId) || []).filter(
              (binding) =>
                maskAllowsConversationTypeKey(
                  resolveNarrowedConversationTypeMask(
                    instanceConversationTypeMask,
                    binding.conversationTypeMaskOverride
                  ),
                  conversationTypeKey
                )
            )
            if (bindings.length === 0) {
              continue
            }
            const chosenBinding = [...bindings].sort(
              compareVisibleBindingPriority
            )[0]
            const candidate: VisibleSkillRow = {
              ...row,
              accessBindingId: chosenBinding?.id || row.accessBindingId,
              accessBindScope: chosenBinding?.bindScope || "workspace",
              conversationId: chosenBinding?.conversationId || null,
              actorId: chosenBinding?.actorId || null,
              remoteAgentId: chosenBinding?.remoteAgentId || null,
              workspaceMemberId: chosenBinding?.workspaceMemberId || null,
              accessCreatedAt: chosenBinding?.createdAt || row.accessCreatedAt,
            }
            const existing = deduped.get(row.skillId)
            if (!existing) {
              deduped.set(row.skillId, candidate)
              continue
            }
            if (
              compareVisibleBindingPriority(
                visibleRowToAccessRow(candidate, input.workspaceId),
                visibleRowToAccessRow(existing, input.workspaceId)
              ) < 0
            ) {
              deduped.set(row.skillId, candidate)
            }
          }

          return Array.from(deduped.values()).map(buildAvailableSkillPayload)
        })()

  const combined = new Map<string, AvailableSkillSummary>()
  for (const skill of installedSkills) {
    combined.set(skill.instanceId, skill)
  }
  for (const skill of autoLoadedSkills) {
    if (!combined.has(skill.instanceId)) {
      combined.set(skill.instanceId, skill)
    }
  }

  return Array.from(combined.values()).sort(compareAvailableSkillDiscoveryOrder)
}

export async function readVisibleSkill(input: {
  workspaceId: string
  actorId?: string
  remoteAgentId?: string
  sessionId?: string
  conversationId?: string
  conversationKind?: "direct" | "group"
  isImConversation?: boolean
  skillInstanceId: string
  assetPath?: string
}) {
  const visibleSkills = await listVisibleSkills({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    remoteAgentId: input.remoteAgentId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    isImConversation: input.isImConversation,
  })

  const skillInstanceId = input.skillInstanceId.trim()
  const match = visibleSkills.find(
    (skill) => skill.instanceId === skillInstanceId
  )

  if (!match) {
    throw new SkillError(
      404,
      `Visible skill instance "${input.skillInstanceId}" not found`
    )
  }

  const installedSkill = await loadInstalledSkillById(match.instanceId)
  if (!installedSkill) {
    throw new SkillError(
      404,
      `Visible skill instance "${input.skillInstanceId}" not found`
    )
  }

  if (!input.assetPath) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    })
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    }
  }

  const targetPath = normalizePath(input.assetPath)
  if (targetPath === SKILL_ENTRY_PATH) {
    const synthetic = buildSyntheticEntryFile({
      frontmatter: frontmatterFromSnapshotRow(installedSkill),
      bodyBlocks: bodyBlocksFromSnapshotRow(installedSkill),
    })
    return {
      skill: match,
      asset: {
        path: synthetic.path,
        textContent: renderSkillBlocksToText(synthetic.contentBlocks),
        contentBlocks: synthetic.contentBlocks,
      },
    }
  }

  const asset = await loadSkillSnapshotFileByPath(
    installedSkill.currentSnapshotId,
    targetPath
  )
  if (!asset) {
    throw new SkillError(404, `Skill attachment "${targetPath}" not found`)
  }

  const contentBlocks = normalizeStoredBlocks(asset.contentBlocks)
  return {
    skill: match,
    asset: {
      path: asset.path,
      textContent: renderSkillBlocksToText(contentBlocks),
      contentBlocks,
    },
  }
}
