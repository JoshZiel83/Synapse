import type {
  AIResponse,
  ToolDefinition,
  ToolCall,
  ConversationMessage,
  MultimodalConfig,
  CanonicalContentBlock,
  ProviderContextWindow,
} from "@synapse/shared"
import {
  extractText,
  formatBytes,
  formatMentionText,
  formatStructuredContentForProvider,
  textBlock,
} from "@synapse/shared"
import { randomUUID } from "crypto"
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
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("ai.openai")

const SUPPORTED_IMAGE_FORMATS = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

// OpenAI enforces 20 MB per image
const BASE64_THRESHOLD = 20 * 1024 * 1024

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
    log.error({ err }, `[openai] Failed to convert ${mimeType} to PNG`)
    return { buffer, mimeType }
  }
}

export class OpenAIChatCompletionsProvider implements AIProvider {
  readonly name = "openai"
  readonly kind = "openai.chat_completions" as const
  private config: AIProviderConfig

  constructor(config: AIProviderConfig) {
    this.config = config
  }

  async chat(params: {
    system: string
    contextWindow: ProviderContextWindow
    branchState?: import("@synapse/shared").EngineBranchState
    tools?: ToolDefinition[]
    multimodal?: MultimodalConfig
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, "")
    const resumeState =
      params.branchState?.engineKind === this.kind
        ? params.branchState
        : undefined
    const resumedMessages = Array.isArray(resumeState?.nativeState?.messages)
      ? (resumeState?.nativeState?.messages as Record<string, unknown>[])
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
    const openaiMessages = canResume
      ? [
          ...resumedMessages,
          ...(await this.convertMessages(
            conversationMessages,
            params.system,
            params.multimodal,
            false
          )),
        ]
      : await this.convertMessages(
          conversationMessages,
          params.system,
          params.multimodal,
          true
        )

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: openaiMessages,
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          // Prefer lossless raw JSON Schema (remote/stdio MCP) over the lossy
          // `parameters` projection.
          parameters: t.rawInputSchema ?? t.parameters,
        },
      }))
      body.tool_choice = "auto"
    }

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`OpenAI API error (${response.status}): ${errorBody}`)
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          role: string
          content?: string
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
        finish_reason?: string
      }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    const choice = data.choices[0]
    const message = choice?.message
    const toolCalls: ToolCall[] = []
    const textContent = message?.content || ""

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        try {
          const input = JSON.parse(tc.function.arguments)
          toolCalls.push({
            callId: randomUUID(),
            providerCallId: tc.id,
            toolName: tc.function.name,
            input,
          })
        } catch {
          log.error(
            `Failed to parse tool call arguments for ${tc.function.name}`
          )
        }
      }
    }

    // Build canonical context
    const contentBlocks: CanonicalContentBlock[] = []
    if (textContent) contentBlocks.push(textBlock(textContent))

    const assistantMsg: ConversationMessage = {
      role: "assistant" as const,
      content: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }

    const assistantNativeMessage: Record<string, unknown> = {
      role: "assistant",
      content: textContent || null,
    }
    if (toolCalls.length > 0) {
      assistantNativeMessage.tool_calls = toolCalls.map((tc) => ({
        id: tc.providerCallId || tc.callId,
        type: "function",
        function: {
          name: tc.toolName,
          arguments: JSON.stringify(tc.input),
        },
      }))
    }

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
            messages: [...openaiMessages, assistantNativeMessage],
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
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
      stopReason: choice?.finish_reason || "stop",
      rawAssistantMessage: message,
      branchState,
    }
  }

  async rebuildBranchState(params: {
    system: string
    contextWindow: ProviderContextWindow
    branchState: import("@synapse/shared").EngineBranchState
    tools?: ToolDefinition[]
    builtinTools?: import("@synapse/shared").AnthropicBuiltinTool[]
    multimodal?: MultimodalConfig
  }) {
    const preparedWindow = await this.compressContextWindow(
      params.contextWindow
    )
    const conversationMessages = await this.compileContextWindow(preparedWindow)
    const messages = await this.convertMessages(
      conversationMessages,
      params.system,
      params.multimodal,
      true
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
    systemPrompt: string,
    multimodal?: MultimodalConfig,
    includeSystem = true
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = includeSystem
      ? [{ role: "system", content: systemPrompt }]
      : []

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const resolved = await this.resolveBlocks(msg.content, multimodal)
          // If we have mixed content (images etc), use content array; otherwise plain string
          const hasNonText = resolved.nativeBlocks.some(
            (b: any) => b.type !== "text"
          )
          result.push({
            role: "user",
            content: hasNonText ? resolved.nativeBlocks : resolved.textFallback,
          })
          break
        }

        case "assistant": {
          const text = extractText(msg.content)
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            result.push({
              role: "assistant",
              content: text || null,
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.providerCallId || tc.callId,
                type: "function",
                function: {
                  name: tc.toolName,
                  arguments: JSON.stringify(tc.input),
                },
              })),
            })
          } else {
            result.push({ role: "assistant", content: text })
          }
          break
        }

        case "tool_result": {
          for (const tr of msg.results) {
            const { textFallback } = await this.resolveBlocks(
              tr.content,
              multimodal
            )
            // OpenAI's tool message content is plain string. Append the
            // MCP structuredContent (if any) as a tagged JSON suffix so
            // the LLM still receives the structured sidecar payload.
            const structuredSuffix = formatStructuredContentForProvider(
              tr.structuredContent
            )
            result.push({
              role: "tool",
              tool_call_id: tr.providerCallId || tr.toolCallId,
              content: textFallback + structuredSuffix,
            })
          }
          break
        }
      }
    }

    return result
  }

  // ─── Internal: resolve CanonicalContentBlock[] → OpenAI native blocks ───

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
        const desc =
          block.category === "audio"
            ? await buildAudioFallbackContext(
                { ...block, category: "audio" },
                "Audio input is not enabled for this model configuration."
              )
            : block.category === "image"
              ? await buildImageFallbackContext(
                  { ...block, category: "image" },
                  "Image input is not enabled for this model configuration."
                )
              : `[${block.category}: ${block.name} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
        // Always inject FileRef hint even for unsupported types
        const hint = this.buildFileRefHint(
          block.sha256,
          block.name,
          block.category
        )
        nativeBlocks.push({ type: "text", text: hint })
        textParts.push(hint)
        continue
      }

      // Supported — read from disk and build OpenAI native block
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
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${buffer.toString("base64")}`,
                },
              }
            } else {
              nativeBlock = {
                type: "image_url",
                image_url: { url: getFullContentUrlBySha(block.sha256) },
              }
            }
            break
          }
          case "audio": {
            const format = mimeType.includes("wav")
              ? "wav"
              : mimeType.includes("mp3") || mimeType.includes("mpeg")
                ? "mp3"
                : "wav"
            nativeBlock = {
              type: "input_audio",
              input_audio: { data: buffer.toString("base64"), format },
            }
            break
          }
          case "document":
            // OpenAI Chat Completions API does not support document/PDF blocks
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
          const desc = `[${block.category}: ${block.name} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`
          nativeBlocks.push({ type: "text", text: desc })
          textParts.push(desc)
        }
      } catch (err: any) {
        log.error(
          { err: err.message },
          `[openai] Failed to resolve file_ref ${block.sha256}`
        )
        const desc = `[${block.category}: ${block.name} (read failed)]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
      }

      // Inject FileRef hint after every file_ref block
      const hint = this.buildFileRefHint(
        block.sha256,
        block.name,
        block.category
      )
      nativeBlocks.push({ type: "text", text: hint })
      textParts.push(hint)
    }

    return { nativeBlocks, textFallback: textParts.join("\n") }
  }

  private buildFileRefHint(
    fileId: string,
    originalName: string,
    category: string
  ): string {
    return [
      `This ${category} "${originalName}" is available as <FileRef id="${fileId}"/>.`,
      `To display it in your response, use exactly: <FileRef id="${fileId}"/>.`,
      `If a tool parameter expects a fileRef, pass the same exact string <FileRef id="${fileId}"/> instead of inventing a URL or data URI.`,
    ].join(" ")
  }
}
