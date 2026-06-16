import { z } from "zod"
import {
  MEMORY_CATEGORIES,
  MEMORY_INDEX_STATUSES,
  MEMORY_ITEM_STATES,
  MEMORY_RECALL_TYPES,
  MEMORY_SPACE_TYPES,
  MEMORY_STABILITIES,
} from "../constants/enums.js"
import {
  MEMORY_ACCESS_GRANT_STATUSES,
  MEMORY_PERMISSIONS,
  SUBJECT_KIND,
} from "../access/enums.js"
import type {
  CanonicalContentBlockInput,
  Memory,
  MemoryRecallResult,
  MemoryRecallRun,
} from "../types/index.js"
import { CanonicalContentBlockSchema } from "./chat-content-block.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for memory routes.
 *
 * App routes return `{ data: ... }` via `appRoute`. These schemas describe the
 * pre-envelope app DTOs that the controller returns.
 */

const memoryPresetEnum = z.enum(MEMORY_SPACE_TYPES)
const memoryCategoryEnum = z.enum(MEMORY_CATEGORIES)
const memoryStateEnum = z.enum(MEMORY_ITEM_STATES)
const memoryStabilityEnum = z.enum(MEMORY_STABILITIES)
const memoryIndexStatusEnum = z.enum(MEMORY_INDEX_STATUSES)

export const MemoryContentBlockInputSchema =
  CanonicalContentBlockSchema as z.ZodType<CanonicalContentBlockInput>
export type MemoryContentBlockInput = z.infer<
  typeof MemoryContentBlockInputSchema
>

// Memory owners are workspace-scoped subjects only; user/external/platform are
// intentionally excluded from memory item ownership in the current model.
export const MemoryOwnerSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE_MEMBER),
    memberId: z.uuid(),
  }),
  z.object({ kind: z.literal(SUBJECT_KIND.ACTOR), actorId: z.uuid() }),
  z.object({
    kind: z.literal(SUBJECT_KIND.REMOTE_AGENT),
    remoteAgentId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])
export type MemoryOwnerSubjectRef = z.infer<typeof MemoryOwnerSubjectRefSchema>

export const MemoryScopeSubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(SUBJECT_KIND.WORKSPACE),
    workspaceId: z.uuid(),
  }),
  z.object({
    kind: z.literal(SUBJECT_KIND.CONVERSATION),
    conversationId: z.uuid(),
  }),
])
export type MemoryScopeSubjectRef = z.infer<typeof MemoryScopeSubjectRefSchema>

export const MemoryGrantSubjectRefSchema = MemoryOwnerSubjectRefSchema
export type MemoryGrantSubjectRef = z.infer<typeof MemoryGrantSubjectRefSchema>

const MemoryPayloadBaseSchema = z.object({
  // Preset shim for legacy app callers.
  preset: memoryPresetEnum.optional(),
  presetActorId: z.uuid().optional(),
  presetConversationId: z.uuid().optional(),
  presetWorkspaceMemberId: z.uuid().optional(),
  // Canonical owner/scope form.
  owner: MemoryOwnerSubjectRefSchema.optional(),
  scope: MemoryScopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
  category: memoryCategoryEnum.optional(),
  state: memoryStateEnum.optional(),
  status: memoryStateEnum.optional(),
  stability: memoryStabilityEnum.optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  content: z.string().optional(),
  contentBlocks: z.array(MemoryContentBlockInputSchema).optional(),
  textDigest: z.string().optional(),
  searchText: z.string().optional(),
  sourceItemId: z.uuid().optional(),
  sourceToolCallId: z.uuid().optional(),
  sourceTurnId: z.uuid().optional(),
  supersedesMemoryId: z.uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const CreateMemoryInputSchema = MemoryPayloadBaseSchema.extend({
  category: memoryCategoryEnum,
}).refine(
  (value) => !!value.content || !!value.contentBlocks || !!value.textDigest,
  {
    message: "content, contentBlocks, or textDigest is required",
  }
)
export type CreateMemoryInputBody = z.infer<typeof CreateMemoryInputSchema>

export const UpdateMemoryInputSchema = MemoryPayloadBaseSchema.partial()
export type UpdateMemoryInputBody = z.infer<typeof UpdateMemoryInputSchema>

export const MemoryListQuerySchema = z.object({
  actorId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  owner: MemoryOwnerSubjectRefSchema.optional(),
  scope: MemoryScopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
  category: memoryCategoryEnum.optional(),
  state: memoryStateEnum.optional(),
  status: memoryStateEnum.optional(),
  tags: z
    .union([
      z.string().transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      ),
      z.array(z.string()),
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type MemoryListQuery = z.infer<typeof MemoryListQuerySchema>

export const MemoryPermissionContextQuerySchema = z.strictObject({
  conversationId: z.uuid().optional(),
})
export type MemoryPermissionContextQuery = z.infer<
  typeof MemoryPermissionContextQuerySchema
>

export const MemorySearchInputSchema = z.object({
  queryText: z.string().min(1),
  actorId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  owners: z.array(MemoryOwnerSubjectRefSchema).optional(),
  scopes: z.array(MemoryScopeSubjectRefSchema).optional(),
  namespaceKeys: z.array(z.string().max(255)).optional(),
  categories: z.array(memoryCategoryEnum).optional(),
  states: z.array(memoryStateEnum).optional(),
  statuses: z.array(memoryStateEnum).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>

export const MemoryRecallInputSchema = MemorySearchInputSchema.extend({
  recallType: z.enum(
    MEMORY_RECALL_TYPES.filter((value) => value !== "manual_search") as [
      "bootstrap",
      "turn_recall",
    ]
  ),
  queryBlocks: z.array(MemoryContentBlockInputSchema).optional(),
})
export type MemoryRecallInput = z.infer<typeof MemoryRecallInputSchema>

export const CreateMemoryAccessGrantInputSchema = z.object({
  memoryItemId: z.uuid().nullish(),
  subject: MemoryGrantSubjectRefSchema,
  scope: MemoryScopeSubjectRefSchema.optional(),
  permissions: z.array(z.enum(MEMORY_PERMISSIONS)).min(1),
  source: z.string().max(64).nullish(),
})
export type CreateMemoryAccessGrantInput = z.infer<
  typeof CreateMemoryAccessGrantInputSchema
>

export const MoveMemoryInputSchema = z.object({
  owner: MemoryOwnerSubjectRefSchema,
  scope: MemoryScopeSubjectRefSchema.optional(),
  namespaceKey: z.string().max(255).optional(),
})
export type MoveMemoryInput = z.infer<typeof MoveMemoryInputSchema>

const memoryViewShape = {
  id: z.uuid(),
  workspaceId: z.uuid(),
  spaceId: z.uuid(),
  owner: MemoryOwnerSubjectRefSchema,
  scope: MemoryScopeSubjectRefSchema.optional(),
  namespaceKey: z.string(),
  category: memoryCategoryEnum,
  state: memoryStateEnum,
  status: memoryStateEnum,
  stability: memoryStabilityEnum,
  importance: z.number(),
  confidence: z.number(),
  tags: z.array(z.string()),
  textDigest: z.string(),
  searchText: z.string(),
  contentBlocks: z.array(CanonicalContentBlockSchema),
  sourceItemId: z.uuid().optional(),
  sourceToolCallId: z.uuid().optional(),
  sourceTurnId: z.uuid().optional(),
  supersedesMemoryId: z.uuid().optional(),
  metadata: z.record(z.string(), z.unknown()),
  indexStatus: memoryIndexStatusEnum,
  embeddingModel: z.string().optional(),
  embeddingDim: z.number().int().optional(),
  indexedAt: IsoInstantStringSchema.optional(),
  indexError: z.string().optional(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  ownerLabel: z.string().optional(),
  scopeLabel: z.string().optional(),
}

export const MemoryViewSchema = z.object(memoryViewShape) as z.ZodType<Memory>
export type MemoryView = z.infer<typeof MemoryViewSchema>

const memorySearchHitViewShape = {
  ...memoryViewShape,
  matchedChunkId: z.uuid().optional(),
  rank: z.number().int().min(1),
  finalScore: z.number(),
  vectorScore: z.number().optional(),
  textScore: z.number().optional(),
  similarityScore: z.number().optional(),
  matchedTerms: z.array(z.string()).optional(),
}

export const MemorySearchHitViewSchema = z.object(
  memorySearchHitViewShape
) as z.ZodType<MemoryRecallResult>
export type MemorySearchHitView = z.infer<typeof MemorySearchHitViewSchema>

export const MemoryRecallResultItemViewSchema = z.object({
  ...memorySearchHitViewShape,
  recallReason: z.string().optional(),
}) as z.ZodType<MemoryRecallResult>
export type MemoryRecallResultItemView = z.infer<
  typeof MemoryRecallResultItemViewSchema
>

export const MemoryRecallRunViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  actorId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  recallType: z.enum(MEMORY_RECALL_TYPES),
  queryText: z.string(),
  queryBlocks: z.array(CanonicalContentBlockSchema),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoInstantStringSchema,
  results: z.array(MemoryRecallResultItemViewSchema),
}) as z.ZodType<MemoryRecallRun>
export type MemoryRecallRunView = z.infer<typeof MemoryRecallRunViewSchema>

export const MemoryAccessGrantViewSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  memorySpaceId: z.uuid(),
  memoryItemId: z.uuid().nullable(),
  subjectId: z.uuid(),
  scopeSubjectId: z.uuid().nullable(),
  permissions: z.array(z.enum(MEMORY_PERMISSIONS)),
  status: z.enum(MEMORY_ACCESS_GRANT_STATUSES),
  source: z.string().nullable(),
  createdByWorkspaceMemberId: z.uuid().nullable(),
  sourceTaskId: z.uuid().nullable(),
  revokedAt: IsoInstantStringSchema.nullable(),
  supersededAt: IsoInstantStringSchema.nullable(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type MemoryAccessGrantView = z.infer<typeof MemoryAccessGrantViewSchema>

export const MemoryThinMoveResultViewSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  moved: z.literal(true),
})
export type MemoryThinMoveResultView = z.infer<
  typeof MemoryThinMoveResultViewSchema
>

export const MemoryItemEnvelopeViewSchema = z.object({
  memory: MemoryViewSchema,
})
export type MemoryItemEnvelopeView = z.infer<
  typeof MemoryItemEnvelopeViewSchema
>

export const MemoryListViewSchema = z.object({
  memories: z.array(MemoryViewSchema),
})
export type MemoryListView = z.infer<typeof MemoryListViewSchema>

export const MemoryMoveResultViewSchema = z.union([
  MemoryViewSchema,
  MemoryThinMoveResultViewSchema,
])
export type MemoryMoveResultView = z.infer<typeof MemoryMoveResultViewSchema>

export const MemorySearchResultViewSchema = z.object({
  run: MemoryRecallRunViewSchema,
  memories: z.array(MemoryRecallResultItemViewSchema),
})
export type MemorySearchResultView = z.infer<
  typeof MemorySearchResultViewSchema
>

export const MemoryRecallResultViewSchema = z.object({
  run: MemoryRecallRunViewSchema,
  memories: z.array(MemoryRecallResultItemViewSchema),
})
export type MemoryRecallResultView = z.infer<
  typeof MemoryRecallResultViewSchema
>

export const MemoryAccessGrantEnvelopeViewSchema = z.object({
  grant: MemoryAccessGrantViewSchema,
})
export type MemoryAccessGrantEnvelopeView = z.infer<
  typeof MemoryAccessGrantEnvelopeViewSchema
>

export const MemoryAccessGrantListViewSchema = z.object({
  grants: z.array(MemoryAccessGrantViewSchema),
})
export type MemoryAccessGrantListView = z.infer<
  typeof MemoryAccessGrantListViewSchema
>

export const MemoryAccessGrantRevokeResultViewSchema = z.object({
  revoked: z.union([z.literal(true), z.literal(false)]),
})
export type MemoryAccessGrantRevokeResultView = z.infer<
  typeof MemoryAccessGrantRevokeResultViewSchema
>

export const MemoryNoContentSchema = z.undefined()
