import {
  FileUploadOriginInputSchema,
  type FileUploadOriginInput,
} from "@synapse/shared/schemas"

export type FileUploadOriginParseResult =
  | { ok: true; origin: FileUploadOriginInput }
  | { ok: false; error: string }

export function parseFileUploadOriginField(
  value: string
): FileUploadOriginParseResult {
  let input: unknown
  try {
    input = JSON.parse(value)
  } catch {
    return { ok: false, error: "origin must be valid JSON" }
  }

  const parsed = FileUploadOriginInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid origin: ${parsed.error.issues.map((issue) => issue.message).join(" ")}`,
    }
  }

  return { ok: true, origin: parsed.data }
}
