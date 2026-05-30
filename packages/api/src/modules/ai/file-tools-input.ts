import { z } from "zod"
import { throwToolError } from "./tool-errors.js"

const MAX_FILENAME_LENGTH = 255
const MAX_MIME_TYPE_LENGTH = 255

const actorUploadFileInputSchema = z
  .strictObject({
    filename: z.string().trim().min(1).max(MAX_FILENAME_LENGTH),
    mimeType: z.string().trim().min(1).max(MAX_MIME_TYPE_LENGTH).optional(),
    textContent: z.string().optional(),
    base64Content: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const sourceCount = [value.textContent, value.base64Content].filter(
      (candidate) => candidate !== undefined
    ).length
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of textContent or base64Content.",
        path: ["textContent"],
      })
    }
  })

export type ActorUploadFileInput = z.infer<typeof actorUploadFileInputSchema>

export function normalizeActorUploadFileInput(
  input: Record<string, unknown>
): ActorUploadFileInput {
  const parsed = actorUploadFileInputSchema.safeParse(input)
  if (!parsed.success) {
    throwToolError("Invalid input for upload_file.", {
      details: parsed.error.issues.map((issue) => issue.message),
    })
  }

  return parsed.data
}
