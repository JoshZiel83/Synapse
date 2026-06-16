import { isToolResultOrigin, type ToolResultOrigin } from "@synapse/shared"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function readToolResultStructuredContent(
  value: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return isRecord(value.structuredContent) ? value.structuredContent : undefined
}

export function readToolResultOrigin(
  value: unknown
): ToolResultOrigin | undefined {
  if (!isRecord(value)) return undefined
  return isToolResultOrigin(value.origin) ? value.origin : undefined
}
