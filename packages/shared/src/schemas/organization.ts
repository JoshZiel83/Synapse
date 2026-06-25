import { z } from "zod"
import { IsoInstantStringSchema } from "./datetime.js"
import {
  ACTOR_DOC_CHANGED_FIELDS,
  ACTOR_DOC_VISIBILITIES,
  ACTOR_PACKAGE_DEPENDENCY_KINDS,
  ACTOR_PACKAGE_LINK_STATUSES,
  ACTOR_PACKAGE_SYNC_MODES,
  ACTOR_PACKAGE_TARGET_KINDS,
  ACTOR_ROLES,
  ACTOR_UPDATE_SOURCE_TYPES,
  ACTOR_VERSION_CHANGED_FIELDS,
  ACTOR_VERSION_DOC_CHANGE_TYPES,
  MARKETPLACE_ASSET_KINDS,
  MARKETPLACE_ITEM_KINDS,
  MARKETPLACE_SOURCE_TYPES,
  MARKETPLACE_VERSION_STATUSES,
  PLUGIN_SPEC_TRANSPORTS,
  REUSE_SCOPES,
} from "../constants/enums.js"
import { ActorDocSchema } from "./actor-docs.js"
import { PersistedCanonicalContentBlockSchema } from "./chat-content-block.js"
import {
  MarketplaceRequirementCheckSchema,
  McpValidationRuleSchema,
  PluginAuthBindingDefinitionSchema,
  PluginConfigFieldDefinitionSchema,
  PluginInstallFlowSchema,
  PluginInstallStepSchema,
} from "./mcp-plugins.js"
import {
  WorkspaceResourceGrantEntrySchema,
  WorkspaceResourceGrantTargetSchema,
  WorkspaceResourceGrantTargetSubjectSchema,
  type WorkspaceResourceGrantTargetInput,
} from "./workspace-resources.js"

/**
 * App-facing contracts for the organization (actor) module's APP routes
 * (master plan §5.3). Every organization route is workspace-scoped +
 * authenticated, so its response value is wrapped through `appRoute` →
 * `sendData` → `{ data: ... }`. These schemas describe the value each handler
 * returns (the helper wraps it in `{ data }`).
 *
 * Top-level scalar fields are modeled explicitly. Actor package marketplace
 * responses are also validated structurally because service and web consumers
 * read fields such as `package.displayName`, `manifest.actor`, and
 * `sourceLink.status`. Genuinely open author/runtime payloads remain open
 * records at the specific field that owns that extensibility.
 */

const openRecordSchema = z.record(z.string(), z.unknown())
const localizedTextSchema = z.record(z.string(), z.string())
const actorPackageKindSchema = z.enum(MARKETPLACE_ITEM_KINDS)
const actorPackageSourceTypeSchema = z.enum(MARKETPLACE_SOURCE_TYPES)
const marketplaceVersionStatusSchema = z.enum(MARKETPLACE_VERSION_STATUSES)
const marketplaceAssetKindSchema = z.enum(MARKETPLACE_ASSET_KINDS)
const actorPackageDependencyKindSchema = z.enum(ACTOR_PACKAGE_DEPENDENCY_KINDS)
const actorPackageDependencyTargetKindSchema = z.enum(
  ACTOR_PACKAGE_TARGET_KINDS
)
const actorUpdateSourceTypeSchema = z.enum(ACTOR_UPDATE_SOURCE_TYPES)
const actorVersionChangedFieldSchema = z.enum(ACTOR_VERSION_CHANGED_FIELDS)
const actorDocChangedFieldSchema = z.enum(ACTOR_DOC_CHANGED_FIELDS)
const actorPackageLinkStatusSchema = z.enum(ACTOR_PACKAGE_LINK_STATUSES)

export const ActorDefinitionSchema = z.object({
  displayName: z.string(),
  role: z.enum(ACTOR_ROLES),
  title: z.string(),
  avatarFileId: z.uuid().optional(),
  avatarEmoji: z.string().optional(),
  parentId: z.uuid().optional(),
  canRepresentUser: z.boolean(),
  docs: z.array(ActorDocSchema),
  specialties: z.array(z.string()),
  config: openRecordSchema,
})
export type ActorDefinitionView = z.infer<typeof ActorDefinitionSchema>

export const ActorPackageManifestSchema = z.object({
  actor: ActorDefinitionSchema,
  setupGuide: z.array(PersistedCanonicalContentBlockSchema),
  releaseNotes: z.array(PersistedCanonicalContentBlockSchema),
})
export type ActorPackageManifestView = z.infer<
  typeof ActorPackageManifestSchema
>

const MarketplacePublisherSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  logoUrl: z.string().optional(),
  isBuiltin: z.boolean(),
  isVerified: z.boolean(),
  ownerUserId: z.uuid().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})

const MarketplaceVersionSchema = z.object({
  id: z.uuid(),
  packageId: z.uuid(),
  version: z.string(),
  status: marketplaceVersionStatusSchema,
  manifest: openRecordSchema,
  configSchema: openRecordSchema,
  configFields: z.array(PluginConfigFieldDefinitionSchema),
  defaultConfig: openRecordSchema,
  transport: z.enum(PLUGIN_SPEC_TRANSPORTS).optional(),
  entryPoint: z.string().optional(),
  toolsManifest: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: openRecordSchema,
    })
  ),
  validationRules: z.array(McpValidationRuleSchema),
  setupSteps: z.array(PluginInstallStepSchema),
  installFlow: PluginInstallFlowSchema.optional(),
  authBindings: z.array(PluginAuthBindingDefinitionSchema),
  metadata: openRecordSchema,
  createdByUserId: z.uuid().optional(),
  createdAt: IsoInstantStringSchema,
  assets: z
    .array(
      z.object({
        id: z.uuid(),
        revisionId: z.uuid(),
        path: z.string(),
        assetKind: marketplaceAssetKindSchema,
        mediaType: z.string().optional(),
        sizeBytes: z.number().int().nonnegative(),
        sha256: z.string(),
        textContent: z.string().optional(),
        metadata: openRecordSchema,
        createdAt: IsoInstantStringSchema,
      })
    )
    .optional(),
})

const MarketplaceItemSchema: z.ZodType = z.lazy(() =>
  z.object({
    id: z.uuid(),
    publisherId: z.uuid(),
    workspaceId: z.uuid().optional(),
    kind: actorPackageKindSchema,
    slug: z.string(),
    displayName: z.string(),
    displayNameI18n: localizedTextSchema.optional(),
    description: z.string(),
    descriptionI18n: localizedTextSchema.optional(),
    longDescription: z.string(),
    longDescriptionI18n: localizedTextSchema.optional(),
    summaryI18n: localizedTextSchema.optional(),
    defaultLocale: z.string().optional(),
    iconUrl: z.string().optional(),
    sourceType: actorPackageSourceTypeSchema,
    tags: z.array(z.string()),
    isActive: z.boolean(),
    isBuiltin: z.boolean(),
    downloadCount: z.number().int().nonnegative(),
    latestRevisionId: z.uuid().optional(),
    defaultReuseScope: z.enum(REUSE_SCOPES).optional(),
    requiresHandshake: z.boolean(),
    metadata: openRecordSchema,
    createdAt: IsoInstantStringSchema,
    updatedAt: IsoInstantStringSchema,
    publisher: MarketplacePublisherSchema.optional(),
    latestRevision: MarketplaceVersionSchema.optional(),
  })
)

const ActorPackageDependencySchema = z.object({
  requirementId: z.string().optional(),
  requirementKind: actorPackageDependencyKindSchema,
  targetPackageKind: actorPackageDependencyTargetKindSchema,
  targetPublisherSlug: z.string().optional(),
  targetPackageSlug: z.string(),
  acceptableReuseScopes: z.array(z.enum(REUSE_SCOPES)),
  description: z.string(),
  notes: z.array(PersistedCanonicalContentBlockSchema),
  metadata: openRecordSchema,
})

export const ActorPackageSourceLinkSchema = z.object({
  actorId: z.uuid(),
  packageId: z.uuid(),
  importedRevisionId: z.uuid(),
  packageSlug: z.string(),
  packageDisplayName: z.string(),
  packagePublisherSlug: z.string().optional(),
  packagePublisherDisplayName: z.string().optional(),
  importedVersion: z.string().optional(),
  latestRevisionId: z.uuid().optional(),
  latestVersion: z.string().optional(),
  baselineActorVersion: z.number().int().positive(),
  syncMode: z.enum(ACTOR_PACKAGE_SYNC_MODES),
  hasLocalChanges: z.boolean(),
  hasUpstreamUpdate: z.boolean(),
  status: actorPackageLinkStatusSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type ActorPackageSourceLinkView = z.infer<
  typeof ActorPackageSourceLinkSchema
>

/** Single actor (Actor). `definition` / `sourceLink` are open domain views. */
export const ActorViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  displayName: z.string(),
  packageId: z.uuid().optional(),
  packageInstanceId: z.uuid().optional(),
  definition: ActorDefinitionSchema,
  avatarUrl: z.string().optional(),
  currentVersion: z.number(),
  sourceLink: ActorPackageSourceLinkSchema.optional(),
  isActive: z.boolean(),
  isPublicShared: z.boolean(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type ActorView = z.infer<typeof ActorViewSchema>
export const ActorListViewSchema = z.array(ActorViewSchema)
export type ActorListView = z.infer<typeof ActorListViewSchema>

/**
 * Org tree node (ActorTreeNode = Actor + recursive `children`). The actor
 * fields mirror {@link ActorViewSchema}; `children` recurses via a lazy ref.
 */
export type ActorTreeNodeView = ActorView & {
  children: ActorTreeNodeView[]
}
export const ActorTreeNodeViewSchema: z.ZodType<ActorTreeNodeView> = z.lazy(
  () =>
    ActorViewSchema.extend({
      children: z.array(ActorTreeNodeViewSchema),
    })
)
export const ActorTreeViewSchema = z.array(ActorTreeNodeViewSchema)
export type ActorTreeView = z.infer<typeof ActorTreeViewSchema>

const ActorVersionSourceSchema = z.object({
  type: actorUpdateSourceTypeSchema,
  workspaceMemberId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  turnId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  reason: z.string().optional(),
})

const ActorVersionFieldChangeSchema = z.object({
  kind: z.literal("field"),
  field: actorVersionChangedFieldSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  summary: z.array(PersistedCanonicalContentBlockSchema),
})

const ActorVersionDocFieldChangeSchema = z.object({
  field: actorDocChangedFieldSchema,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  beforeSummaryText: z.string().optional(),
  afterSummaryText: z.string().optional(),
})

const ActorVersionDocChangeSchema = z.object({
  kind: z.literal("doc"),
  docId: z.uuid(),
  key: z.string(),
  title: z.string(),
  changeType: z.enum(ACTOR_VERSION_DOC_CHANGE_TYPES),
  visibility: z.enum(ACTOR_DOC_VISIBILITIES),
  priority: z.number(),
  fieldChanges: z.array(ActorVersionDocFieldChangeSchema),
  summary: z.array(PersistedCanonicalContentBlockSchema),
})

export const ActorVersionDeltaSchema = z.object({
  fromVersion: z.number().int().nonnegative(),
  toVersion: z.number().int().positive(),
  source: ActorVersionSourceSchema.optional(),
  changes: z.array(
    z.discriminatedUnion("kind", [
      ActorVersionFieldChangeSchema,
      ActorVersionDocChangeSchema,
    ])
  ),
  summary: z.array(PersistedCanonicalContentBlockSchema),
})

/**
 * Actor version (ActorVersion). `delta` and `source` are structured app history
 * views; individual field `before` / `after` values stay opaque.
 */
export const ActorVersionViewSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid(),
  version: z.number(),
  previousVersionId: z.uuid().optional(),
  snapshot: ActorDefinitionSchema,
  delta: ActorVersionDeltaSchema.optional(),
  createdByWorkspaceMemberId: z.uuid().optional(),
  source: ActorVersionSourceSchema.optional(),
  createdAt: IsoInstantStringSchema,
})
export type ActorVersionView = z.infer<typeof ActorVersionViewSchema>
export const ActorVersionListViewSchema = z.array(ActorVersionViewSchema)
export type ActorVersionListView = z.infer<typeof ActorVersionListViewSchema>

/**
 * Actor package record (ActorPackageRecord). The marketplace `package`,
 * `manifest`, dependency, and requirement-check trees are open presentation
 * views owned by the marketplace presenter.
 */
export const ActorPackageRecordViewSchema = z.object({
  package: MarketplaceItemSchema,
  manifest: ActorPackageManifestSchema,
  dependencies: z.array(ActorPackageDependencySchema),
  requirementChecks: z.array(MarketplaceRequirementCheckSchema).optional(),
})
export type ActorPackageRecordView = z.infer<
  typeof ActorPackageRecordViewSchema
>
export const ActorPackageListViewSchema = z.array(ActorPackageRecordViewSchema)
export type ActorPackageListView = z.infer<typeof ActorPackageListViewSchema>

/**
 * Install-package result (ActorPackageInstallResult): the created `actor`
 * (an Actor view) plus the open source package/link and requirement checks.
 */
export const ActorPackageInstallResultViewSchema = z.object({
  actor: ActorViewSchema,
  sourcePackage: ActorPackageRecordViewSchema,
  sourceLink: ActorPackageSourceLinkSchema,
  requirementChecks: z.array(MarketplaceRequirementCheckSchema),
})
export type ActorPackageInstallResultView = z.infer<
  typeof ActorPackageInstallResultViewSchema
>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────

/** GET actor packages query. */
export const ActorPackageListQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
})
export type ActorPackageListQuery = z.infer<typeof ActorPackageListQuerySchema>

/** Subject ref for an actor-package initial grant target (app input). */
export const ActorPackageInitialGrantSubjectSchema =
  WorkspaceResourceGrantTargetSubjectSchema

/** `{ subject, scope? }` target for an actor-package initial grant. */
export const ActorPackageInitialGrantTargetSchema =
  WorkspaceResourceGrantTargetSchema
export type ActorPackageInitialGrantTargetInput =
  WorkspaceResourceGrantTargetInput

/** A single initial grant in the actor-package install body. */
export const ActorPackageInitialGrantSchema = WorkspaceResourceGrantEntrySchema
export type ActorPackageInitialGrantInput = z.infer<
  typeof ActorPackageInitialGrantSchema
>

/** Install actor package request body. */
export const ActorPackageInstallInputSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  title: z.string().max(255).optional(),
  parentId: z.uuid().nullable().optional(),
  syncMode: z.enum(ACTOR_PACKAGE_SYNC_MODES).optional(),
  grants: z.array(ActorPackageInitialGrantSchema).optional(),
})
export type ActorPackageInstallInput = z.infer<
  typeof ActorPackageInstallInputSchema
>
