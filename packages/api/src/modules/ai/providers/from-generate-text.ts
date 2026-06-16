/**
 * Adapt an AI-SDK generateText result into the shape actorThink's loop consumes
 * (the old AIResponse-ish object: assistant ConversationMessage, token usage,
 * stopReason, raw req/resp for audit, server tool calls, citations, media).
 *
 * Tool-call ids: Synapse mints its OWN internal UUID as the canonical `callId`
 * (it becomes the tool_calls.id PK and the neutral toolCallId we replay to the
 * SDK next turn — the SDK regenerates each provider's NATIVE id from it). The
 * SDK's returned id (call_.../toolu_...) is kept as `providerCallId` for audit;
 * it is NOT a UUID and must never be used as the DB key.
 */
import { randomUUID } from "node:crypto"
import type {
  CanonicalContentBlock,
  CanonicalToolCall,
  ConversationMessage,
  ServerToolCall,
} from "@synapse/shared"
import { MODEL_SERVER_TOOL, textBlock } from "@synapse/shared"
import type { GenerateTextResult, ToolSet } from "ai"

export interface AdaptedResponse {
  context: ConversationMessage[]
  tokensUsed: { input: number; output: number }
  stopReason: string
  rawAssistantMessage?: unknown
  rawRequestBody?: unknown
  mediaBlocks?: unknown[]
  serverToolCalls?: ServerToolCall[]
  citationSources?: Record<string, { url: string; title: string }>
}

/** Normalize the v6 nested usage (with flat fallbacks) to {input, output}. */
export function normalizeUsage(
  usage: GenerateTextResult<ToolSet, never>["usage"] | undefined
): {
  input: number
  output: number
} {
  if (!usage) return { input: 0, output: 0 }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return { input, output }
}

type ProviderSourceView = {
  sourceType?: string
  url?: string
  title?: string
}

type ProviderToolCallView = {
  toolCallId?: string
  toolName: string
  input: Record<string, unknown>
  providerExecuted: boolean
}

type ProviderToolResultView = {
  toolCallId?: string
  providerExecuted: boolean
  output?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function readRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function readProviderSources(
  result: GenerateTextResult<ToolSet, never>
): ProviderSourceView[] {
  const rawSources = (result as { sources?: unknown }).sources
  if (!Array.isArray(rawSources)) return []
  return rawSources.filter(isRecord).map((source) => ({
    sourceType: readString(source, "sourceType"),
    url: readString(source, "url"),
    title: readString(source, "title"),
  }))
}

function readProviderToolCalls(
  result: GenerateTextResult<ToolSet, never>
): ProviderToolCallView[] {
  const rawToolCalls = (result as { toolCalls?: unknown }).toolCalls
  if (!Array.isArray(rawToolCalls)) return []
  return rawToolCalls.filter(isRecord).map((toolCall) => ({
    toolCallId: readString(toolCall, "toolCallId"),
    toolName: readString(toolCall, "toolName") ?? "",
    input: readRecord(toolCall, "input") ?? {},
    providerExecuted: toolCall.providerExecuted === true,
  }))
}

function readProviderToolResults(
  result: GenerateTextResult<ToolSet, never>
): ProviderToolResultView[] {
  const rawToolResults = (result as { toolResults?: unknown }).toolResults
  if (!Array.isArray(rawToolResults)) return []
  return rawToolResults.filter(isRecord).map((toolResult) => ({
    toolCallId: readString(toolResult, "toolCallId"),
    providerExecuted: toolResult.providerExecuted === true,
    output: toolResult.output,
  }))
}

function readServerToolOutputItems(output: unknown): Record<string, unknown>[] {
  if (Array.isArray(output)) return output.filter(isRecord)
  if (!isRecord(output)) return []
  const value = output.value
  if (Array.isArray(value)) return value.filter(isRecord)
  const content = output.content
  if (Array.isArray(content)) return content.filter(isRecord)
  return []
}

/** Extract URL citations from provider metadata + the SDK sources array. */
function extractCitations(
  result: GenerateTextResult<ToolSet, never>
): Record<string, { url: string; title: string }> | undefined {
  const sources: Record<string, { url: string; title: string }> = {}
  let has = false
  for (const source of readProviderSources(result)) {
    if (source.sourceType === "url" && source.url) {
      sources[`src-${source.url}`] = {
        url: source.url,
        title: source.title || "",
      }
      has = true
    }
  }
  return has ? sources : undefined
}

/** Extract provider-EXECUTED server-tool calls (Anthropic web_search/web_fetch).
 *  These run inside the provider; the SDK flags them providerExecuted on
 *  result.toolCalls and carries their output on result.toolResults. They are NOT
 *  Synapse tools to run — they go to serverToolCalls (history/UI), and are
 *  filtered out of the Synapse toolCalls in fromGenerateText. */
function extractServerToolCalls(
  result: GenerateTextResult<ToolSet, never>
): ServerToolCall[] | undefined {
  const serverCalls = readProviderToolCalls(result).filter(
    (toolCall) => toolCall.providerExecuted
  )
  if (serverCalls.length === 0) return undefined

  const resultsByCallId = new Map<string, ProviderToolResultView>()
  for (const toolResult of readProviderToolResults(result)) {
    if (toolResult.providerExecuted && toolResult.toolCallId) {
      resultsByCallId.set(toolResult.toolCallId, toolResult)
    }
  }

  const out: ServerToolCall[] = []
  for (const toolCall of serverCalls) {
    const toolName = toolCall.toolName
    // `type` is the coarse bucket; only web_fetch is distinct, everything else
    // (web_search and any other provider-native search tool) buckets as
    // web_search for back-compat — but the authoritative name is preserved so
    // the UI can label an unknown provider tool correctly (fix: was silently
    // mislabeling every non-web_fetch tool "web_search").
    const type: ServerToolCall["type"] =
      toolName === MODEL_SERVER_TOOL.WEB_FETCH
        ? MODEL_SERVER_TOOL.WEB_FETCH
        : MODEL_SERVER_TOOL.WEB_SEARCH
    const call: ServerToolCall = { type, ...(toolName ? { toolName } : {}) }
    const input = toolCall.input
    const query = typeof input.query === "string" ? input.query : undefined
    const url = typeof input.url === "string" ? input.url : undefined
    if (type === MODEL_SERVER_TOOL.WEB_SEARCH && query) call.query = query
    if (type === MODEL_SERVER_TOOL.WEB_FETCH && url) call.url = url
    // Pull search results out of the provider-executed tool output when present.
    const output = toolCall.toolCallId
      ? resultsByCallId.get(toolCall.toolCallId)?.output
      : undefined
    const items = readServerToolOutputItems(output)
    const results = items
      .filter((item) => item.url || item.type === "web_search_result")
      .map((item) => {
        const pageAge =
          typeof item.pageAge === "string"
            ? item.pageAge
            : typeof item.page_age === "string"
              ? item.page_age
              : undefined
        return {
          url: typeof item.url === "string" ? item.url : "",
          title: typeof item.title === "string" ? item.title : "",
          ...(pageAge ? { pageAge } : {}),
        }
      })
      .filter((resultItem) => resultItem.url)
    if (results.length > 0) call.results = results
    call.display = buildServerToolDisplay(call)
    out.push(call)
  }
  return out
}

// Unified display model so the FE renders structure (icon + title + links) with
// no per-tool branching. Chinese fallback strings mirror the activity-bubble
// presentation contract.
function buildServerToolDisplay(
  call: ServerToolCall
): NonNullable<ServerToolCall["display"]> {
  if (call.type === MODEL_SERVER_TOOL.WEB_FETCH) {
    return {
      icon: "globe",
      titleKey: "tool.server.web_fetch.title",
      displayTitle: call.url
        ? `读取网页 ${truncate(call.url, 60)}`
        : "读取网页",
    }
  }
  // web_search (and any other provider-native search-like tool)
  const count = call.results?.length ?? 0
  // Prefer the query; otherwise derive a label from the real tool name so an
  // unknown provider tool isn't mislabeled "网络搜索" (only true web_search with
  // no query falls back to that generic label).
  const label = call.query
    ? `搜索 ${truncate(call.query, 60)}`
    : call.toolName && call.toolName !== MODEL_SERVER_TOOL.WEB_SEARCH
      ? call.toolName
      : "网络搜索"
  return {
    icon: "search",
    titleKey: "tool.server.web_search.title",
    displayTitle: label,
    ...(count > 0 ? { displayDetail: `${count} 个结果` } : {}),
    ...(call.results && call.results.length > 0
      ? { resultLinks: call.results }
      : {}),
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s
}

export function fromGenerateText(
  result: GenerateTextResult<ToolSet, never>
): AdaptedResponse {
  const text = result.text || ""
  // Only model-requested (Synapse-executed) tool calls become canonical tool
  // calls. Provider-EXECUTED server tools (web_search/web_fetch) are handled by
  // the provider and surfaced via serverToolCalls — never run by Synapse's loop.
  const toolCalls: CanonicalToolCall[] = readProviderToolCalls(result)
    .filter((toolCall) => !toolCall.providerExecuted && toolCall.toolName)
    .map((toolCall) => {
      const call: CanonicalToolCall = {
        callId: randomUUID(),
        toolName: toolCall.toolName,
        input: toolCall.input,
      }
      if (toolCall.toolCallId) call.providerCallId = toolCall.toolCallId
      return call
    })

  const contentBlocks: CanonicalContentBlock[] = []
  if (text) contentBlocks.push(textBlock(text))

  const assistantMsg: ConversationMessage = {
    role: "assistant",
    content: contentBlocks,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  }

  // Generated files (e.g. images) → raw media blocks for ingestResponseMedia.
  const mediaBlocks =
    result.files && result.files.length > 0
      ? result.files.map((f) => f)
      : undefined

  return {
    context: [assistantMsg],
    tokensUsed: normalizeUsage(result.usage),
    stopReason: String(result.finishReason ?? "stop"),
    rawAssistantMessage: result.response?.body,
    rawRequestBody: result.request?.body,
    mediaBlocks,
    serverToolCalls: extractServerToolCalls(result),
    citationSources: extractCitations(result),
  }
}
