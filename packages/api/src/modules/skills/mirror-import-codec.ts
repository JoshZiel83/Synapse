import { z } from "zod"

export type JsonObject = Record<string, unknown>

const ClawhubMirrorMetaSchema = z
  .object({
    ownerId: z.string().optional(),
    owner: z.string().optional(),
    slug: z.string().optional(),
    displayName: z.string().optional(),
    version: z.string().optional(),
    publishedAt: z.number().optional(),
    latest: z
      .object({
        version: z.string().optional(),
        publishedAt: z.number().optional(),
        commit: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export type ClawhubMirrorMeta = z.infer<typeof ClawhubMirrorMetaSchema>

export function parseClawhubMirrorMetaJson(
  metaText: string,
  sourceLabel = "Clawhub _meta.json"
): ClawhubMirrorMeta {
  let value: unknown
  try {
    value = JSON.parse(metaText)
  } catch (error) {
    throw new Error(
      `${sourceLabel} is invalid JSON: ${(error as Error).message}`
    )
  }

  const parsed = ClawhubMirrorMetaSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${sourceLabel} has invalid shape`)
  }
  return parsed.data
}

export function parseGitHubApiJsonObjectText(
  jsonText: string,
  sourceLabel = "GitHub API response"
): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(
      `${sourceLabel} is invalid JSON: ${(error as Error).message}`
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be a JSON object`)
  }
  return value as JsonObject
}
