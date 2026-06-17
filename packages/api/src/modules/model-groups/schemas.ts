import { z } from "zod"
import {
  ModelGroupCreateInputSchema,
  ModelGroupUpdateInputSchema,
  ModelGroupItemCreateInputSchema,
  ModelGroupItemUpdateInputSchema,
  ActorModelGroupSetInputSchema,
  ModelGroupGrantIssueInputSchema,
} from "@synapse/shared/schemas"

// ===========================================================================
// Model-group file-import validation.
//
// HTTP app request body schemas live in @synapse/shared/schemas so API,
// web/mobile clients, and route tests share one contract. This module keeps the
// declarative YAML importer's stricter file-only rules and re-exports the app
// schemas under the historical local names used by controller/importer code.
// ===========================================================================

export const createGroupSchema = ModelGroupCreateInputSchema
export const updateGroupSchema = ModelGroupUpdateInputSchema
export const addItemSchema = ModelGroupItemCreateInputSchema
export const updateItemSchema = ModelGroupItemUpdateInputSchema
export const setActorGroupsSchema = ActorModelGroupSetInputSchema
export const issueGrantSchema = ModelGroupGrantIssueInputSchema

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
