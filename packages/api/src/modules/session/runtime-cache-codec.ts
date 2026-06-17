import {
  parseJsonObjectOrUndefined,
  type ActorRuntimeState,
} from "@synapse/shared"
import { ActorRuntimeStateSchema } from "@synapse/shared/schemas"

export function parseCachedActorRuntimeState(
  rawValue: string
): ActorRuntimeState | null {
  try {
    const parsed = ActorRuntimeStateSchema.safeParse(JSON.parse(rawValue))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function formatRuntimeJsonForPresentation(value: unknown) {
  try {
    return JSON.stringify(parseJsonObjectOrUndefined(value) ?? {}, null, 2)
  } catch {
    return JSON.stringify(String(value ?? ""))
  }
}
