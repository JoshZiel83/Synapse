import { textBlocks, ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import type { BuiltinPluginExecuteResult } from "../../index.js"
import {
  fileRefProperty,
  fileRefsProperty,
  resolveFileRefRecord,
} from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  readZhipuJsonObjectResponse,
  throwZhipuApiError,
} from "./zhipu-errors.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const DEFAULT_MODEL = "moderation"

type ModerationInputBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } }
  | { type: "audio_url"; audio_url: { url: string } }

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "moderate_content",
    description:
      "Run the official ZhipuAI content safety API on text and/or FileRefs. " +
      "Supports text, image, audio, and video moderation and returns structured risk levels and risk types.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Text content to review. You may provide text alone or combine it with fileRef/fileRefs.",
        },
        fileRef: fileRefProperty(
          "Single image, audio, or video FileRef to review."
        ),
        fileRefs: fileRefsProperty(
          "Multiple image, audio, or video FileRefs to review together."
        ),
      },
      required: [],
    },
  },
]

async function fileRefToModerationInput(
  value: unknown,
  label: string
): Promise<ModerationInputBlock> {
  const record = await resolveFileRefRecord(value, label)
  if (record.mimeType.startsWith("image/")) {
    return { type: "image_url", image_url: { url: record.fullUrl } }
  }
  if (record.mimeType.startsWith("audio/")) {
    return { type: "audio_url", audio_url: { url: record.fullUrl } }
  }
  if (record.mimeType.startsWith("video/")) {
    return { type: "video_url", video_url: { url: record.fullUrl } }
  }
  throw new Error(`${label} must reference an image, audio, or video file`)
}

export const moderationFeature: SubFeature = {
  featureKey: "feature_moderation",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    _toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const blocks: ModerationInputBlock[] = []
    if (typeof input.text === "string" && input.text.trim()) {
      blocks.push({ type: "text", text: input.text.trim() })
    }
    if (input.fileRef !== undefined) {
      blocks.push(await fileRefToModerationInput(input.fileRef, "fileRef"))
    }
    if (Array.isArray(input.fileRefs)) {
      for (const [index, value] of input.fileRefs.entries()) {
        blocks.push(await fileRefToModerationInput(value, `fileRefs[${index}]`))
      }
    }

    if (blocks.length === 0) {
      throw new Error("Provide at least one of: text, fileRef, fileRefs")
    }

    const moderationInput:
      | string
      | ModerationInputBlock
      | ModerationInputBlock[] =
      blocks.length === 1 && blocks[0].type === "text"
        ? blocks[0].text
        : blocks.length === 1
          ? blocks[0]
          : blocks

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/moderations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          input: moderationInput,
        }),
        signal: AbortSignal.timeout(60000),
      })

      if (!response.ok) {
        await throwZhipuApiError("内容安全 API", response)
      }

      const result = await readZhipuJsonObjectResponse<{
        id?: string
        request_id?: string
        result_list?: Array<{
          content_type?: string
          risk_level?: string
          risk_type?: string[]
        }>
        usage?: {
          moderation_text?: {
            call_count?: number
          }
        }
      }>("内容安全 API", response)

      const lines = [
        result.id ? `Task ID: ${result.id}` : null,
        result.request_id ? `Request ID: ${result.request_id}` : null,
        result.usage?.moderation_text?.call_count !== undefined
          ? `Moderation text call count: ${result.usage.moderation_text.call_count}`
          : null,
      ].filter(Boolean) as string[]

      if (!result.result_list?.length) {
        lines.push("No moderation results returned.")
      } else {
        lines.push("Moderation results:")
        for (const [index, item] of result.result_list.entries()) {
          lines.push(
            [
              `${index + 1}. content_type=${item.content_type || "unknown"}`,
              `risk_level=${item.risk_level || "unknown"}`,
              item.risk_type?.length
                ? `risk_type=${item.risk_type.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join("; ")
          )
        }
      }

      return textBlocks(lines.join("\n"))
    } catch (error) {
      throw normalizeZhipuTransportError("内容安全 API", error)
    }
  },
}
