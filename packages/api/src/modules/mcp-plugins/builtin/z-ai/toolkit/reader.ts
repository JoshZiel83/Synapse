import { ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const RETURN_FORMATS = ["markdown", "text"]

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "webReader",
    description:
      "Read and parse a web page with the official ZhipuAI Reader API. " +
      "Returns the main page content plus title, description, metadata, and optional image/link summaries.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target web page URL to fetch and parse.",
        },
        timeout: {
          type: "integer",
          description:
            "Reader timeout in seconds. If omitted, the official default is 20.",
        },
        noCache: {
          type: "boolean",
          description: "Disable reader-side cache. Official default is false.",
        },
        returnFormat: {
          type: "string",
          description:
            "Reader output format. If omitted, the official default is markdown.",
          enum: RETURN_FORMATS,
        },
        retainImages: {
          type: "boolean",
          description:
            "Whether to keep image references in the returned content. Official default is true.",
        },
        noGfm: {
          type: "boolean",
          description:
            "Disable GitHub Flavored Markdown output. Official default is false.",
        },
        keepImgDataUrl: {
          type: "boolean",
          description:
            "Whether to keep inline image data URLs in the returned content. Official default is false.",
        },
        withImagesSummary: {
          type: "boolean",
          description:
            "Whether to include image summaries in the returned content. Official default is false.",
        },
        withLinksSummary: {
          type: "boolean",
          description:
            "Whether to include link summaries in the returned content. Official default is false.",
        },
      },
      required: ["url"],
    },
  },
]

export const readerFeature: SubFeature = {
  featureKey: "feature_reader",

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

    const body: Record<string, unknown> = {
      url: String(input.url || ""),
    }
    if (input.timeout !== undefined)
      body.timeout = Math.max(1, Number(input.timeout))
    if (typeof input.noCache === "boolean") body.no_cache = input.noCache
    if (typeof input.retainImages === "boolean")
      body.retain_images = input.retainImages
    if (typeof input.noGfm === "boolean") body.no_gfm = input.noGfm
    if (typeof input.keepImgDataUrl === "boolean")
      body.keep_img_data_url = input.keepImgDataUrl
    if (typeof input.withImagesSummary === "boolean")
      body.with_images_summary = input.withImagesSummary
    if (typeof input.withLinksSummary === "boolean")
      body.with_links_summary = input.withLinksSummary
    if (RETURN_FORMATS.includes(input.returnFormat as string))
      body.return_format = input.returnFormat

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60000)

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/reader`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        await throwZhipuApiError("网页阅读 API", response)
      }

      const result = (await response.json()) as {
        request_id?: string
        model?: string
        reader_result?: {
          content?: string
          description?: string
          title?: string
          url?: string
          external?: { stylesheet?: Record<string, { type?: string }> }
          metadata?: Record<string, string>
        }
      }

      const reader = result.reader_result || {}
      const sections = [
        result.request_id ? `Request ID: ${result.request_id}` : null,
        result.model ? `Model: ${result.model}` : null,
        reader.title ? `Title: ${reader.title}` : null,
        reader.url ? `URL: ${reader.url}` : null,
        reader.description ? `Description: ${reader.description}` : null,
        reader.metadata && Object.keys(reader.metadata).length > 0
          ? `Metadata:\n${Object.entries(reader.metadata)
              .map(([key, value]) => `- ${key}: ${value}`)
              .join("\n")}`
          : null,
        reader.external?.stylesheet &&
        Object.keys(reader.external.stylesheet).length > 0
          ? `External stylesheets: ${Object.keys(reader.external.stylesheet).join(", ")}`
          : null,
        reader.content
          ? `Content:\n${reader.content}`
          : "No page content returned.",
      ].filter(Boolean)

      return sections.join("\n\n")
    } catch (error) {
      throw normalizeZhipuTransportError("网页阅读 API", error)
    } finally {
      clearTimeout(timeout)
    }
  },
}
