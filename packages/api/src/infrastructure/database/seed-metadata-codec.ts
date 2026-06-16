import { z } from "zod"

const SeedSkillMetadataSchema = z
  .object({
    ownerId: z.string().optional(),
    slug: z.string().optional(),
    version: z.string().optional(),
    publishedAt: z.number().optional(),
  })
  .passthrough()

export type SeedSkillMetadata = z.infer<typeof SeedSkillMetadataSchema>

export function parseSeedSkillMetadataJson(
  metadataText: string,
  sourceLabel = "seed skill _meta.json"
): SeedSkillMetadata {
  let value: unknown
  try {
    value = JSON.parse(metadataText)
  } catch (error) {
    throw new Error(
      `${sourceLabel} is invalid JSON: ${(error as Error).message}`
    )
  }

  const parsed = SeedSkillMetadataSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${sourceLabel} has invalid shape`)
  }
  return parsed.data
}
