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
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing camelCase contracts for the workspace-apps module's APP routes
 * (master plan §5.3). workspace-apps is a Tier-A app-facing module: every route
 * is workspace-scoped + authenticated, so each handler's returned value is
 * wrapped through `appRoute` → `sendData` → `{ data: ... }`. These schemas
 * describe the value each handler returns (the helper wraps it).
 *
 * Top-level scalar/enum fields are modeled explicitly. The `target` / `grantee`
 * fields are `CapabilityAccessTarget` discriminated `{ subject, scope? }`
 * payloads the presenter already shapes from joined rows; they are a
 * genuinely-open subject-ref union that the boundary only needs to round-trip
 * unchanged, so they are modeled as `z.unknown()` here rather than re-validated.
 */

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

/** GET/PUT workspace-app grant (presentGrant). `target` is an open subject ref. */
export const WorkspaceAppGrantViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  target: z.unknown(),
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

/**
 * GET/POST workspace-app grant request (presentGrantRequest). `grantee` is an
 * open subject ref the presenter shapes from joined rows.
 */
export const WorkspaceAppGrantRequestViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceAppId: z.uuid(),
  grantee: z.unknown(),
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

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies for the workspace-apps APP routes. Single-sourced
// here so the API parser and the web/mobile clients share one definition.
// The grant `target` is the camelCase app-input subject/scope ref the route
// maps into a CapabilityAccessTarget; the controller keeps that mapping helper
// and types it via z.infer<typeof WorkspaceAppGrantTargetSchema>.

const conversationTypeMaskSchema = z.number().int().min(1).max(15)

/** Subject ref for a workspace-app grant target (app input, camelCase). */
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

/** `{ subject, scope? }` target for a workspace-app grant (app input). */
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
    docs: z.array(z.any()).optional(),
    parentId: z.uuid().optional(),
    specialties: z.array(z.string()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    grants: grantsArraySchema,
  }),
  z.object({
    kind: z.literal(WORKSPACE_APP_KIND.INSTALLED_SKILL),
    sourceType: z.literal("custom"),
    displayName: z.string().trim().min(1).max(255),
    description: z.any().optional(),
    iconFileId: z.uuid().optional(),
    tags: z.array(z.string()).optional(),
    attachmentFiles: z.array(z.any()).optional(),
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
    docs: z.array(z.any()).optional(),
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
    description: z.any().optional(),
    iconFileId: z.uuid().nullable().optional(),
    tags: z.array(z.string()).optional(),
    isEnabled: z.boolean().optional(),
    conversationTypeMaskOverride: conversationTypeMaskSchema
      .nullable()
      .optional(),
    attachmentFiles: z.array(z.any()).optional(),
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
