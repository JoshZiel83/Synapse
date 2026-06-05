import { z } from "zod"
import {
  CANONICAL_FILE_CATEGORIES,
  MODEL_GROUP_GRANT_SCOPES,
  MODEL_GROUP_ROUTING_STRATEGIES,
  PROVIDER_KINDS,
  isKnownModelVendor,
} from "@synapse/shared"

// ===========================================================================
// Single source of truth for model-group request/config validation.
//
// These schemas were lifted verbatim out of controller.ts so that the HTTP
// controller AND the declarative YAML importer validate against ONE definition
// — eliminating the drift that would otherwise creep in between "what the UI
// can send" and "what a config file may declare". The controller imports these
// directly; the file-document schemas (further down) build ON TOP of them.
// ===========================================================================

export const routingStrategyEnum = z.enum(MODEL_GROUP_ROUTING_STRATEGIES)
export const providerKindSchema = z.enum(PROVIDER_KINDS)
export const vendorSchema = z
  .string()
  .min(1)
  .refine(isKnownModelVendor, "Unknown model vendor")
export const grantScopeEnum = z.enum(MODEL_GROUP_GRANT_SCOPES)

// Typed per-binding feature flags (replaces the old untyped extra_config bag).
// apiStyle = OpenAI chat-vs-responses selector; serverTools = anthropic server
// tools; multimodal = capability gate; crossTurnToolHistory = context option.
export const featuresSchema = z.object({
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

export const attemptPolicySchema = z.looseObject({
  maxAttemptsTotal: z.number().int().positive().optional(),
  maxAttemptsPerBinding: z.number().int().positive().optional(),
  timeoutMsPerAttempt: z.number().int().positive().optional(),
  continueOn: z.array(z.string()).optional(),
  stopOn: z.array(z.string()).optional(),
  retryBackoffMs: z.array(z.number().int().min(0)).optional(),
})

export const createGroupSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  attemptPolicy: attemptPolicySchema.optional(),
  isDefault: z.boolean().optional(),
})

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  routingStrategy: routingStrategyEnum.optional(),
  attemptPolicy: attemptPolicySchema.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

export const addItemSchema = z.object({
  displayName: z.string().min(1).max(255),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  providerKind: providerKindSchema.optional(),
  vendor: vendorSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1),
  modelName: z.string().min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilityTags: z.array(z.string()).optional(),
  features: featuresSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
})

export const updateItemSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(0).max(1000).optional(),
  isEnabled: z.boolean().optional(),
  providerKind: providerKindSchema.optional(),
  vendor: vendorSchema.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilityTags: z.array(z.string()).optional(),
  features: featuresSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
})

export const setActorGroupsSchema = z.object({
  groups: z.array(
    z.object({
      groupId: z.uuid(),
      priority: z.number().int(),
    })
  ),
})

export const issueGrantSchema = z.object({
  grantScope: grantScopeEnum,
  workspaceId: z.uuid().optional(),
  workspaceMemberId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  reason: z.string().max(1000).optional(),
})

// ===========================================================================
// Declarative file-import document schemas.
//
// The YAML config file describes one or more PLATFORM model groups, each with
// one or more model items — the same shape the UI/API accept, minus the scope
// axis (file import is platform-only by decision). Two distinct schemas are
// produced because `${ENV}` interpolation rewrites every string leaf between
// validation passes:
//
//   - modelGroupsFileSchema     — validates the RAW document (pre-interpolation).
//                                 Forces every item.apiKey to be a `${VAR}`
//                                 reference so a literal secret committed to the
//                                 file fails loudly.
//   - modelGroupsResolvedSchema — validates the document AFTER interpolation.
//                                 apiKey becomes a plain non-empty string (the
//                                 real key), and every other field/uniqueness
//                                 rule is re-checked to catch values an `${ENV}`
//                                 substitution may have made empty/too-long/
//                                 duplicate.
//
// Both use `.strict()` everywhere: the base schemas are plain `z.object` which
// SILENTLY STRIPS unknown keys. A file author writing e.g. `ownerType: workspace`
// (a non-platform field) must get a loud error, not a silent drop — so the file
// shapes reject unknown keys instead of inheriting the strip behaviour.
// ===========================================================================

/** A complete `${VAR}` reference and nothing else (no surrounding chars). */
const ENV_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

// STRICT attemptPolicy for file documents. The controller's attemptPolicySchema
// is z.looseObject (deliberately extensible at the API), but `.strict()` on a
// file group does NOT propagate into a nested loose object — so a typo'd key
// like `continuOn` would be silently kept and the override silently lost. The
// file-import contract promises loud failure on unknown keys, so re-declare the
// same fields as a strict object for file validation only.
const fileAttemptPolicySchema = z
  .object({
    maxAttemptsTotal: z.number().int().positive().optional(),
    maxAttemptsPerBinding: z.number().int().positive().optional(),
    timeoutMsPerAttempt: z.number().int().positive().optional(),
    continueOn: z.array(z.string()).optional(),
    stopOn: z.array(z.string()).optional(),
    retryBackoffMs: z.array(z.number().int().min(0)).optional(),
  })
  .strict()

// RAW item: identical to addItemSchema but (a) strict, and (b) apiKey MUST be a
// `${VAR}` reference. Plain-text secrets are rejected before they can be read.
const fileItemRawSchema = addItemSchema
  .extend({
    apiKey: z
      .string()
      .regex(
        ENV_REF,
        "apiKey must be a ${ENV_VAR} reference, not a literal secret"
      ),
  })
  .strict()

// RESOLVED item: same strict shape, but apiKey is now the interpolated real
// value — just require it be non-empty (an `${ENV}` that resolved to "" fails).
const fileItemResolvedSchema = addItemSchema
  .extend({
    apiKey: z.string().min(1),
  })
  .strict()

const fileGroupRawSchema = createGroupSchema
  .extend({
    attemptPolicy: fileAttemptPolicySchema.optional(),
    items: z.array(fileItemRawSchema).min(1),
  })
  .strict()

const fileGroupResolvedSchema = createGroupSchema
  .extend({
    attemptPolicy: fileAttemptPolicySchema.optional(),
    items: z.array(fileItemResolvedSchema).min(1),
  })
  .strict()

/**
 * Cross-document semantic rules shared by both the raw and resolved schemas:
 *   - at most one group may declare isDefault: true,
 *   - group names must be unique within the file,
 *   - item displayNames must be unique within each group.
 * Applied via superRefine so the SAME invariants run on both passes (post-
 * interpolation a `${VAR}` could collapse two names into a duplicate).
 */
function withDocRefinements<
  T extends z.ZodType<{
    groups: Array<{
      name: string
      isDefault?: boolean
      items: Array<{ displayName: string }>
    }>
  }>,
>(schema: T) {
  return schema.superRefine((doc, ctx) => {
    if (doc.groups.filter((g) => g.isDefault === true).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: "at most one group may set isDefault: true",
      })
    }
    const names = doc.groups.map((g) => g.name)
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["groups"],
        message: "group names must be unique within the file",
      })
    }
    doc.groups.forEach((g, gi) => {
      const displayNames = g.items.map((i) => i.displayName)
      if (new Set(displayNames).size !== displayNames.length) {
        ctx.addIssue({
          code: "custom",
          path: ["groups", gi, "items"],
          message: "item displayName must be unique within a group",
        })
      }
    })
  })
}

export const modelGroupsFileSchema = withDocRefinements(
  z
    .object({
      version: z.literal(1),
      groups: z.array(fileGroupRawSchema).min(1),
    })
    .strict()
)

export const modelGroupsResolvedSchema = withDocRefinements(
  z
    .object({
      version: z.literal(1),
      groups: z.array(fileGroupResolvedSchema).min(1),
    })
    .strict()
)

/** The validated, interpolated config document the importer applies. */
export type ModelGroupsFile = z.infer<typeof modelGroupsResolvedSchema>
export type ModelGroupsFileGroup = ModelGroupsFile["groups"][number]
export type ModelGroupsFileItem = ModelGroupsFileGroup["items"][number]
