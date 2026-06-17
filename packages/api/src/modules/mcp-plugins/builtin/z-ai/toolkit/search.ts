import { textBlocks, ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import type { BuiltinPluginExecuteResult } from "../../index.js"
import {
  normalizeZhipuTransportError,
  readZhipuJsonObjectResponse,
  throwZhipuApiError,
} from "./zhipu-errors.js"

const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4"
const SEARCH_ENGINES = [
  "search_std",
  "search_pro",
  "search_pro_sogou",
  "search_pro_quark",
]
const SEARCH_RECENCY_FILTERS = [
  "oneDay",
  "oneWeek",
  "oneMonth",
  "oneYear",
  "noLimit",
]
const CONTENT_SIZES = ["medium", "high"]

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "webSearchPrime",
    description:
      "Search the web using the official ZhipuAI Web Search API. " +
      "Returns result titles, URLs, summaries, site names, icons, publish dates, and optional search-intent rewriting metadata.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query. The official API recommends keeping it within 70 characters.",
        },
        searchEngine: {
          type: "string",
          description:
            "Search engine backend. If omitted, this wrapper defaults to search_std.",
          enum: SEARCH_ENGINES,
        },
        searchIntent: {
          type: "boolean",
          description:
            "Whether to let the API detect search intent before executing the search. If omitted, this wrapper defaults to false.",
        },
        count: {
          type: "integer",
          description:
            "Number of results to return. Official range: 1-50. If omitted, this wrapper defaults to 10.",
        },
        domainFilter: {
          type: "string",
          description:
            "Optional domain whitelist filter, e.g. www.example.com.",
        },
        recencyFilter: {
          type: "string",
          description:
            "Optional publish-time filter for results. If omitted, this wrapper defaults to noLimit.",
          enum: SEARCH_RECENCY_FILTERS,
        },
        contentSize: {
          type: "string",
          description:
            "How much content to include per result. medium returns shorter summaries; high returns richer result context.",
          enum: CONTENT_SIZES,
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
      required: ["query"],
    },
  },
]

export const searchFeature: SubFeature = {
  featureKey: "feature_search",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult> {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error("ZhipuAI API key not configured.")

    const searchEngine = SEARCH_ENGINES.includes(input.searchEngine as string)
      ? (input.searchEngine as string)
      : "search_std"
    const recencyFilter = SEARCH_RECENCY_FILTERS.includes(
      input.recencyFilter as string
    )
      ? (input.recencyFilter as string)
      : "noLimit"
    const contentSize = CONTENT_SIZES.includes(input.contentSize as string)
      ? (input.contentSize as string)
      : undefined
    const count =
      input.count !== undefined
        ? Math.max(1, Math.min(50, Number(input.count)))
        : 10
    const userId = input.userId as string | undefined

    const body: Record<string, unknown> = {
      search_query: String(input.query || ""),
      search_engine: searchEngine,
      search_intent: Boolean(input.searchIntent),
      count,
      search_recency_filter: recencyFilter,
    }
    if (typeof input.domainFilter === "string" && input.domainFilter.trim()) {
      body.search_domain_filter = input.domainFilter.trim()
    }
    if (contentSize) body.content_size = contentSize
    if (typeof input.requestId === "string" && input.requestId)
      body.request_id = input.requestId
    if (userId && userId.length >= 6 && userId.length <= 128)
      body.user_id = userId

    try {
      const response = await fetch(`${ZHIPU_API_BASE}/web_search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })

      if (!response.ok) {
        await throwZhipuApiError("网络搜索 API", response)
      }

      const result = await readZhipuJsonObjectResponse<{
        request_id?: string
        search_intent?: Array<{
          query?: string
          intent?: string
          keywords?: string
        }>
        search_result?: Array<{
          title?: string
          content?: string
          link?: string
          media?: string
          icon?: string
          refer?: string
          publish_date?: string
        }>
      }>("网络搜索 API", response)

      const sections: string[] = []
      if (result.request_id) {
        sections.push(`Request ID: ${result.request_id}`)
      }
      if (result.search_intent?.length) {
        sections.push(
          [
            "Search intent:",
            ...result.search_intent.map(
              (item, index) =>
                `${index + 1}. query=${item.query || ""}; intent=${item.intent || ""}; keywords=${item.keywords || ""}`
            ),
          ].join("\n")
        )
      }

      const results = result.search_result || []
      if (results.length === 0) {
        sections.push("No search results returned.")
      } else {
        sections.push(
          [
            "Search results:",
            ...results.map((item, index) =>
              [
                `[${item.refer || String(index + 1)}] ${item.title || "(untitled)"}`,
                item.link ? `URL: ${item.link}` : null,
                item.media ? `Site: ${item.media}` : null,
                item.publish_date ? `Published: ${item.publish_date}` : null,
                item.content ? `Summary: ${item.content}` : null,
                item.icon ? `Icon: ${item.icon}` : null,
              ]
                .filter(Boolean)
                .join("\n")
            ),
          ].join("\n\n")
        )
      }

      return textBlocks(sections.join("\n\n"))
    } catch (error) {
      throw normalizeZhipuTransportError("网络搜索 API", error)
    }
  },
}
