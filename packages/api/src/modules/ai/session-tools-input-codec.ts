import { z } from "zod"

import { throwToolError } from "./tool-errors.js"

const selfEventSubscriptionMatcherSchema = z.record(z.string(), z.unknown())

export function parseSelfEventSubscriptionMatcherInput(
  value: unknown
): Record<string, unknown> | undefined {
  const matcherInput = typeof value === "string" ? value.trim() : ""
  if (!matcherInput) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(matcherInput)
  } catch {
    throwToolError("matcher must be valid JSON")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwToolError("matcher must be a JSON object string")
  }

  const result = selfEventSubscriptionMatcherSchema.safeParse(parsed)
  if (!result.success) {
    throwToolError("matcher must be a JSON object string")
  }
  return result.data
}
