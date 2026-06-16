import {
  CanonicalContentBlock,
  FILE_ORIGIN_SYSTEMS,
  textBlock,
  ToolDefinition,
} from "@synapse/shared"
import type { SubFeature } from "./types.js"
import type { BuiltinPluginExecuteResult } from "../../index.js"
import { saveFromUrl } from "../../../../../infrastructure/storage/file-io.js"
import {
  fileRefProperty,
  pluginOutputFileRef,
  resolveFileRefRecord,
} from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  readZhipuJsonObjectResponse,
  throwZhipuApiError,
} from "./zhipu-errors.js"
import { buildToolOutputOrigin } from "../../../../files/service.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const DEFAULT_MODEL = "glm-ocr"

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "layout_parsing",
    description:
      "Run the official GLM-OCR layout parsing API on an image or PDF FileRef. " +
      "Returns markdown text plus optional layout visualization images and detailed layout metadata.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty(
          "Image or PDF FileRef to parse with the GLM-OCR layout parsing API."
        ),
        returnCropImages: {
          type: "boolean",
          description:
            "Whether to request crop image information in the layout response. Official default is false.",
        },
        needLayoutVisualization: {
          type: "boolean",
          description:
            "Whether to request layout visualization image URLs. Official default is false.",
        },
        startPageId: {
          type: "integer",
          description: "For PDF files, optional 1-based start page.",
        },
        endPageId: {
          type: "integer",
          description: "For PDF files, optional 1-based end page.",
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

export const layoutParsingFeature: SubFeature = {
  featureKey: "feature_layout_parsing",

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

    const workspaceId = (config.workspace_id as string) || null
    const record = await resolveFileRefRecord(input.fileRef, "fileRef")
    const userId = input.userId as string | undefined

    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      file: record.fullUrl,
    }
    if (typeof input.returnCropImages === "boolean")
      body.return_crop_images = input.returnCropImages
    if (typeof input.needLayoutVisualization === "boolean")
      body.need_layout_visualization = input.needLayoutVisualization
    if (input.startPageId !== undefined)
      body.start_page_id = Math.max(1, Number(input.startPageId))
    if (input.endPageId !== undefined)
      body.end_page_id = Math.max(1, Number(input.endPageId))
    if (typeof input.requestId === "string" && input.requestId)
      body.request_id = input.requestId
    if (userId && userId.length >= 6 && userId.length <= 128)
      body.user_id = userId

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/layout_parsing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      })

      if (!response.ok) {
        await throwZhipuApiError("版面解析 API", response)
      }

      const result = await readZhipuJsonObjectResponse<{
        id?: string
        created?: number
        model?: string
        md_results?: string
        layout_details?: unknown[]
        layout_visualization?: string[]
        data_info?: {
          num_pages?: number
          pages?: Array<{ width?: number; height?: number }>
        }
        request_id?: string
      }>("版面解析 API", response)

      const output: CanonicalContentBlock[] = []
      output.push(
        textBlock(
          [
            result.id ? `Task ID: ${result.id}` : null,
            result.request_id ? `Request ID: ${result.request_id}` : null,
            result.model ? `Model: ${result.model}` : null,
            result.created ? `Created: ${result.created}` : null,
            result.data_info?.num_pages
              ? `Pages: ${result.data_info.num_pages}`
              : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
      )

      if (result.md_results) {
        output.push(textBlock(`Markdown result:\n${result.md_results}`))
      }

      if (result.layout_details) {
        output.push(
          textBlock(
            `Layout details JSON:\n${JSON.stringify(result.layout_details, null, 2)}`
          )
        )
      }

      if (Array.isArray(result.layout_visualization)) {
        for (const [index, url] of result.layout_visualization.entries()) {
          if (!url) continue
          const saved = await saveFromUrl(
            url,
            workspaceId,
            null,
            `${record.originalName || "layout-visualization"}-${index + 1}.png`,
            buildToolOutputOrigin({
              system: FILE_ORIGIN_SYSTEMS.ZHIPU_LAYOUT_PARSING,
              providerKey: "bigmodel",
              parentFileId: record.id,
              details: {
                taskId: result.id,
                visualizationIndex: index + 1,
              },
            })
          )
          output.push(textBlock(`Layout visualization ${index + 1}:`))
          output.push(pluginOutputFileRef(saved))
        }
      }

      return output
    } catch (error) {
      throw normalizeZhipuTransportError("版面解析 API", error)
    }
  },
}
