import {
  CanonicalContentBlock,
  FILE_ORIGIN_SYSTEMS,
  textBlock,
  ToolDefinition,
} from "@synapse/shared"
import type { SubFeature } from "./types.js"
import { saveFromBuffer } from "../../../../../infrastructure/storage/file-io.js"
import { pluginOutputFileRef } from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"
import { buildToolOutputOrigin } from "../../../../files/service.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const DEFAULT_MODEL = "glm-tts"

// GLM-TTS supported voices
// @see https://docs.bigmodel.cn/api-reference/模型-api/文本转语音
const VALID_VOICES = [
  "tongtong",
  "chuichui",
  "xiaochen",
  "jam",
  "kazi",
  "douji",
  "luodo",
]

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "text_to_speech",
    description:
      "Convert text to speech audio using ZhipuAI GLM-TTS. " +
      "Supported voices: tongtong (default female), chuichui, xiaochen, jam, kazi, douji, luodo. " +
      "Output format: wav (default) or pcm. Speed range: 0.5 to 2.0.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to convert to speech (max 1024 chars)",
        },
        voice: {
          type: "string",
          description:
            "Voice to use: tongtong, chuichui, xiaochen, jam, kazi, douji, luodo",
          enum: VALID_VOICES,
        },
        speed: {
          type: "number",
          description: "Speech speed (0.5 to 2.0, default 1.0)",
        },
        volume: {
          type: "number",
          description: "Output volume. Official range is (0, 10], default 1.0.",
        },
        watermarkEnabled: {
          type: "boolean",
          description:
            "Whether to keep the official AI watermark. true by default; false only works for accounts that have enabled de-watermark permissions in ZhipuAI console.",
        } as any,
        format: {
          type: "string",
          description:
            "Audio format. The official API default is pcm; this tool supports wav and pcm and defaults to wav for easier playback.",
          enum: ["wav", "pcm"],
        },
      },
      required: ["text"],
    },
  },
]

export const ttsFeature: SubFeature = {
  featureKey: "feature_tts",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<string | CanonicalContentBlock[]> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const workspaceId = (config.workspace_id as string) || null
    const text = input.text as string
    const voice = VALID_VOICES.includes(input.voice as string)
      ? (input.voice as string)
      : "tongtong"
    const speed =
      input.speed !== undefined
        ? Math.max(0.5, Math.min(2.0, Number(input.speed)))
        : 1.0
    const volume =
      input.volume !== undefined
        ? Math.max(Number.EPSILON, Math.min(10, Number(input.volume)))
        : 1.0
    const format = input.format === "pcm" ? "pcm" : "wav"

    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      input: text,
      voice,
      speed,
      volume,
      response_format: format,
    }
    if (typeof input.watermarkEnabled === "boolean")
      body.watermark_enabled = input.watermarkEnabled

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60000)

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        await throwZhipuApiError("文本转语音 API", response)
      }

      const arrayBuf = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuf)

      const ext = format === "pcm" ? "pcm" : "wav"
      const mimeType = format === "pcm" ? "audio/x-pcm" : "audio/wav"

      const fileRecord = await saveFromBuffer(
        buffer,
        `speech.${ext}`,
        mimeType,
        workspaceId,
        null,
        buildToolOutputOrigin({
          system: FILE_ORIGIN_SYSTEMS.ZHIPU_TEXT_TO_SPEECH,
          providerKey: "bigmodel",
          details: {
            voice,
            format,
            speed,
            volume,
          },
        })
      )

      return [
        textBlock(`Generated audio: ${fileRecord.originalName}`),
        pluginOutputFileRef(fileRecord),
      ]
    } catch (error) {
      throw normalizeZhipuTransportError("文本转语音 API", error)
    } finally {
      clearTimeout(timeout)
    }
  },
}
