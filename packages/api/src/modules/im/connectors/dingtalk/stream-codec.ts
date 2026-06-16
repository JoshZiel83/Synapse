import { z } from "zod"
import type { DingtalkInboundPayload } from "./normalize.js"

const rawRobotPayloadSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
)

export function parseDingtalkStreamPayload(
  data: unknown
): DingtalkInboundPayload | null {
  if (typeof data !== "string") return null
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = rawRobotPayloadSchema.safeParse(json)
  return parsed.success ? (parsed.data as DingtalkInboundPayload) : null
}
