import { z } from "zod"
import {
  CANONICAL_FILE_CATEGORIES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_GRANT_STATUSES,
  MODEL_GROUP_OWNER_TYPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  MODEL_API_STYLES,
  MODEL_SERVER_TOOLS,
} from "../constants/enums.js"
import {
  PROVIDER_KINDS,
  isKnownModelVendor,
} from "../constants/model-providers.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * Model-binding feature flags (a JSONB column). Known optional fields are
 * validated; `.passthrough()` keeps forward-compatible extra keys rather than
 * stripping them (the column is author/runtime extensible). Mirrors the
 * relevant subset of ResolvedModelConfig in ../types/index.ts.
 */
export const ModelBindingFeaturesSchema = z
  .object({
    apiStyle: z.enum(MODEL_API_STYLES).optional(),
    serverTools: z.array(z.enum(MODEL_SERVER_TOOLS)).optional(),
    multimodal: z
      .object({
        supported: z.boolean(),
        types: z.array(z.enum(CANONICAL_FILE_CATEGORIES)),
      })
      .optional(),
    crossTurnToolHistory: z.boolean().optional(),
  })
  .passthrough()
export type ModelBindingFeatures = z.infer<typeof ModelBindingFeaturesSchema>

/**
 * App-facing contracts for the model-groups settings surface. These are the
 * source of truth for the `{ group | groups | item | grants | versions }`
 * payloads the model-group CRUD endpoints return; the api presenter builds them
 * from DB rows and web/mobile parse them. camelCase end-to-end.
 * See docs/architecture-boundary-refactor-master-plan.md Phase 6 §8.1.
 */

/** A model group as surfaced to the settings UI (presentGroupRow). */
export const ModelGroupViewSchema = z.strictObject({
  id: z.string(),
  ownerType: z.enum(MODEL_GROUP_OWNER_TYPES),
  ownerWorkspaceId: z.string().nullable(),
  ownerWorkspaceMemberId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  scope: z.enum(MODEL_GROUP_OWNER_TYPES),
  name: z.string(),
  description: z.string(),
  routingStrategy: z.enum(MODEL_GROUP_ROUTING_STRATEGIES),
  attemptPolicy: z.record(z.string(), z.unknown()),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdByWorkspaceMemberId: z.string().nullable(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type ModelGroupView = z.infer<typeof ModelGroupViewSchema>

/** A configured model inside a group (presentGroupItem). */
export const ModelGroupItemViewSchema = z.strictObject({
  id: z.string(),
  groupId: z.string().nullable(),
  bindingId: z.string(),
  currentVersionId: z.string().nullable(),
  displayName: z.string(),
  priority: z.number(),
  weight: z.number(),
  isEnabled: z.boolean(),
  version: z.number().nullable(),
  providerKind: z.enum(PROVIDER_KINDS),
  vendor: z.string().nullable(),
  baseUrl: z.string().nullable(),
  modelName: z.string().nullable(),
  maxOutputTokens: z.number().nullable(),
  capabilityTags: z.array(z.string()),
  features: ModelBindingFeaturesSchema,
  providerOptions: z.record(z.string(), z.unknown()),
  requestTimeoutMs: z.number().nullable(),
  maxRetries: z.number().nullable(),
  createdAt: IsoInstantStringSchema.nullable(),
  updatedAt: IsoInstantStringSchema.nullable(),
})
export type ModelGroupItemView = z.infer<typeof ModelGroupItemViewSchema>

/** An access grant that makes a group visible to a subject (presentGrantRow). */
export const ModelGroupGrantViewSchema = z.strictObject({
  id: z.string(),
  groupId: z.string(),
  grantScope: z.enum(MODEL_GROUP_GRANT_SCOPES),
  workspaceId: z.string().nullable(),
  workspaceMemberId: z.string().nullable(),
  actorId: z.string().nullable(),
  status: z.enum(MODEL_GROUP_GRANT_STATUSES),
  grantedByWorkspaceMemberId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: IsoInstantStringSchema.nullable(),
  revokedAt: IsoInstantStringSchema.nullable(),
})
export type ModelGroupGrantView = z.infer<typeof ModelGroupGrantViewSchema>

/** Full group view with its items and grants (getModelGroup). */
export const ModelGroupDetailViewSchema = ModelGroupViewSchema.extend({
  items: z.array(ModelGroupItemViewSchema),
  grants: z.array(ModelGroupGrantViewSchema),
})
export type ModelGroupDetailView = z.infer<typeof ModelGroupDetailViewSchema>

/** A group assigned to an actor's failover chain (presentActorModelGroup). */
export const ActorModelGroupAssignmentViewSchema = z.strictObject({
  actorId: z.string(),
  groupId: z.string(),
  priority: z.number(),
  createdAt: IsoInstantStringSchema.nullable(),
  groupName: z.string(),
  routingStrategy: z.enum(MODEL_GROUP_ROUTING_STRATEGIES),
  isDefault: z.boolean(),
  workspaceId: z.string().nullable(),
  ownerType: z.enum(MODEL_GROUP_OWNER_TYPES),
  ownerWorkspaceMemberId: z.string().nullable(),
})
export type ActorModelGroupAssignmentView = z.infer<
  typeof ActorModelGroupAssignmentViewSchema
>

/** A historical config version of a model binding (getItemVersions). */
export const ModelGroupItemVersionViewSchema = z.strictObject({
  id: z.string(),
  bindingId: z.string(),
  version: z.number(),
  providerKind: z.enum(PROVIDER_KINDS),
  vendor: z.string(),
  baseUrl: z.string(),
  modelName: z.string().nullable(),
  maxOutputTokens: z.number().nullable(),
  capabilityTags: z.array(z.string()),
  features: ModelBindingFeaturesSchema,
  providerOptions: z.record(z.string(), z.unknown()),
  requestTimeoutMs: z.number().nullable(),
  maxRetries: z.number().nullable(),
  createdAt: IsoInstantStringSchema.nullable(),
})
export type ModelGroupItemVersionView = z.infer<
  typeof ModelGroupItemVersionViewSchema
>

export const ModelGroupListViewSchema = z.array(ModelGroupViewSchema)
export type ModelGroupListView = z.infer<typeof ModelGroupListViewSchema>

export const ModelGroupGrantListViewSchema = z.array(ModelGroupGrantViewSchema)
export type ModelGroupGrantListView = z.infer<
  typeof ModelGroupGrantListViewSchema
>

export const ModelGroupItemVersionListViewSchema = z.array(
  ModelGroupItemVersionViewSchema
)
export type ModelGroupItemVersionListView = z.infer<
  typeof ModelGroupItemVersionListViewSchema
>

export const ActorModelGroupAssignmentListViewSchema = z.array(
  ActorModelGroupAssignmentViewSchema
)
export type ActorModelGroupAssignmentListView = z.infer<
  typeof ActorModelGroupAssignmentListViewSchema
>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies for model-group CRUD routes. File-import schemas in
// packages/api compose these base app schemas with stricter file-only rules.

export const ModelGroupRoutingStrategyInputSchema = z.enum(
  MODEL_GROUP_ROUTING_STRATEGIES
)
export const ModelProviderKindInputSchema = z.enum(PROVIDER_KINDS)
export const ModelVendorInputSchema = z
  .string()
  .min(1)
  .refine(isKnownModelVendor, "Unknown model vendor")
export const ModelGroupGrantScopeInputSchema = z.enum(MODEL_GROUP_GRANT_SCOPES)

export const ModelBindingFeaturesInputSchema = z.object({
  apiStyle: z.enum(MODEL_API_STYLES).optional(),
  serverTools: z.array(z.enum(MODEL_SERVER_TOOLS)).optional(),
  multimodal: z
    .object({
      supported: z.boolean(),
      types: z.array(z.enum(CANONICAL_FILE_CATEGORIES)),
    })
    .optional(),
  crossTurnToolHistory: z.boolean().optional(),
})
export type ModelBindingFeaturesInput = z.input<
  typeof ModelBindingFeaturesInputSchema
>

export const ModelGroupAttemptPolicyInputSchema = z.looseObject({
  maxAttemptsTotal: z.number().int().positive().optional(),
  maxAttemptsPerBinding: z.number().int().positive().optional(),
  timeoutMsPerAttempt: z.number().int().positive().optional(),
  continueOn: z.array(z.string()).optional(),
  stopOn: z.array(z.string()).optional(),
  retryBackoffMs: z.array(z.number().int().min(0)).optional(),
})
export type ModelGroupAttemptPolicyInput = z.input<
  typeof ModelGroupAttemptPolicyInputSchema
>

export const ModelGroupCreateInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  routingStrategy: ModelGroupRoutingStrategyInputSchema.optional(),
  attemptPolicy: ModelGroupAttemptPolicyInputSchema.optional(),
  isDefault: z.boolean().optional(),
})
export type ModelGroupCreateInput = z.input<typeof ModelGroupCreateInputSchema>

export const ModelGroupUpdateInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  routingStrategy: ModelGroupRoutingStrategyInputSchema.optional(),
  attemptPolicy: ModelGroupAttemptPolicyInputSchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})
export type ModelGroupUpdateInput = z.input<typeof ModelGroupUpdateInputSchema>

export const ModelGroupItemCreateInputSchema = z.object({
  displayName: z.string().min(1).max(255),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  providerKind: ModelProviderKindInputSchema.optional(),
  vendor: ModelVendorInputSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1),
  modelName: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilityTags: z.array(z.string()).optional(),
  features: ModelBindingFeaturesInputSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
})
export type ModelGroupItemCreateInput = z.input<
  typeof ModelGroupItemCreateInputSchema
>

export const ModelGroupItemUpdateInputSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  isEnabled: z.boolean().optional(),
  providerKind: ModelProviderKindInputSchema.optional(),
  vendor: ModelVendorInputSchema.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilityTags: z.array(z.string()).optional(),
  features: ModelBindingFeaturesInputSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
})
export type ModelGroupItemUpdateInput = z.input<
  typeof ModelGroupItemUpdateInputSchema
>

export const ActorModelGroupSetInputSchema = z.object({
  groups: z.array(
    z.object({
      groupId: z.uuid(),
      priority: z.number().int(),
    })
  ),
})
export type ActorModelGroupSetInput = z.input<
  typeof ActorModelGroupSetInputSchema
>

export const ModelGroupGrantIssueInputSchema = z.object({
  grantScope: ModelGroupGrantScopeInputSchema,
  workspaceId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  reason: z.string().max(1000).optional(),
})
export type ModelGroupGrantIssueInput = z.input<
  typeof ModelGroupGrantIssueInputSchema
>
