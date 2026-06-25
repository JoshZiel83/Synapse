import { z } from "zod"
import { CANONICAL_FILE_CATEGORIES } from "../constants/enums.js"
import type {
  CanonicalContentBlock,
  CanonicalContentBlockInput,
  ConversationEntityRef,
} from "../types/index.js"

/**
 * Canonical chat content-block zod schemas.
 *
 * Lives in shared so server controllers, future client-side guards, and
 * tooling all validate against the same shape. Before this module the
 * schema was inlined inside packages/api/src/modules/chat/controller.ts;
 * any second consumer (a CLI ingest path, an IM-imported message
 * pipeline, anything) had to either redeclare it or skip validation.
 *
 * Notes:
 * - `id` is optional on input: clients may omit it and let the server
 *   mint one; persisted form (CanonicalContentBlock) always has it.
 * - `mention.mention` is intentionally a loose `record(z.unknown())` here
 *   because ConversationEntityRef carries free-form transport metadata
 *   the server resolves later — tightening it would force callers to
 *   ship internal IDs they shouldn't have to.
 */
const blockIdSchema = z.uuid().optional()
const looseConversationEntityRefSchema = z
  .record(z.string(), z.unknown())
  .transform((value) => value as unknown as ConversationEntityRef)

export const canonicalTextBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("text"),
  text: z.string(),
})

export const canonicalFileRefBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("file_ref"),
  // sha256 (hex) is the always-present content identity; path is the optional
  // LLM-visible handle (/conversation/..., /actor/...).
  sha256: z.string().length(64),
  path: z.string().min(1).optional(),
  mimeType: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  category: z.enum(CANONICAL_FILE_CATEGORIES),
})

export const canonicalMentionBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal("mention"),
  mention: looseConversationEntityRefSchema,
})

export const CanonicalContentBlockSchema = z.discriminatedUnion("type", [
  canonicalTextBlockSchema,
  canonicalFileRefBlockSchema,
  canonicalMentionBlockSchema,
]) as z.ZodType<CanonicalContentBlockInput>

export type CanonicalContentBlockParsed = z.infer<
  typeof CanonicalContentBlockSchema
>

/**
 * Persisted / response variant. The input schema above makes `id` optional
 * (clients may omit it and let the server mint one). Every block the server
 * EMITS, however, carries an id — the content constructors always mint one
 * (see content/index.ts). Response DTOs embed THIS schema so their inferred
 * element type matches the persisted `CanonicalContentBlock` (id required)
 * rather than the input type (id optional), closing the id-optional-vs-required
 * drift. Same runtime object; the cast only tightens the declared type, which
 * is sound because output blocks always have ids.
 */
export const PersistedCanonicalContentBlockSchema =
  CanonicalContentBlockSchema as unknown as z.ZodType<CanonicalContentBlock>
