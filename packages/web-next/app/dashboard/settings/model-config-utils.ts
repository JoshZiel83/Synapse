import {
  getKnownModelDefinitions,
  getModelMaxTokensLimit,
  validateModelProviderConfig,
} from "@synapse/shared"
import { ApiError } from "@/lib/api"

export function getModelConfigValidationMessage(input: {
  vendor: string
  modelName: string
  maxOutputTokens: string
}): string {
  const parsedMaxOutputTokens = Number.parseInt(input.maxOutputTokens, 10)

  if (
    input.maxOutputTokens.trim() &&
    (!Number.isFinite(parsedMaxOutputTokens) || parsedMaxOutputTokens <= 0)
  ) {
    return "Max output tokens must be a positive integer."
  }

  const issues = validateModelProviderConfig({
    vendor: input.vendor,
    modelName: input.modelName,
    maxOutputTokens: Number.isFinite(parsedMaxOutputTokens)
      ? parsedMaxOutputTokens
      : undefined,
  })

  return issues[0]?.message || ""
}

export function getKnownModelOptions(vendor: string) {
  return getKnownModelDefinitions(vendor)
}

export function getEffectiveMaxTokensLimit(
  vendor: string,
  modelName: string
): number | undefined {
  return getModelMaxTokensLimit(vendor, modelName.trim() || undefined)
}

export function getSaveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}
