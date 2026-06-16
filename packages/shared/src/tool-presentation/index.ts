import { z } from "zod"

/**
 * FE-facing tool presentation strings that are already rendered by the API.
 */
export interface PresentationString {
  key: string
  params: Record<string, string | number>
  fallback: string
}

/**
 * Pre-value-extraction domain transform that ICU MessageFormat cannot express.
 */
export type ArgPreprocess =
  | "basename"
  | "dirname"
  | "length"
  | "truncate60"
  | "raw"

/** A reference into the args (request side) or result data (result side). */
export interface ArgRef {
  path: string
  preprocess?: ArgPreprocess
  default?: string
}

/**
 * A renderable template: an ICU MessageFormat `message` plus the named args it
 * interpolates. `key` is the i18n message key the FE can eventually use.
 */
export interface PresentationTemplate {
  key: string
  message: string
  args?: Record<string, ArgRef>
}

/** How the request (input) body is rendered into content blocks. */
export type RequestRenderMode =
  | "summary"
  | "args_table"
  | "code"
  | "diff"
  | "hidden"

/**
 * How the raw result body is rendered. Default `summary_then_raw` keeps the raw
 * body alongside the friendly summary.
 */
export type ResultBodyMode =
  | "summary_then_raw"
  | "passthrough"
  | "json"
  | "image"
  | "hidden"

/** Generic structure for the `diff` request mode. */
export interface DiffSpec {
  itemsPath: string
  oldField: string
  newField: string
}

export interface ToolPresentationRequestSpec {
  mode: RequestRenderMode
  codeArg?: ArgRef
  diff?: DiffSpec
  secretArgs?: string[]
}

export interface ToolPresentationResultSpec {
  summary?: PresentationTemplate
  bodyMode?: ResultBodyMode
  secretFields?: string[]
}

/**
 * App/runtime presentation descriptor. Device runtimes and API renderers author
 * or evaluate it, while clients only receive rendered PresentationString values.
 */
export interface ToolPresentationDescriptor {
  v: 1
  icon: string
  title: PresentationTemplate
  detail?: PresentationTemplate
  request: ToolPresentationRequestSpec
  result?: ToolPresentationResultSpec
}

export function resolvePresentation(
  value: PresentationString | undefined
): string | undefined {
  return value?.fallback
}

const ArgPreprocessSchema = z.enum([
  "basename",
  "dirname",
  "length",
  "truncate60",
  "raw",
])

const ArgRefSchema: z.ZodType<ArgRef> = z.strictObject({
  path: z.string().min(1),
  preprocess: ArgPreprocessSchema.optional(),
  default: z.string().optional(),
})

const PresentationTemplateSchema: z.ZodType<PresentationTemplate> =
  z.strictObject({
    key: z.string().min(1),
    message: z.string().min(1),
    args: z.record(z.string(), ArgRefSchema).optional(),
  })

const DiffSpecSchema: z.ZodType<DiffSpec> = z.strictObject({
  itemsPath: z.string().min(1),
  oldField: z.string().min(1),
  newField: z.string().min(1),
})

export const ToolPresentationDescriptorSchema: z.ZodType<ToolPresentationDescriptor> =
  z.strictObject({
    v: z.literal(1),
    icon: z.string().min(1),
    title: PresentationTemplateSchema,
    detail: PresentationTemplateSchema.optional(),
    request: z.strictObject({
      mode: z.enum(["summary", "args_table", "code", "diff", "hidden"]),
      codeArg: ArgRefSchema.optional(),
      diff: DiffSpecSchema.optional(),
      secretArgs: z.array(z.string()).optional(),
    }),
    result: z
      .strictObject({
        summary: PresentationTemplateSchema.optional(),
        bodyMode: z
          .enum(["summary_then_raw", "passthrough", "json", "image", "hidden"])
          .optional(),
        secretFields: z.array(z.string()).optional(),
      })
      .optional(),
  })

/**
 * Safe-parse an untrusted value, e.g. a plugin manifest's
 * `synapse.presentation`, into a descriptor. Returns null on mismatch so
 * callers can fall back to the generic renderer.
 */
export function parseToolPresentation(
  value: unknown
): ToolPresentationDescriptor | null {
  const result = ToolPresentationDescriptorSchema.safeParse(value)
  return result.success ? result.data : null
}
