import { z } from "zod"

const SherpaOnnxConfigJsonSchema = z.object({}).passthrough()

export function parseSherpaOnnxConfigJson(
  rawConfig: string
): Record<string, unknown> | null {
  const raw = rawConfig.trim()
  if (!raw) return null

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err: any) {
    throw new Error(
      `invalid SHERPA_ONNX_CONFIG_JSON: ${err?.message || "parse failed"}`
    )
  }

  const parsed = SherpaOnnxConfigJsonSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error("invalid SHERPA_ONNX_CONFIG_JSON: expected a JSON object")
  }
  return parsed.data
}
