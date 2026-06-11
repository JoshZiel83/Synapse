import { z } from "zod"
import {
  CANONICAL_FILE_CATEGORIES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_GRANT_STATUSES,
  MODEL_GROUP_OWNER_TYPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * Model-binding feature flags (a JSONB column). Known optional fields are
 * validated; `.passthrough()` keeps forward-compatible extra keys rather than
 * stripping them (the column is author/runtime extensible). Mirrors the
 * relevant subset of ResolvedModelConfig in ../types/index.ts.
 */
export const ModelBindingFeaturesSchema = z
  .object({
    apiStyle: z.enum(["chat", "responses"]).optional(),
    serverTools: z.array(z.enum(["web_search", "web_fetch"])).optional(),
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
  providerKind: z.string(),
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
  providerKind: z.string(),
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
