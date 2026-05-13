/**
 * ZhipuAI Speech-to-Text (GLM-ASR) — audio transcription.
 *
 * Endpoint: POST /paas/v4/audio/transcriptions (multipart/form-data or base64)
 * Model: glm-asr-2512
 * Supported audio: .wav, .mp3, ≤ 25 MB, ≤ 30 seconds
 * @see https://docs.bigmodel.cn/api-reference/模型-api/语音转文本
 */
import { ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import {
  fileRefProperty,
  resolveAudioFileRefToBase64,
} from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const DEFAULT_MODEL = "glm-asr-2512"

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "audio_transcription",
    description:
      "Transcribe audio to text using ZhipuAI GLM-ASR. " +
      "Provide an audio file via FileRef. " +
      "Supported formats: .wav, .mp3. Max file size: 25 MB, max duration: 30 seconds.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Audio file to transcribe."),
        prompt: {
          type: "string",
          description:
            "Prior transcription context for long-text scenarios (recommended under 8000 chars)",
        },
        hotwords: {
          type: "array",
          items: { type: "string" },
          description:
            "Hotword list to improve domain-specific recognition, e.g. names or terms (max 100 items)",
        },
        requestId: {
          type: "string",
          description:
            "Optional unique request identifier forwarded to the official API.",
        },
        userId: {
          type: "string",
          description:
            "Optional end-user identifier forwarded to the official API for abuse tracing. Must be 6-128 characters if provided.",
        },
      },
      required: ["fileRef"],
    },
  },
]

async function getAudioBase64(
  input: Record<string, unknown>
): Promise<{ base64: string; mimeType: string }> {
  return resolveAudioFileRefToBase64(input.fileRef, "fileRef")
}

export const sttFeature: SubFeature = {
  featureKey: "feature_stt",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<string> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const { base64 } = await getAudioBase64(input)
    const prompt = input.prompt as string | undefined
    const hotwords = input.hotwords as string[] | undefined
    const requestId = input.requestId as string | undefined
    const userId = input.userId as string | undefined

    // Use the dedicated /audio/transcriptions endpoint with file_base64
    // @see https://docs.bigmodel.cn/api-reference/模型-api/语音转文本
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      file_base64: base64,
    }
    if (prompt) body.prompt = prompt
    if (hotwords && hotwords.length > 0) body.hotwords = hotwords.slice(0, 100)
    if (requestId) body.request_id = requestId
    if (userId && userId.length >= 6 && userId.length <= 128)
      body.user_id = userId
    body.stream = false

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        await throwZhipuApiError("语音转文本 API", response)
      }

      const result = (await response.json()) as { text?: string }

      return result.text || "No transcription result"
    } catch (error) {
      throw normalizeZhipuTransportError("语音转文本 API", error)
    } finally {
      clearTimeout(timeout)
    }
  },
}
