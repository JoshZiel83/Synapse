import type {
  AIResponse,
  ToolDefinition,
  ToolCall,
  AnthropicBuiltinTool,
  ConversationMessage,
  MultimodalConfig,
  CanonicalContentBlock,
  ProviderContextWindow,
} from "@synapse/shared"
import {
  extractText,
  formatMentionText,
  formatStructuredContentForProvider,
  textBlock,
} from "@synapse/shared"
import { createHash, randomUUID } from "crypto"
import type { AIProvider, AIProviderConfig, FileRefSegment } from "./types.js"
import {
  compileContextWindowToConversationMessages,
  compressContextWindow,
} from "../context-compiler.js"
import { parseFileRefSegments } from "../fileref-resolver.js"
import { buildAudioFallbackContext } from "../audio-fallback.js"
import { buildImageFallbackContext } from "../image-fallback.js"
import {
  advanceEngineBranchState,
  buildContextManifestHash,
  buildAssistantMessageAppliedKey,
  buildToolCallBatchAppliedKey,
  buildBranchDeltaWindow,
  canResumeBranchFromWindow,
} from "../engine-branches.js"
import {
  getFullContentUrlBySha,
  readContentBufferBySha,
} from "../../files/service.js"

// Map tool names to their latest versioned type identifiers
const BUILTIN_TOOL_TYPES: Record<string, string> = {
  web_search: "web_search_20250305",
  web_fetch: "web_fetch_20250910",
}

const SUPPORTED_IMAGE_FORMATS = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

// Anthropic API enforces 5 MB per base64 image/document
const BASE64_THRESHOLD = 5 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function buildAnthropicToolAlias(
  rawName: string,
  usedAliases: Set<string>
): string {
  const normalized = rawName.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool"
  const hash = createHash("sha256").update(rawName).digest("hex").slice(0, 8)
  let candidate = normalized

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(candidate)) {
    candidate = normalized.slice(0, 119) + "_" + hash
  }

  if (candidate.length > 128) {
    candidate = candidate.slice(0, 128)
  }

  if (candidate !== rawName || usedAliases.has(candidate)) {
    const suffix = "_" + hash
    const base = normalized.slice(0, Math.max(1, 128 - suffix.length))
    candidate = `${base}${suffix}`
  }

  while (usedAliases.has(candidate)) {
    const retryHash = createHash("sha256")
      .update(`${rawName}:${candidate}`)
      .digest("hex")
      .slice(0, 8)
    const suffix = "_" + retryHash
    const base = normalized.slice(0, Math.max(1, 128 - suffix.length))
    candidate = `${base}${suffix}`
  }

  usedAliases.add(candidate)
  return candidate
}

function buildToolNameMaps(tools: ToolDefinition[]) {
  const aliasToCanonical = new Map<string, string>()
  const canonicalToAlias = new Map<string, string>()
  const usedAliases = new Set<string>()

  for (const tool of tools) {
    const alias = buildAnthropicToolAlias(tool.name, usedAliases)
    aliasToCanonical.set(alias, tool.name)
    canonicalToAlias.set(tool.name, alias)
  }

  return { aliasToCanonical, canonicalToAlias }
}

async function ensureSupportedFormat(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (SUPPORTED_IMAGE_FORMATS.has(mimeType)) {
    return { buffer, mimeType }
  }
  try {
    const sharp = (await import("sharp")).default
    const converted = await sharp(buffer).png().toBuffer()
    return { buffer: converted, mimeType: "image/png" }
  } catch (err) {
    console.error(`[anthropic] Failed to convert ${mimeType} to PNG:`, err)
    return { buffer, mimeType }
  }
}

function extractAnthropicServerToolCalls(
  blocks: Array<Record<string, any>>
): AIResponse["serverToolCalls"] {
  const calls: NonNullable<AIResponse["serverToolCalls"]> = []
  const pendingByUseId = new Map<
    string,
    NonNullable<AIResponse["serverToolCalls"]>[number]
  >()

  for (const block of blocks) {
    if (block.type === "server_tool_use") {
      const call = {
        type:
          block.name === "web_fetch"
            ? ("web_fetch" as const)
            : ("web_search" as const),
      } as NonNullable<AIResponse["serverToolCalls"]>[number]
      if (block.name === "web_search" && block.input?.query) {
        call.query = block.input.query
      }
      if (block.name === "web_fetch" && block.input?.url) {
        call.url = block.input.url
      }
      if (block.id) pendingByUseId.set(block.id, call)
      calls.push(call)
      continue
    }

    if (block.type === "web_search_tool_result" && block.tool_use_id) {
      const parent = pendingByUseId.get(block.tool_use_id)
      if (parent && Array.isArray(block.content)) {
        parent.results = block.content
          .filter((item: any) => item.type === "web_search_result" && item.url)
          .map((item: any) => ({
            url: item.url,
            title: item.title || "",
            pageAge: item.page_age,
          }))
      }
      continue
    }

    if (block.type === "web_fetch_tool_result" && block.tool_use_id) {
      const parent = pendingByUseId.get(block.tool_use_id)
      if (parent && block.content?.url) {
        parent.url = block.content.url
      }
    }
  }

  return calls.length > 0 ? calls : undefined
}

function extractAnthropicCitationSources(
  blocks: Array<Record<string, any>>
): Record<string, { url: string; title: string }> | undefined {
  const sources: Record<string, { url: string; title: string }> = {}
  let hasSources = false

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (
      block.type === "web_search_tool_result" &&
      Array.isArray(block.content)
    ) {
      const results = block.content.filter(
        (item: any) => item.type === "web_search_result"
      )
      for (let j = 0; j < results.length; j += 1) {
        const result = results[j]
        if (!result.url) continue
        sources[`${i}-${j}`] = {
          url: result.url,
          title: result.title || "",
        }
        hasSources = true
      }
    }

    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const citation of block.citations) {
        if (!citation.url || citation.type !== "web_search_result_location")
          continue
        const key = `cit-${citation.url}`
        if (sources[key]) continue
        sources[key] = {
          url: citation.url,
          title: citation.title || "",
        }
        hasSources = true
      }
    }
  }

  return hasSources ? sources : undefined
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic"
  readonly kind = "anthropic.messages" as const
  private config: AIProviderConfig

  constructor(config: AIProviderConfig) {
    this.config = config
  }

  async chat(params: {
    system: string
    contextWindow: ProviderContextWindow
    branchState?: import("@synapse/shared").EngineBranchState
    tools?: ToolDefinition[]
    builtinTools?: AnthropicBuiltinTool[]
    multimodal?: MultimodalConfig
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, "")
    const toolNameMaps = buildToolNameMaps(params.tools || [])
    const resumeState =
      params.branchState?.engineKind === this.kind
        ? params.branchState
        : undefined
    const resumedMessages = Array.isArray(resumeState?.nativeState?.messages)
      ? (resumeState.nativeState.messages as Record<string, unknown>[])
      : null
    const canResume =
      !!resumedMessages &&
      resumeState?.metadata?.systemPrompt === params.system &&
      canResumeBranchFromWindow(params.contextWindow, resumeState)

    const sourceWindow = canResume
      ? buildBranchDeltaWindow(params.contextWindow, resumeState)
      : params.contextWindow
    const preparedWindow = await this.compressContextWindow(sourceWindow)
    const conversationMessages = await this.compileContextWindow(preparedWindow)
    const deltaMessages = await this.convertMessages(
      conversationMessages,
      params.multimodal,
      toolNameMaps.canonicalToAlias
    )
    const allMessages = canResume
      ? [...resumedMessages, ...deltaMessages]
      : deltaMessages

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: params.system,
      messages: allMessages,
    }

    // Build tools array: custom tools + built-in server tools
    const allTools: Record<string, unknown>[] = []

    if (params.tools && params.tools.length > 0) {
      for (const t of params.tools) {
        allTools.push({
          name: toolNameMaps.canonicalToAlias.get(t.name) || t.name,
          description: t.description,
          input_schema: t.parameters,
        })
      }
    }

    if (params.builtinTools && params.builtinTools.length > 0) {
      for (const toolName of params.builtinTools) {
        const toolType = BUILTIN_TOOL_TYPES[toolName]
        if (toolType) {
          allTools.push({
            type: toolType,
            name: toolName,
          })
        }
      }
    }

    if (allTools.length > 0) {
      body.tools = allTools
      body.tool_choice = { type: "auto" }
    }

    // Increase timeout when server tools are enabled (they can take a long time)
    const hasServerTools = params.builtinTools && params.builtinTools.length > 0
    const timeoutMs = hasServerTools ? 300_000 : 120_000

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`)
    }

    const data = (await response.json()) as {
      content: Array<{
        type: string
        id?: string
        text?: string
        name?: string
        input?: Record<string, unknown>
        citations?: unknown[]
      }>
      usage: { input_tokens: number; output_tokens: number }
      stop_reason?: string
    }

    const toolCalls: ToolCall[] = []
    let textContent = ""
    const mediaBlocks: unknown[] = []

    // Debug: log content block types for diagnosing server tool behavior
    const blockTypes = data.content.map((b) => b.type)
    if (blockTypes.some((t) => t !== "text" && t !== "tool_use")) {
      console.log(
        `[anthropic] non-standard blocks: ${JSON.stringify(blockTypes)} stop_reason=${data.stop_reason}`
      )
    }

    for (const block of data.content) {
      if (block.type === "tool_use" && block.name && block.input) {
        toolCalls.push({
          callId: randomUUID(),
          providerCallId: block.id || undefined,
          toolName: toolNameMaps.aliasToCanonical.get(block.name) || block.name,
          input: block.input,
        })
      } else if (block.type === "text" && block.text) {
        textContent += block.text
      } else if (block.type === "image") {
        // Collect media blocks from model response for ingestion
        mediaBlocks.push(block)
      }
      // Skip server_tool_use, web_search_tool_result, web_fetch_tool_result
      // These are intermediate blocks handled by Anthropic's server
    }

    // Build canonical context
    const contentBlocks: CanonicalContentBlock[] = []
    if (textContent) contentBlocks.push(textBlock(textContent))

    const assistantMsg: ConversationMessage = {
      role: "assistant" as const,
      content: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }

    const rawAssistantMessage = data.content as Array<Record<string, any>>
    const appliedKeys = [
      textContent
        ? buildAssistantMessageAppliedKey(
            params.branchState?.sessionId,
            textContent
          )
        : undefined,
      buildToolCallBatchAppliedKey(toolCalls, textContent),
    ].filter((value): value is string => !!value)
    const branchState = params.branchState?.sessionId
      ? advanceEngineBranchState(
          params.branchState,
          params.contextWindow,
          {
            messages: [
              ...allMessages,
              { role: "assistant", content: rawAssistantMessage },
            ],
          },
          {
            systemPrompt: params.system,
            contextManifestHash: buildContextManifestHash(params.contextWindow),
          },
          appliedKeys.length > 0 ? appliedKeys : undefined
        )
      : undefined

    return {
      context: [assistantMsg],
      tokensUsed: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
      },
      stopReason: data.stop_reason || "end_turn",
      rawAssistantMessage,
      mediaBlocks: mediaBlocks.length > 0 ? mediaBlocks : undefined,
      serverToolCalls: extractAnthropicServerToolCalls(rawAssistantMessage),
      citationSources: extractAnthropicCitationSources(rawAssistantMessage),
      branchState,
    }
  }

  async rebuildBranchState(params: {
    system: string
    contextWindow: ProviderContextWindow
    branchState: import("@synapse/shared").EngineBranchState
    tools?: ToolDefinition[]
    builtinTools?: AnthropicBuiltinTool[]
    multimodal?: MultimodalConfig
  }) {
    const toolNameMaps = buildToolNameMaps(params.tools || [])
    const preparedWindow = await this.compressContextWindow(
      params.contextWindow
    )
    const conversationMessages = await this.compileContextWindow(preparedWindow)
    const messages = await this.convertMessages(
      conversationMessages,
      params.multimodal,
      toolNameMaps.canonicalToAlias
    )

    return advanceEngineBranchState(
      params.branchState,
      params.contextWindow,
      { messages },
      {
        systemPrompt: params.system,
        contextManifestHash: buildContextManifestHash(params.contextWindow),
      }
    )
  }

  protected async compressContextWindow(window: ProviderContextWindow) {
    return compressContextWindow(window)
  }

  protected async compileContextWindow(window: ProviderContextWindow) {
    return compileContextWindowToConversationMessages(window)
  }

  parseFileRefs(text: string): FileRefSegment[] {
    return parseFileRefSegments(text)
  }

  // ─── Internal: message conversion ───

  private async convertMessages(
    messages: ConversationMessage[],
    multimodal?: MultimodalConfig,
    canonicalToAlias?: Map<string, string>
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = []

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const { nativeBlocks } = await this.resolveBlocks(
            msg.content,
            multimodal
          )
          this.appendOrMerge(result, "user", nativeBlocks)
          break
        }

        case "assistant": {
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            const contentBlocks: unknown[] = []
            const text = extractText(msg.content)
            if (text) {
              contentBlocks.push({ type: "text", text })
            }
            for (const tc of msg.toolCalls) {
              contentBlocks.push({
                type: "tool_use",
                id: tc.providerCallId || tc.callId,
                name:
                  canonicalToAlias?.get(tc.toolName) ||
                  buildAnthropicToolAlias(tc.toolName, new Set()),
                input: tc.input,
              })
            }
            this.appendOrMerge(result, "assistant", contentBlocks)
          } else {
            const text = extractText(msg.content)
            this.appendOrMerge(result, "assistant", text)
          }
          break
        }

        case "tool_result": {
          const toolResultBlocks: unknown[] = []
          for (const tr of msg.results) {
            const { nativeBlocks } = await this.resolveBlocks(
              tr.content,
              multimodal
            )
            // structuredContent (MCP protocol sidecar JSON) gets appended as
            // an additional text block so the LLM sees it inline with the
            // primary tool content. Anthropic has no native structuredContent
            // field on tool_result.
            const structuredSuffix = formatStructuredContentForProvider(
              tr.structuredContent
            )
            const contentArr: unknown[] =
              nativeBlocks.length > 0 ? [...nativeBlocks] : []
            if (structuredSuffix) {
              contentArr.push({
                type: "text",
                text: structuredSuffix.trimStart(),
              })
            }
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: tr.providerCallId || tr.toolCallId,
              content: contentArr.length > 0 ? contentArr : "",
              is_error: tr.isError || false,
            })
          }
          this.appendOrMerge(result, "user", toolResultBlocks)
          break
        }
      }
    }

    // Anthropic rejects requests that end with an assistant-prefill message.
    // Group/session retries can legitimately rebuild a transcript whose latest
    // visible item is authored by the actor, so we add a synthetic user turn.
    const last = result[result.length - 1]
    if (last?.role === "assistant") {
      result.push({
        role: "user",
        content: [{ type: "text", text: "Please continue." }],
      })
    }

    return result
  }

  // ─── Internal: resolve CanonicalContentBlock[] → Anthropic native blocks ───

  private async resolveBlocks(
    blocks: CanonicalContentBlock[],
    multimodal?: MultimodalConfig
  ): Promise<{ nativeBlocks: unknown[]; textFallback: string }> {
    const supportedTypes = multimodal?.supported
      ? new Set(multimodal.types)
      : new Set<string>()
    const nativeBlocks: unknown[] = []
    const textParts: string[] = []

    for (const block of blocks) {
      if (block.type === "text") {
        nativeBlocks.push({ type: "text", text: block.text })
        textParts.push(block.text)
        continue
      }

      if (block.type === "mention") {
        const text = formatMentionText(block)
        nativeBlocks.push({ type: "text", text })
        textParts.push(text)
        continue
      }

      // file_ref block — check multimodal capability
      if (!supportedTypes.has(block.category)) {
        // Unsupported — text fallback
        const desc =
          block.category === "audio"
            ? await buildAudioFallbackContext(
                { ...block, category: "audio" },
                "Audio input is not enabled for this provider request."
              )
            : block.category === "image"
              ? await buildImageFallbackContext(
                  { ...block, category: "image" },
                  "Image input is not enabled for this provider request."
                )
              : `[${block.category}: ${block.name} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
        // Always inject FileRef hint even for unsupported types
        nativeBlocks.push({
          type: "text",
          text: this.buildFileRefHint(
            block.sha256,
            block.path,
            block.name,
            block.category
          ),
        })
        continue
      }

      // Supported — read from CAS by sha256 and build Anthropic native block
      try {
        let buffer = await readContentBufferBySha(block.sha256)
        if (!buffer) {
          throw new Error("file not found")
        }
        let mimeType = block.mimeType

        if (block.category === "image") {
          const converted = await ensureSupportedFormat(buffer, mimeType)
          buffer = converted.buffer
          mimeType = converted.mimeType
        }

        let nativeBlock: unknown | null = null
        switch (block.category) {
          case "image": {
            if (buffer.length <= BASE64_THRESHOLD) {
              nativeBlock = {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: buffer.toString("base64"),
                },
              }
            } else {
              nativeBlock = {
                type: "image",
                source: {
                  type: "url",
                  url: getFullContentUrlBySha(block.sha256),
                },
              }
            }
            break
          }
          case "document": {
            if (buffer.length <= BASE64_THRESHOLD) {
              nativeBlock = {
                type: "document",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: buffer.toString("base64"),
                },
              }
            } else {
              nativeBlock = {
                type: "document",
                source: {
                  type: "url",
                  url: getFullContentUrlBySha(block.sha256),
                },
              }
            }
            break
          }
          case "audio":
            // Anthropic Messages API does not accept audio input
            nativeBlock = null
            break
          case "video":
            nativeBlock = null
            break
        }

        if (nativeBlock) {
          nativeBlocks.push(nativeBlock)
          textParts.push(`[${block.category}: ${block.name}]`)
        } else {
          const desc =
            block.category === "audio"
              ? await buildAudioFallbackContext(
                  { ...block, category: "audio" },
                  "Direct audio input is not available for Anthropic in this request."
                )
              : block.category === "image"
                ? await buildImageFallbackContext(
                    { ...block, category: "image" },
                    "Direct image input is not available for Anthropic in this request."
                  )
                : `[${block.category}: ${block.name} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`
          nativeBlocks.push({ type: "text", text: desc })
          textParts.push(desc)
        }
      } catch (err: any) {
        console.error(
          `[anthropic] Failed to resolve file_ref ${block.sha256}:`,
          err.message
        )
        const desc = `[${block.category}: ${block.name} (read failed)]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
      }

      // Inject FileRef hint after every file_ref block
      nativeBlocks.push({
        type: "text",
        text: this.buildFileRefHint(
          block.sha256,
          block.path,
          block.name,
          block.category
        ),
      })
    }

    return { nativeBlocks, textFallback: textParts.join("\n") }
  }

  private buildFileRefHint(
    sha256: string,
    path: string | undefined,
    name: string,
    category: string
  ): string {
    // Prefer the LLM-visible path handle when the ref came from a mounted
    // sandbox space; fall back to the sha256 content ref for history-only
    // references that have no live path.
    const handle = path ?? `sha256:${sha256}`
    return [
      `This ${category} "${name}" is available at ${handle}.`,
      path
        ? `To reference it, use its path: ${path}.`
        : `It is a stored content reference (no live path).`,
    ].join(" ")
  }

  // ─── Internal: role alternation helpers ───

  private appendOrMerge(
    result: Record<string, unknown>[],
    role: string,
    content: string | unknown[]
  ): void {
    if (result.length > 0) {
      const last = result[result.length - 1]
      if (last.role === role) {
        const prevContent = this.normalizeContent(last.content)
        const newContent = this.normalizeContent(content)
        last.content = [...prevContent, ...newContent]
        return
      }
    }
    result.push({ role, content })
  }

  private normalizeContent(content: unknown): unknown[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }]
    }
    if (Array.isArray(content)) {
      return content
    }
    return [{ type: "text", text: String(content) }]
  }
}
