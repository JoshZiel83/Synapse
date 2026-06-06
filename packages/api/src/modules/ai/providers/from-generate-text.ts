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
import { textBlock } from "@synapse/shared"
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

/** Extract URL citations from provider metadata + the SDK sources array. */
function extractCitations(
  result: GenerateTextResult<ToolSet, never>
): Record<string, { url: string; title: string }> | undefined {
  const sources: Record<string, { url: string; title: string }> = {}
  let has = false
  for (const s of result.sources ?? []) {
    if ((s as any).sourceType === "url" && (s as any).url) {
      sources[`src-${(s as any).url}`] = {
        url: (s as any).url,
        title: (s as any).title || "",
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
  const serverCalls = (result.toolCalls ?? []).filter(
    (tc: any) => tc.providerExecuted === true
  )
  if (serverCalls.length === 0) return undefined

  const resultsByCallId = new Map<string, any>()
  for (const tr of (result.toolResults ?? []) as any[]) {
    if (tr.providerExecuted === true && tr.toolCallId) {
      resultsByCallId.set(tr.toolCallId, tr)
    }
  }

  const out: ServerToolCall[] = []
  for (const tc of serverCalls as any[]) {
    const type: ServerToolCall["type"] =
      tc.toolName === "web_fetch" ? "web_fetch" : "web_search"
    const call: ServerToolCall = { type }
    const input = (tc.input ?? {}) as Record<string, unknown>
    if (type === "web_search" && typeof input.query === "string") {
      call.query = input.query
    }
    if (type === "web_fetch" && typeof input.url === "string") {
      call.url = input.url
    }
    // Pull search results out of the provider-executed tool output when present.
    const output = resultsByCallId.get(tc.toolCallId)?.output
    const items = Array.isArray(output)
      ? output
      : Array.isArray(output?.value)
        ? output.value
        : Array.isArray(output?.content)
          ? output.content
          : []
    const results = items
      .filter((it: any) => it && (it.url || it.type === "web_search_result"))
      .map((it: any) => ({
        url: it.url,
        title: it.title || "",
        ...(it.pageAge || it.page_age
          ? { pageAge: it.pageAge || it.page_age }
          : {}),
      }))
      .filter((r: any) => r.url)
    if (results.length > 0) call.results = results
    out.push(call)
  }
  return out
}

export function fromGenerateText(
  result: GenerateTextResult<ToolSet, never>
): AdaptedResponse {
  const text = result.text || ""
  // Only model-requested (Synapse-executed) tool calls become canonical tool
  // calls. Provider-EXECUTED server tools (web_search/web_fetch) are handled by
  // the provider and surfaced via serverToolCalls — never run by Synapse's loop.
  const toolCalls: CanonicalToolCall[] = (result.toolCalls ?? [])
    .filter((tc: any) => tc.providerExecuted !== true)
    .map((tc) => ({
      callId: randomUUID(),
      providerCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: (tc.input ?? {}) as Record<string, unknown>,
    }))

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
