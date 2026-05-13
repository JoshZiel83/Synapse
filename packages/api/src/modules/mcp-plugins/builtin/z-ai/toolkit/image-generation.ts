/**
 * ZhipuAI Image Generation (CogView / GLM-Image).
 *
 * Endpoint: POST /paas/v4/images/generations
 * Models: glm-image, cogview-4-250304, cogview-4, cogview-3-flash
 *
 * glm-image: highest quality, supports only 'hd' quality, default size 1280x1280,
 *   custom size 1024-2048px (multiples of 32), max ~4M pixels
 * cogview-4-250304 / cogview-4 / cogview-3-flash: standard & hd quality,
 *   default size 1024x1024, custom size 512-2048px (multiples of 16), max ~2M pixels
 *
 * Image URLs in the response are temporary (valid for 30 days).
 * @see https://docs.bigmodel.cn/api-reference/模型-api/图像生成
 */
import { FILE_ORIGIN_SYSTEMS, ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import { saveFromUrl } from "../../../../../infrastructure/storage/file-io.js"
import { pluginOutputFileRef } from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"
import { buildToolOutputOrigin } from "../../../../files/service.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const DEFAULT_MODEL = "cogview-4-250304"

const VALID_MODELS = [
  "glm-image",
  "cogview-4-250304",
  "cogview-4",
  "cogview-3-flash",
]

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "generate_image",
    description:
      "Generate an image from a text prompt using ZhipuAI image generation. " +
      "Models: glm-image (highest quality, ~20s, only hd), cogview-4-250304 (default, good quality), " +
      "cogview-4, cogview-3-flash (fastest). " +
      'Quality: "hd" for finer detail (~20s), "standard" for faster (~5-10s). glm-image only supports hd.',
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        model: {
          type: "string",
          description:
            "Model to use. glm-image: highest quality (hd only, size 1280x1280 default). " +
            "cogview-4-250304: good quality (default). cogview-4 / cogview-3-flash: faster alternatives.",
          enum: VALID_MODELS,
        },
        quality: {
          type: "string",
          description:
            'Image quality. "hd": finer detail (~20s). "standard": faster (~5-10s). glm-image only supports hd.',
          enum: ["standard", "hd"],
        },
        size: {
          type: "string",
          description:
            "Output image dimensions. " +
            "For glm-image: 1280x1280 (default), 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728. " +
            "Custom: 1024-2048px, multiples of 32. " +
            "For cogview models: 1024x1024 (default), 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440. " +
            "Custom: 512-2048px, multiples of 16.",
        },
        watermarkEnabled: {
          type: "boolean",
          description:
            "Whether to keep the official AI watermark. true by default; false only works for accounts that have enabled de-watermark permissions in ZhipuAI console.",
        } as any,
        userId: {
          type: "string",
          description:
            "Optional end-user identifier passed through to ZhipuAI for abuse tracing. Must be 6-128 characters if provided.",
        },
      },
      required: ["prompt"],
    },
  },
]

export const imageGenFeature: SubFeature = {
  featureKey: "feature_image_gen",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<string | unknown[]> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const workspaceId = (config.workspace_id as string) || null
    const model = VALID_MODELS.includes(input.model as string)
      ? (input.model as string)
      : DEFAULT_MODEL
    const prompt = input.prompt as string

    // Determine defaults based on model
    const isGlmImage = model === "glm-image"
    const size =
      (input.size as string) || (isGlmImage ? "1280x1280" : "1024x1024")
    const quality = input.quality as string | undefined

    const body: Record<string, unknown> = {
      model,
      prompt,
      size,
    }
    // glm-image only supports 'hd'; for others, pass quality if specified
    if (isGlmImage) {
      body.quality = "hd"
    } else if (quality === "hd" || quality === "standard") {
      body.quality = quality
    }
    if (typeof input.watermarkEnabled === "boolean")
      body.watermark_enabled = input.watermarkEnabled
    if (
      typeof input.userId === "string" &&
      input.userId.length >= 6 &&
      input.userId.length <= 128
    )
      body.user_id = input.userId

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120000)

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        await throwZhipuApiError("图像生成 API", response)
      }

      const result = (await response.json()) as {
        data?: Array<{ url?: string; b64_json?: string }>
      }

      const imageData = result.data?.[0]
      if (!imageData?.url) {
        throw new Error("No image URL in CogView response")
      }

      // Download the temporary URL (valid 30 days) and save permanently
      const fileRecord = await saveFromUrl(
        imageData.url,
        workspaceId,
        null,
        "generated_image.png",
        buildToolOutputOrigin({
          system: FILE_ORIGIN_SYSTEMS.ZHIPU_IMAGE_GENERATION,
          providerKey: "bigmodel",
          details: {
            model,
            prompt,
          },
        })
      )

      // Return canonical file_ref block — already saved, ingest pipeline will pass through
      return [
        { type: "text", text: `Generated image: ${fileRecord.originalName}` },
        pluginOutputFileRef(fileRecord),
      ]
    } catch (error) {
      throw normalizeZhipuTransportError("图像生成 API", error)
    } finally {
      clearTimeout(timeout)
    }
  },
}
