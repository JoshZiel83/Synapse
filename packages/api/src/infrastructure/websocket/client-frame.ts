import { ChatSocketClientMessageSchema } from "@synapse/shared/schemas"
import type { ChatSocketClientMessage } from "@synapse/shared/schemas"

export function parseChatSocketClientFrame(
  rawMessage: string
): ChatSocketClientMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch (error) {
    throw new Error("Invalid chat websocket client JSON", { cause: error })
  }

  const result = ChatSocketClientMessageSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("Invalid chat websocket client payload", {
      cause: result.error,
    })
  }
  return result.data
}
