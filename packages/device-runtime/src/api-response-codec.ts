import type { z } from "zod"

export async function readJsonResponse<S extends z.ZodType>(
  response: Response,
  schema: S,
  label: string
): Promise<z.output<S>> {
  const text = await response.text()
  let payload: unknown
  try {
    payload = text.trim() ? JSON.parse(text) : undefined
  } catch (err) {
    throw new Error(`${label} returned malformed JSON`, { cause: err })
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`${label} response shape invalid`, {
      cause: parsed.error,
    })
  }
  return parsed.data
}
