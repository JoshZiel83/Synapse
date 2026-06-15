import type { SystemEvent } from "@synapse/shared"
import { SystemEventSchema } from "@synapse/shared/schemas"

export function parseSystemEventRedisFrame(message: string): SystemEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch (error) {
    throw new Error("Invalid system event JSON", { cause: error })
  }

  const result = SystemEventSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("Invalid system event payload", {
      cause: result.error,
    })
  }
  return result.data
}
