// Zod schema mirror of the tool-presentation descriptor types.
//
// Used to VALIDATE descriptors that arrive from an untrusted/external source —
// chiefly an external MCP plugin's catalog `tool_manifest.synapse.presentation`.
// Builtin descriptors are authored in-tree as typed values and don't need a
// runtime parse, but they're still covered by the same schema in tests.
//
// Separate file + separate subpath (`@synapse/device-protocol/tool-presentation/
// schema`) so zod never reaches the root barrel / service-worker bundle. The
// pure types live in `./tool-presentation.ts`.

import { z } from "zod"
import type {
  ArgRef,
  DiffSpec,
  PresentationTemplate,
  ToolPresentationDescriptor,
} from "./tool-presentation.js"

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
 * Safe-parse an untrusted value (e.g. plugin manifest's `synapse.presentation`)
 * into a descriptor. Returns null on any mismatch so the caller falls back to
 * the generic renderer rather than throwing on a hot display path.
 */
export function parseToolPresentation(
  value: unknown
): ToolPresentationDescriptor | null {
  const result = ToolPresentationDescriptorSchema.safeParse(value)
  return result.success ? result.data : null
}
