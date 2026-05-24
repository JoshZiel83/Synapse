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
  formatMentionText,
  formatStructuredContentForProvider,
  getModelMaxTokensLimit,
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
import { getFullFileUrlById, readFileBufferById } from "../../files/service.js"

const SUPPORTED_IMAGE_FORMATS = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

const BASE64_THRESHOLD = 5 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    console.error(`[bigmodel] Failed to convert ${mimeType} to PNG:`, err)
    return { buffer, mimeType }
  }
}

function buildBigModelChatEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "")
  if (normalized.endsWith("/paas/v4/chat/completions")) return normalized
  if (normalized.endsWith("/paas/v4")) return `${normalized}/chat/completions`
  return `${normalized}/paas/v4/chat/completions`
}

function flattenAssistantContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return ""
      const candidate = block as Record<string, unknown>
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : ""
    })
    .join("")
}

export class BigModelChatCompletionsProvider implements AIProvider {
  readonly name = "bigmodel"
  readonly kind = "bigmodel.chat_completions" as const
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
    const endpoint = buildBigModelChatEndpoint(this.config.baseUrl)
    const maxTokensLimit = getModelMaxTokensLimit(
      this.name,
      this.kind,
      this.config.model
    )
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
    const nativeMessages = canResume
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
      max_tokens:
        typeof maxTokensLimit === "number"
          ? Math.min(this.config.maxTokens, maxTokensLimit)
          : this.config.maxTokens,
      messages: nativeMessages,
    }

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
      body.tool_choice = "auto"
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`BigModel API error (${response.status}): ${errorBody}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          role?: string
          content?: string | Array<{ type?: string; text?: string }>
          tool_calls?: Array<{
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
          reasoning_content?: string
        }
        finish_reason?: string
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const choice = data.choices?.[0]
    const message = choice?.message
    const textContent = flattenAssistantContent(message?.content)
    const toolCalls: ToolCall[] = []

    if (Array.isArray(message?.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.type && toolCall.type !== "function") continue
        if (
          !toolCall.function?.name ||
          typeof toolCall.function.arguments !== "string"
        )
          continue
        try {
          toolCalls.push({
            callId: randomUUID(),
            providerCallId: toolCall.id,
            toolName: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          })
        } catch {
          console.error(
            `Failed to parse BigModel tool call arguments for ${toolCall.function.name}`
          )
        }
      }
    }

    const contentBlocks: CanonicalContentBlock[] = []
    if (textContent) contentBlocks.push(textBlock(textContent))

    const assistantMsg: ConversationMessage = {
      role: "assistant",
      content: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    }

    const assistantNativeMessage: Record<string, unknown> = {
      role: "assistant",
      content: textContent || null,
    }
    if (toolCalls.length > 0) {
      assistantNativeMessage.tool_calls = toolCalls.map((toolCall) => ({
        id: toolCall.providerCallId || toolCall.callId,
        type: "function",
        function: {
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.input),
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
            messages: [...nativeMessages, assistantNativeMessage],
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
          const hasNonText = resolved.nativeBlocks.some(
            (block: any) => block.type !== "text"
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
              tool_calls: msg.toolCalls.map((toolCall) => ({
                id: toolCall.providerCallId || toolCall.callId,
                type: "function",
                function: {
                  name: toolCall.toolName,
                  arguments: JSON.stringify(toolCall.input),
                },
              })),
            })
          } else {
            result.push({ role: "assistant", content: text })
          }
          break
        }
        case "tool_result": {
          for (const resultItem of msg.results) {
            const { textFallback } = await this.resolveBlocks(
              resultItem.content,
              multimodal
            )
            const structuredSuffix = formatStructuredContentForProvider(
              resultItem.structuredContent
            )
            result.push({
              role: "tool",
              tool_call_id: resultItem.providerCallId || resultItem.toolCallId,
              content: textFallback + structuredSuffix,
            })
          }
          break
        }
      }
    }

    return result
  }

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
              : `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
        const hint = this.buildFileRefHint(
          block.fileId,
          block.originalName,
          block.category
        )
        nativeBlocks.push({ type: "text", text: hint })
        textParts.push(hint)
        continue
      }

      try {
        let buffer = await readFileBufferById(block.fileId)
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
          case "image":
            nativeBlock =
              buffer.length <= BASE64_THRESHOLD
                ? {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${buffer.toString("base64")}`,
                    },
                  }
                : {
                    type: "image_url",
                    image_url: { url: getFullFileUrlById(block.fileId) },
                  }
            break
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
            nativeBlock = {
              type: "file_url",
              file_url: { url: getFullFileUrlById(block.fileId) },
            }
            break
          case "video":
            nativeBlock = {
              type: "video_url",
              video_url: { url: getFullFileUrlById(block.fileId) },
            }
            break
        }

        if (nativeBlock) {
          nativeBlocks.push(nativeBlock)
          textParts.push(`[${block.category}: ${block.originalName}]`)
        } else {
          const desc = `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`
          nativeBlocks.push({ type: "text", text: desc })
          textParts.push(desc)
        }
      } catch (err: any) {
        console.error(
          `[bigmodel] Failed to resolve file_ref ${block.fileId}:`,
          err.message
        )
        const desc = `[${block.category}: ${block.originalName} (read failed)]`
        nativeBlocks.push({ type: "text", text: desc })
        textParts.push(desc)
      }

      const hint = this.buildFileRefHint(
        block.fileId,
        block.originalName,
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
