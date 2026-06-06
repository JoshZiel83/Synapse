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

/** Extract server-tool calls (web_search/web_fetch) where the SDK surfaces them.
 *  Provider-specific; best-effort from sources for now (additive UI metadata). */
function extractServerToolCalls(
  result: GenerateTextResult<ToolSet, never>
): ServerToolCall[] | undefined {
  // The neutral surface does not separate server-tool calls cleanly across
  // providers; the URL sources above already carry the useful signal. Leave
  // undefined unless a future provider exposes a stable field. (Additive only.)
  void result
  return undefined
}

export function fromGenerateText(
  result: GenerateTextResult<ToolSet, never>
): AdaptedResponse {
  const text = result.text || ""
  const toolCalls: CanonicalToolCall[] = (result.toolCalls ?? []).map((tc) => ({
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
