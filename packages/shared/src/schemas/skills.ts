import { z } from "zod"
import {
  CAPABILITY_ACCESS_TARGET_TYPES,
  SKILL_FRONTMATTER_EFFORTS,
  SKILL_MIRROR_SYNC_STATUSES,
  SKILL_SOURCE_TYPES,
} from "../constants/enums.js"
import { SUBJECT_KIND } from "../access/enums.js"
import type {
  CanonicalContentBlock,
  CanonicalContentBlockInput,
} from "../types/index.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for skill routes.
 *
 * The skill payload trees are owned by the existing skill presenter and shared
 * TS types. These schemas validate the app-facing envelope and item shape so
 * response casing / timestamp / nested payload drift is caught at the route
 * boundary instead of being hidden behind `z.unknown()`.
 */

const conversationTypeMaskSchema = z.number().int().min(1).max(15)
const anyConversationTypeMaskSchema = z.number().int().min(1)
const SkillContentBlockInputSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlockInput>
const SkillContentBlockSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlock>

const SkillSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    workspaceMemberId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.ACTOR),
    actorId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.USER),
    userId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.EXTERNAL),
    workspaceId: z.uuid(),
    transportAddressId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.PLATFORM),
  }),
])

const SkillAccessTargetSchema = z.object({
  subject: SkillSubjectRefSchema,
  scope: SkillSubjectRefSchema.optional(),
})

export const SkillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  disableModelInvocation: z.boolean(),
  userInvocable: z.boolean(),
  allowedTools: z.array(z.string()),
  model: z.string().optional(),
  effort: z.enum(SKILL_FRONTMATTER_EFFORTS).optional(),
  context: z.literal("fork").optional(),
  agent: z.string().optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
})
export type SkillFrontmatterView = z.infer<typeof SkillFrontmatterSchema>

export const SkillMirrorSourceSummarySchema = z.object({
  id: z.uuid(),
  sourceType: z.enum(SKILL_SOURCE_TYPES),
  locatorKey: z.string(),
  locator: z.record(z.string(), z.unknown()),
  requestedRef: z.string().optional(),
  resolvedRevision: z.string().optional(),
  refreshMode: z.literal("manual"),
  lastSyncStatus: z.enum(SKILL_MIRROR_SYNC_STATUSES),
  sourceWarnings: z.array(z.string()),
  lastError: z.string().optional(),
  lastSyncedAt: IsoInstantStringSchema.optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type SkillMirrorSourceSummaryView = z.infer<
  typeof SkillMirrorSourceSummarySchema
>

export const SkillAttachmentFileSchema = z.object({
  id: z.string(),
  path: z.string(),
  mediaType: z.string().optional(),
  contentBlocks: z.array(SkillContentBlockSchema),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type SkillAttachmentFileView = z.infer<typeof SkillAttachmentFileSchema>

export const SkillMarketplaceVersionSchema = z.object({
  id: z.uuid(),
  skillId: z.uuid(),
  version: z.string(),
  changelog: z.string(),
  frontmatter: SkillFrontmatterSchema,
  bodyBlocks: z.array(SkillContentBlockSchema),
  entryPath: z.string(),
  contentHash: z.string(),
  sourceWarnings: z.array(z.string()),
  resolvedRevision: z.string().optional(),
  description: SkillContentBlockSchema,
  defaultConversationTypeMask: anyConversationTypeMaskSchema.optional(),
  createdByUserId: z.uuid().optional(),
  createdByName: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  files: z.array(SkillAttachmentFileSchema).optional(),
  attachmentFiles: z.array(SkillAttachmentFileSchema).optional(),
})
export type SkillMarketplaceVersionView = z.infer<
  typeof SkillMarketplaceVersionSchema
>

export const SkillMarketplaceWorkspaceInstallationSchema = z.object({
  installed: z.boolean(),
  installedSkillId: z.uuid().optional(),
  installedCount: z.number().int().nonnegative(),
})
export type SkillMarketplaceWorkspaceInstallationView = z.infer<
  typeof SkillMarketplaceWorkspaceInstallationSchema
>

export const SkillMarketplaceEntrySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  frontmatter: SkillFrontmatterSchema,
  bodyBlocks: z.array(SkillContentBlockSchema),
  description: SkillContentBlockSchema,
  iconUrl: z.string().optional(),
  tags: z.array(z.string()),
  authorUserId: z.uuid().optional(),
  authorName: z.string().optional(),
  isActive: z.boolean(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  defaultConversationTypeMask: anyConversationTypeMaskSchema.optional(),
  latestVersionId: z.uuid().optional(),
  latestVersion: SkillMarketplaceVersionSchema.optional(),
  mirrorSource: SkillMirrorSourceSummarySchema.optional(),
  workspaceInstallation: SkillMarketplaceWorkspaceInstallationSchema.optional(),
})
export type SkillMarketplaceEntryView = z.infer<
  typeof SkillMarketplaceEntrySchema
>

export const InstalledSkillSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  displayName: z.string(),
  frontmatter: SkillFrontmatterSchema,
  bodyBlocks: z.array(SkillContentBlockSchema),
  entryPath: z.string(),
  contentHash: z.string(),
  sourceWarnings: z.array(z.string()),
  description: SkillContentBlockSchema,
  iconUrl: z.string().optional(),
  tags: z.array(z.string()),
  accessTarget: SkillAccessTargetSchema,
  isEnabled: z.boolean(),
  sourceDefaultConversationTypeMask: anyConversationTypeMaskSchema.optional(),
  workspaceConversationTypeMask: anyConversationTypeMaskSchema,
  conversationTypeMaskOverride: anyConversationTypeMaskSchema.optional(),
  effectiveConversationTypeMask: anyConversationTypeMaskSchema,
  isCustomized: z.boolean(),
  ownerWorkspaceMemberId: z.uuid().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  sourceSkillId: z.uuid().optional(),
  sourcePackageSlug: z.string().optional(),
  sourceVersionId: z.uuid().optional(),
  sourceVersion: z.string().optional(),
  upgradeAvailable: z.boolean(),
  latestSourceVersion: z.string().optional(),
  files: z.array(SkillAttachmentFileSchema).optional(),
  attachmentFiles: z.array(SkillAttachmentFileSchema).optional(),
  mirrorSource: SkillMirrorSourceSummarySchema.optional(),
})
export type InstalledSkillView = z.infer<typeof InstalledSkillSchema>

export const SkillMarketplaceListViewSchema = z.object({
  skills: z.array(SkillMarketplaceEntrySchema),
})
export type SkillMarketplaceListView = z.infer<
  typeof SkillMarketplaceListViewSchema
>

export const SkillMarketplaceItemViewSchema = z.object({
  skill: SkillMarketplaceEntrySchema,
})
export type SkillMarketplaceItemView = z.infer<
  typeof SkillMarketplaceItemViewSchema
>

export const InstalledSkillListViewSchema = z.object({
  skills: z.array(InstalledSkillSchema),
})
export type InstalledSkillListView = z.infer<
  typeof InstalledSkillListViewSchema
>

export const InstalledSkillItemViewSchema = z.object({
  skill: InstalledSkillSchema,
})
export type InstalledSkillItemView = z.infer<
  typeof InstalledSkillItemViewSchema
>

export const SkillAttachmentInputSchema = z.object({
  path: z.string().min(1),
  contentBlocks: z.array(SkillContentBlockInputSchema).default([]),
  mediaType: z.string().min(1).optional(),
})
export type SkillAttachmentInput = z.infer<typeof SkillAttachmentInputSchema>

export const PublishMarketplaceSkillInputSchema = z.object({
  skillId: z.uuid().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: SkillContentBlockInputSchema.optional(),
  iconFileId: z.uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().min(1),
  changelog: z.string().optional(),
  isActive: z.boolean().optional(),
  defaultConversationTypeMask: conversationTypeMaskSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachmentFiles: z.array(SkillAttachmentInputSchema).optional(),
})
export type PublishMarketplaceSkillInput = z.infer<
  typeof PublishMarketplaceSkillInputSchema
>

export const ImportMarketplaceSkillInputSchema = z.discriminatedUnion(
  "sourceType",
  [
    z.object({
      sourceType: z.literal("github"),
      repoUrl: z.url(),
      path: z.string().min(1),
      ref: z.string().trim().min(1).optional(),
    }),
    z.object({
      sourceType: z.literal("clawhub"),
      ownerId: z.string().trim().min(1).optional(),
      slug: z.string().trim().min(1),
      version: z.string().trim().min(1).optional(),
    }),
  ]
)
export type ImportMarketplaceSkillInput = z.infer<
  typeof ImportMarketplaceSkillInputSchema
>

const MarketplaceTagsQuerySchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (typeof value === "undefined") return undefined
    const rawTags = Array.isArray(value) ? value : value.split(",")
    const tags = rawTags.map((tag) => tag.trim()).filter(Boolean)
    return tags.length > 0 ? tags : undefined
  })

export const SkillMarketplaceListQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  tags: MarketplaceTagsQuerySchema,
  workspaceId: z.uuid().optional(),
})
export type SkillMarketplaceListQuery = z.input<
  typeof SkillMarketplaceListQuerySchema
>
export type SkillMarketplaceListParsedQuery = z.output<
  typeof SkillMarketplaceListQuerySchema
>

export const SkillMarketplaceItemQuerySchema = z.object({
  workspaceId: z.uuid().optional(),
})
export type SkillMarketplaceItemQuery = z.infer<
  typeof SkillMarketplaceItemQuerySchema
>

export const InstalledSkillListQuerySchema = z
  .strictObject({
    accessTargetType: z.enum(CAPABILITY_ACCESS_TARGET_TYPES).optional(),
    actorId: z.uuid().optional(),
    remoteAgentId: z.uuid().optional(),
    // workspace_member filter mode needs the id to resolve a SubjectRef.
    workspaceMemberId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    sourceSkillId: z.uuid().optional(),
  })
  .superRefine((query, ctx) => {
    const requiredIdByTargetType = {
      workspace_member: "workspaceMemberId",
      conversation: "conversationId",
      actor: "actorId",
      remote_agent: "remoteAgentId",
    } as const
    const requiredField =
      query.accessTargetType &&
      requiredIdByTargetType[
        query.accessTargetType as keyof typeof requiredIdByTargetType
      ]
    if (requiredField && !query[requiredField]) {
      ctx.addIssue({
        code: "custom",
        path: [requiredField],
        message: `${requiredField} is required for ${query.accessTargetType} access target filters`,
      })
    }
  })
export type InstalledSkillListQuery = z.infer<
  typeof InstalledSkillListQuerySchema
>
