import { z } from "zod"
import {
  WORKSPACE_RESOURCE_KINDS,
  WORKSPACE_RESOURCE_STATUSES,
  WORKSPACE_RESOURCE_GRANT_PERMISSIONS,
  WORKSPACE_RESOURCE_GRANT_SOURCES,
  WORKSPACE_RESOURCE_GRANT_STATUSES,
  WORKSPACE_RESOURCE_GRANT_REQUEST_STATUSES,
  WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS,
  WORKSPACE_RESOURCE_KIND,
  SUBJECT_KIND,
} from "../access/enums.js"
import {
  ACTOR_ROLES,
  REMOTE_AGENT_RUNTIME_KINDS,
  REUSE_SCOPES,
} from "../constants/enums.js"
import type { CanonicalContentBlockInput } from "../types/index.js"
import { ActorDocInputSchema } from "./actor-docs.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"
import { SkillAttachmentInputSchema } from "./skills.js"

/**
 * App-facing camelCase contracts for the workspace-resources module's APP routes
 * (master plan §5.3). workspace-resources is a Tier-A app-facing module: every route
 * is workspace-scoped + authenticated, so each handler's returned value is
 * wrapped through `appRoute` → `sendData` → `{ data: ... }`. These schemas
 * describe the value each handler returns (the helper wraps it).
 *
 * Top-level scalar/enum fields are modeled explicitly. The `target` / `grantee`
 * fields are `CapabilityAccessTarget` discriminated `{ subject, scope? }`
 * payloads the presenter shapes from joined rows and web clients read
 * structurally, so the response schema validates them instead of treating them
 * as opaque passthrough.
 */

/** Subject ref for a workspace-resource grant target (app contract, camelCase). */
export const WorkspaceResourceGrantTargetSubjectSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal(SUBJECT_KIND.WORKSPACE),
      workspaceId: z.uuid(),
    }),
    z.object({
      kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
      memberId: z.uuid(),
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
  ]
)

/** `{ subject, scope? }` target for a workspace-resource grant. */
export const WorkspaceResourceGrantTargetSchema = z.object({
  subject: WorkspaceResourceGrantTargetSubjectSchema,
  scope: z
    .object({
      kind: z.literal(SUBJECT_KIND.CONVERSATION),
      conversationId: z.uuid(),
    })
    .optional(),
})
export type WorkspaceResourceGrantTargetInput = z.infer<
  typeof WorkspaceResourceGrantTargetSchema
>

/** GET/POST/PUT workspace-resource inventory item (presentWorkspaceResource). */
export const WorkspaceResourceViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: z.enum(WORKSPACE_RESOURCE_KINDS),
  displayName: z.string(),
  ownerWorkspaceMemberId: z.uuid().optional(),
  status: z.enum(WORKSPACE_RESOURCE_STATUSES),
  sourceDefaultConversationTypeMask: z.number().int().optional(),
  workspaceConversationTypeMask: z.number().int().optional(),
  conversationTypeMaskOverride: z.number().int().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceResourceViewSchemaType = z.infer<
  typeof WorkspaceResourceViewSchema
>

/** GET/PUT workspace-resource grant (presentGrant). */
export const WorkspaceResourceGrantViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceResourceId: z.uuid(),
  target: WorkspaceResourceGrantTargetSchema,
  permissions: z.array(z.enum(WORKSPACE_RESOURCE_GRANT_PERMISSIONS)),
  status: z.enum(WORKSPACE_RESOURCE_GRANT_STATUSES),
  source: z.enum(WORKSPACE_RESOURCE_GRANT_SOURCES),
  grantedByWorkspaceMemberId: z.uuid().optional(),
  reason: z.string().optional(),
  conversationTypeMaskOverride: z.number().int().nullable().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  revokedAt: IsoInstantStringSchema.optional(),
})
export type WorkspaceResourceGrantViewSchemaType = z.infer<
  typeof WorkspaceResourceGrantViewSchema
>

/** GET/POST workspace-resource grant request (presentGrantRequest). */
export const WorkspaceResourceGrantRequestViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceResourceId: z.uuid(),
  grantee: WorkspaceResourceGrantTargetSchema,
  requestedPermissions: z.array(z.enum(WORKSPACE_RESOURCE_GRANT_PERMISSIONS)),
  requesterWorkspaceMemberId: z.uuid(),
  status: z.enum(WORKSPACE_RESOURCE_GRANT_REQUEST_STATUSES),
  resolvedByWorkspaceMemberId: z.uuid().optional(),
  resolvedAt: IsoInstantStringSchema.optional(),
  reason: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceResourceGrantRequestViewSchemaType = z.infer<
  typeof WorkspaceResourceGrantRequestViewSchema
>

/** Single workspace-resource response body. */
export const WorkspaceResourceEnvelopeViewSchema = z.object({
  resource: WorkspaceResourceViewSchema,
})
export type WorkspaceResourceEnvelopeViewSchemaType = z.infer<
  typeof WorkspaceResourceEnvelopeViewSchema
>

/** Workspace-resource collection response body. */
export const WorkspaceResourceListViewSchema = z.object({
  resources: z.array(WorkspaceResourceViewSchema),
})
export type WorkspaceResourceListViewSchemaType = z.infer<
  typeof WorkspaceResourceListViewSchema
>

/** Workspace-resource grant collection response body. */
export const WorkspaceResourceGrantListViewSchema = z.object({
  grants: z.array(WorkspaceResourceGrantViewSchema),
})
export type WorkspaceResourceGrantListViewSchemaType = z.infer<
  typeof WorkspaceResourceGrantListViewSchema
>

/** Workspace-resource grant-request collection response body. */
export const WorkspaceResourceGrantRequestListViewSchema = z.object({
  requests: z.array(WorkspaceResourceGrantRequestViewSchema),
})
export type WorkspaceResourceGrantRequestListViewSchemaType = z.infer<
  typeof WorkspaceResourceGrantRequestListViewSchema
>

/** Single workspace-resource grant-request response body. */
export const WorkspaceResourceGrantRequestEnvelopeViewSchema = z.object({
  request: WorkspaceResourceGrantRequestViewSchema,
})
export type WorkspaceResourceGrantRequestEnvelopeViewSchemaType = z.infer<
  typeof WorkspaceResourceGrantRequestEnvelopeViewSchema
>

/** Mutating workspace-resource response body for boolean outcomes. */
export const WorkspaceResourceSuccessViewSchema = z.object({
  success: z.boolean(),
})
export type WorkspaceResourceSuccessViewSchemaType = z.infer<
  typeof WorkspaceResourceSuccessViewSchema
>

// ───────────────────────── request/query DTOs (§5.1.1) ───────────────────────
// App-facing request bodies and query DTOs for the workspace-resources APP routes.
// Single-sourced here so the API parser and the web/mobile clients share one
// definition.
// The grant `target` is the camelCase app-input subject/scope ref the route
// maps into a CapabilityAccessTarget; the controller keeps that mapping helper
// and types it via z.infer<typeof WorkspaceResourceGrantTargetSchema>.

const conversationTypeMaskSchema = z.number().int().min(1).max(15)

/** GET workspace-resources query. */
export const WorkspaceResourceListQuerySchema = z.object({
  kind: z.enum(WORKSPACE_RESOURCE_KINDS).optional(),
})
export type WorkspaceResourceListQuery = z.infer<
  typeof WorkspaceResourceListQuerySchema
>

/** GET workspace-resources/discover query. */
export const WorkspaceResourceDiscoverQuerySchema = z.object({
  conversationId: z.uuid().optional(),
})
export type WorkspaceResourceDiscoverQuery = z.infer<
  typeof WorkspaceResourceDiscoverQuerySchema
>

/** A single grant entry in create/replace-grants bodies. */
export const WorkspaceResourceGrantEntrySchema = z.object({
  target: WorkspaceResourceGrantTargetSchema,
  permissions: z.array(z.enum(WORKSPACE_RESOURCE_GRANT_PERMISSIONS)).min(1),
  conversationTypeMaskOverride: conversationTypeMaskSchema
    .nullable()
    .optional(),
  reason: z.string().trim().min(1).optional(),
})
export type WorkspaceResourceGrantEntryInput = z.infer<
  typeof WorkspaceResourceGrantEntrySchema
>

/** PUT workspace-resources/:id/grants body. */
export const ReplaceWorkspaceResourceGrantsInputSchema = z.object({
  grants: z.array(WorkspaceResourceGrantEntrySchema),
})
export type ReplaceWorkspaceResourceGrantsInput = z.infer<
  typeof ReplaceWorkspaceResourceGrantsInputSchema
>

/** POST workspace-resources/:id/grant-requests body. */
export const CreateWorkspaceResourceGrantRequestInputSchema = z.object({
  reason: z.string().trim().min(1).optional(),
})
export type CreateWorkspaceResourceGrantRequestInput = z.infer<
  typeof CreateWorkspaceResourceGrantRequestInputSchema
>

const grantsArraySchema = z.array(WorkspaceResourceGrantEntrySchema).optional()
const workspaceResourceContentBlockInputSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlockInput>

/** POST workspace-resources body (create) — discriminated by resource kind. */
export const CreateWorkspaceResourceInputSchema = z.union([
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.ACTOR),
    displayName: z.string().trim().min(1).max(255),
    role: z.enum(ACTOR_ROLES),
    title: z.string().trim().max(255).optional(),
    avatarFileId: z.uuid().optional(),
    avatarEmoji: z.string().trim().max(32).optional(),
    canRepresentUser: z.boolean().optional(),
    docs: z.array(ActorDocInputSchema).optional(),
    parentId: z.uuid().optional(),
    specialties: z.array(z.string()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL),
    sourceType: z.literal("custom"),
    displayName: z.string().trim().min(1).max(255),
    description: workspaceResourceContentBlockInputSchema.optional(),
    iconFileId: z.uuid().optional(),
    tags: z.array(z.string()).optional(),
    attachmentFiles: z.array(SkillAttachmentInputSchema).optional(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL),
    sourceType: z.literal("marketplace"),
    marketSkillId: z.uuid(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.REMOTE_AGENT),
    displayName: z.string().trim().min(1).max(255),
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(5000).optional(),
    runtimeKind: z.enum(REMOTE_AGENT_RUNTIME_KINDS),
    avatarFileId: z.uuid().optional(),
    avatarEmoji: z.string().trim().max(32).optional(),
    isPublicShared: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION),
    pluginId: z.uuid(),
    lifecycleScope: z.enum(REUSE_SCOPES).optional(),
    configData: z.record(z.string(), z.unknown()).optional(),
    authSessionIds: z.record(z.string(), z.uuid()).optional(),
    grants: grantsArraySchema,
  }),
])
export type CreateWorkspaceResourceInput = z.infer<
  typeof CreateWorkspaceResourceInputSchema
>

/** PATCH workspace-resources/:id body (update) — discriminated by resource kind. */
export const UpdateWorkspaceResourceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.ACTOR),
    displayName: z.string().trim().min(1).max(255).optional(),
    role: z.enum(ACTOR_ROLES).optional(),
    title: z.string().trim().max(255).optional(),
    avatarFileId: z.uuid().nullable().optional(),
    avatarEmoji: z.string().trim().max(32).nullable().optional(),
    canRepresentUser: z.boolean().optional(),
    docs: z.array(ActorDocInputSchema).optional(),
    parentId: z.uuid().nullable().optional(),
    specialties: z.array(z.string()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.REMOTE_AGENT),
    displayName: z.string().trim().min(1).max(255).optional(),
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    avatarFileId: z.uuid().nullable().optional(),
    avatarEmoji: z.string().trim().max(32).nullable().optional(),
    isPublicShared: z.boolean().optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.INSTALLED_SKILL),
    displayName: z.string().trim().min(1).max(255).optional(),
    description: workspaceResourceContentBlockInputSchema.optional(),
    iconFileId: z.uuid().nullable().optional(),
    tags: z.array(z.string()).optional(),
    isEnabled: z.boolean().optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
    attachmentFiles: z.array(SkillAttachmentInputSchema).optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.DEVICE_CAPABILITY),
    displayName: z.string().trim().min(1).max(255).optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_RESOURCE_KIND.PLUGIN_INSTALLATION),
    isEnabled: z.boolean().optional(),
    configData: z.record(z.string(), z.unknown()).optional(),
    authSessionIds: z.record(z.string(), z.uuid()).optional(),
    lifecycleScope: z.enum(REUSE_SCOPES).optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
  }),
])
export type UpdateWorkspaceResourceInput = z.infer<
  typeof UpdateWorkspaceResourceInputSchema
>

/** Grant-request direction query (?direction=). */
export const WorkspaceResourceGrantRequestDirectionSchema = z
  .enum(WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS)
  .default(WORKSPACE_RESOURCE_GRANT_REQUEST_DIRECTIONS[0])

/** GET workspace-resources/:id/grant-requests query. */
export const WorkspaceResourceGrantRequestListQuerySchema = z.object({
  direction: WorkspaceResourceGrantRequestDirectionSchema,
})
export type WorkspaceResourceGrantRequestListQuery = z.infer<
  typeof WorkspaceResourceGrantRequestListQuerySchema
>
