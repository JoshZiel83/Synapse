import { z } from "zod"

export const AUTH_SESSION_CONTROL_CHANNEL = "synapse:auth:sessions"

const disconnectReasons = [
  "Session logged out",
  "All sessions were logged out",
  "Session revoked",
  "Session invalidated",
] as const

export type DisconnectReason = (typeof disconnectReasons)[number]

const authSessionControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.disconnect"),
    sessionId: z.string().min(1),
    reason: z.enum(disconnectReasons),
  }),
  z.object({
    type: z.literal("user.disconnect"),
    userId: z.string().min(1),
    exceptSessionId: z.string().min(1).optional(),
    reason: z.enum(disconnectReasons),
  }),
])

export type AuthSessionControlMessage = z.infer<
  typeof authSessionControlMessageSchema
>

export function parseAuthSessionControlMessage(
  rawMessage: string
): AuthSessionControlMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch (error) {
    throw new Error("Invalid auth session control JSON", { cause: error })
  }

  const result = authSessionControlMessageSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("Invalid auth session control payload", {
      cause: result.error,
    })
  }
  return result.data
}

export function serializeAuthSessionControlMessage(
  message: AuthSessionControlMessage
): string {
  return JSON.stringify(authSessionControlMessageSchema.parse(message))
}
