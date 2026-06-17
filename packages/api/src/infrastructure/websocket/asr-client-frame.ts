import type { RealtimeAsrClientMessage } from "@synapse/shared"
import { RealtimeAsrClientMessageSchema } from "@synapse/shared/schemas"

export function parseRealtimeAsrClientFrame(
  rawMessage: string
): RealtimeAsrClientMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch (error) {
    throw new Error("Invalid realtime ASR client JSON", { cause: error })
  }

  const result = RealtimeAsrClientMessageSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("Invalid realtime ASR client payload", {
      cause: result.error,
    })
  }
  return result.data
}
