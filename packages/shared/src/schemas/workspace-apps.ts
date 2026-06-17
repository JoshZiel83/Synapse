import { z } from "zod"
import {
  WORKSPACE_APP_KINDS,
  WORKSPACE_APP_STATUSES,
  WORKSPACE_APP_GRANT_PERMISSIONS,
  WORKSPACE_APP_GRANT_SOURCES,
  WORKSPACE_APP_GRANT_STATUSES,
  WORKSPACE_APP_GRANT_REQUEST_STATUSES,
  WORKSPACE_APP_GRANT_REQUEST_DIRECTIONS,
  WORKSPACE_APP_KIND,
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
 * App-facing camelCase contracts for the workspace-apps module's APP routes
 * (master plan §5.3). workspace-apps is a Tier-A app-facing module: every route
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

/** Subject ref for a workspace-app grant target (app contract, camelCase). */
export const WorkspaceAppGrantTargetSubjectSchema = z.discriminatedUnion(
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

/** `{ subject, scope? }` target for a workspace-app grant. */
export const WorkspaceAppGrantTargetSchema = z.object({
  subject: WorkspaceAppGrantTargetSubjectSchema,
  scope: z
    .object({
      kind: z.literal(SUBJECT_KIND.CONVERSATION),
      conversationId: z.uuid(),
    })
    .optional(),
})
export type WorkspaceAppGrantTargetInput = z.infer<
  typeof WorkspaceAppGrantTargetSchema
>

/** GET/POST/PUT workspace-app inventory item (presentWorkspaceApp). */
export const WorkspaceAppViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: z.enum(WORKSPACE_APP_KINDS),
  displayName: z.string(),
  ownerWorkspaceMemberId: z.uuid().optional(),
  status: z.enum(WORKSPACE_APP_STATUSES),
  sourceDefaultConversationTypeMask: z.number().int().optional(),
  workspaceConversationTypeMask: z.number().int().optional(),
  conversationTypeMaskOverride: z.number().int().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceAppViewSchemaType = z.infer<typeof WorkspaceAppViewSchema>

/** GET/PUT workspace-app grant (presentGrant). */
export const WorkspaceAppGrantViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  target: WorkspaceAppGrantTargetSchema,
  permissions: z.array(z.enum(WORKSPACE_APP_GRANT_PERMISSIONS)),
  status: z.enum(WORKSPACE_APP_GRANT_STATUSES),
  source: z.enum(WORKSPACE_APP_GRANT_SOURCES),
  grantedByWorkspaceMemberId: z.uuid().optional(),
  reason: z.string().optional(),
  conversationTypeMaskOverride: z.number().int().nullable().optional(),
  effectiveConversationTypeMask: z.number().int().optional(),
  createdAt: IsoInstantStringSchema,
  revokedAt: IsoInstantStringSchema.optional(),
})
export type WorkspaceAppGrantViewSchemaType = z.infer<
  typeof WorkspaceAppGrantViewSchema
>

/** GET/POST workspace-app grant request (presentGrantRequest). */
export const WorkspaceAppGrantRequestViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  grantee: WorkspaceAppGrantTargetSchema,
  requestedPermissions: z.array(z.enum(WORKSPACE_APP_GRANT_PERMISSIONS)),
  requesterWorkspaceMemberId: z.uuid(),
  status: z.enum(WORKSPACE_APP_GRANT_REQUEST_STATUSES),
  resolvedByWorkspaceMemberId: z.uuid().optional(),
  resolvedAt: IsoInstantStringSchema.optional(),
  reason: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type WorkspaceAppGrantRequestViewSchemaType = z.infer<
  typeof WorkspaceAppGrantRequestViewSchema
>

/** Single workspace-app response body. */
export const WorkspaceAppEnvelopeViewSchema = z.object({
  app: WorkspaceAppViewSchema,
})
export type WorkspaceAppEnvelopeViewSchemaType = z.infer<
  typeof WorkspaceAppEnvelopeViewSchema
>

/** Workspace-app collection response body. */
export const WorkspaceAppListViewSchema = z.object({
  apps: z.array(WorkspaceAppViewSchema),
})
export type WorkspaceAppListViewSchemaType = z.infer<
  typeof WorkspaceAppListViewSchema
>

/** Workspace-app grant collection response body. */
export const WorkspaceAppGrantListViewSchema = z.object({
  grants: z.array(WorkspaceAppGrantViewSchema),
})
export type WorkspaceAppGrantListViewSchemaType = z.infer<
  typeof WorkspaceAppGrantListViewSchema
>

/** Workspace-app grant-request collection response body. */
export const WorkspaceAppGrantRequestListViewSchema = z.object({
  requests: z.array(WorkspaceAppGrantRequestViewSchema),
})
export type WorkspaceAppGrantRequestListViewSchemaType = z.infer<
  typeof WorkspaceAppGrantRequestListViewSchema
>

/** Single workspace-app grant-request response body. */
export const WorkspaceAppGrantRequestEnvelopeViewSchema = z.object({
  request: WorkspaceAppGrantRequestViewSchema,
})
export type WorkspaceAppGrantRequestEnvelopeViewSchemaType = z.infer<
  typeof WorkspaceAppGrantRequestEnvelopeViewSchema
>

/** Mutating workspace-app response body for boolean outcomes. */
export const WorkspaceAppSuccessViewSchema = z.object({
  success: z.boolean(),
})
export type WorkspaceAppSuccessViewSchemaType = z.infer<
  typeof WorkspaceAppSuccessViewSchema
>

// ───────────────────────── request/query DTOs (§5.1.1) ───────────────────────
// App-facing request bodies and query DTOs for the workspace-apps APP routes.
// Single-sourced here so the API parser and the web/mobile clients share one
// definition.
// The grant `target` is the camelCase app-input subject/scope ref the route
// maps into a CapabilityAccessTarget; the controller keeps that mapping helper
// and types it via z.infer<typeof WorkspaceAppGrantTargetSchema>.

const conversationTypeMaskSchema = z.number().int().min(1).max(15)

/** GET workspace-apps query. */
export const WorkspaceAppListQuerySchema = z.object({
  kind: z.enum(WORKSPACE_APP_KINDS).optional(),
})
export type WorkspaceAppListQuery = z.infer<typeof WorkspaceAppListQuerySchema>

/** GET workspace-apps/discover query. */
export const WorkspaceAppDiscoverQuerySchema = z.object({
  conversationId: z.uuid().optional(),
})
export type WorkspaceAppDiscoverQuery = z.infer<
  typeof WorkspaceAppDiscoverQuerySchema
>

/** A single grant entry in create/replace-grants bodies. */
export const WorkspaceAppGrantEntrySchema = z.object({
  target: WorkspaceAppGrantTargetSchema,
  permissions: z.array(z.enum(WORKSPACE_APP_GRANT_PERMISSIONS)).min(1),
  conversationTypeMaskOverride: conversationTypeMaskSchema
    .nullable()
    .optional(),
  reason: z.string().trim().min(1).optional(),
})
export type WorkspaceAppGrantEntryInput = z.infer<
  typeof WorkspaceAppGrantEntrySchema
>

/** PUT workspace-apps/:id/grants body. */
export const ReplaceWorkspaceAppGrantsInputSchema = z.object({
  grants: z.array(WorkspaceAppGrantEntrySchema),
})
export type ReplaceWorkspaceAppGrantsInput = z.infer<
  typeof ReplaceWorkspaceAppGrantsInputSchema
>

/** POST workspace-apps/:id/grant-requests body. */
export const CreateWorkspaceAppGrantRequestInputSchema = z.object({
  reason: z.string().trim().min(1).optional(),
})
export type CreateWorkspaceAppGrantRequestInput = z.infer<
  typeof CreateWorkspaceAppGrantRequestInputSchema
>

const grantsArraySchema = z.array(WorkspaceAppGrantEntrySchema).optional()
const workspaceAppContentBlockInputSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlockInput>

/** POST workspace-apps body (create) — discriminated by app kind. */
export const CreateWorkspaceAppInputSchema = z.union([
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.ACTOR),
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
    kind: z.literal(WORKSPACE_APP_KIND.INSTALLED_SKILL),
    sourceType: z.literal("custom"),
    displayName: z.string().trim().min(1).max(255),
    description: workspaceAppContentBlockInputSchema.optional(),
    iconFileId: z.uuid().optional(),
    tags: z.array(z.string()).optional(),
    attachmentFiles: z.array(SkillAttachmentInputSchema).optional(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.INSTALLED_SKILL),
    sourceType: z.literal("marketplace"),
    marketSkillId: z.uuid(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.REMOTE_AGENT),
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
    kind: z.literal(WORKSPACE_APP_KIND.PLUGIN_INSTALLATION),
    pluginId: z.uuid(),
    lifecycleScope: z.enum(REUSE_SCOPES).optional(),
    configData: z.record(z.string(), z.unknown()).optional(),
    authSessionIds: z.record(z.string(), z.uuid()).optional(),
    grants: grantsArraySchema,
  }),
])
export type CreateWorkspaceAppInput = z.infer<
  typeof CreateWorkspaceAppInputSchema
>

/** PATCH workspace-apps/:id body (update) — discriminated by app kind. */
export const UpdateWorkspaceAppInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.ACTOR),
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
    kind: z.literal(WORKSPACE_APP_KIND.REMOTE_AGENT),
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
    kind: z.literal(WORKSPACE_APP_KIND.INSTALLED_SKILL),
    displayName: z.string().trim().min(1).max(255).optional(),
    description: workspaceAppContentBlockInputSchema.optional(),
    iconFileId: z.uuid().nullable().optional(),
    tags: z.array(z.string()).optional(),
    isEnabled: z.boolean().optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
    attachmentFiles: z.array(SkillAttachmentInputSchema).optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.DEVICE_CAPABILITY),
    displayName: z.string().trim().min(1).max(255).optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
  }),
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.PLUGIN_INSTALLATION),
    isEnabled: z.boolean().optional(),
    configData: z.record(z.string(), z.unknown()).optional(),
    authSessionIds: z.record(z.string(), z.uuid()).optional(),
    lifecycleScope: z.enum(REUSE_SCOPES).optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
  }),
])
export type UpdateWorkspaceAppInput = z.infer<
  typeof UpdateWorkspaceAppInputSchema
>

/** Grant-request direction query (?direction=). */
export const WorkspaceAppGrantRequestDirectionSchema = z
  .enum(WORKSPACE_APP_GRANT_REQUEST_DIRECTIONS)
  .default(WORKSPACE_APP_GRANT_REQUEST_DIRECTIONS[0])

/** GET workspace-apps/:id/grant-requests query. */
export const WorkspaceAppGrantRequestListQuerySchema = z.object({
  direction: WorkspaceAppGrantRequestDirectionSchema,
})
export type WorkspaceAppGrantRequestListQuery = z.infer<
  typeof WorkspaceAppGrantRequestListQuerySchema
>
