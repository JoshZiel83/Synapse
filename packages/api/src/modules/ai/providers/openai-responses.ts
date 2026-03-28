import type {
  AIResponse,
  ToolDefinition,
  ToolCall,
  ConversationMessage,
  MultimodalConfig,
  CanonicalContentBlock,
  ProviderContextWindow,
} from "@synapse/shared";
import { extractText, formatMentionText, textBlock } from "@synapse/shared";
import { randomUUID } from "crypto";
import type { AIProvider, AIProviderConfig, FileRefSegment } from "./types.js";
import {
  readAsBuffer,
  getFullUrl,
} from "../../../infrastructure/storage/index.js";
import {
  compileContextWindowToConversationMessages,
  compressContextWindow,
} from "../context-compiler.js";
import { parseFileRefSegments } from "../fileref-resolver.js";
import { buildAudioFallbackContext } from "../audio-fallback.js";
import { buildImageFallbackContext } from "../image-fallback.js";
import {
  advanceEngineBranchState,
  buildAssistantMessageAppliedKey,
  buildToolCallBatchAppliedKey,
  buildBranchDeltaWindow,
  canResumeBranchFromWindow,
} from "../engine-branches.js";

const SUPPORTED_IMAGE_FORMATS = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const BASE64_THRESHOLD = 20 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function ensureSupportedFormat(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (SUPPORTED_IMAGE_FORMATS.has(mimeType)) {
    return { buffer, mimeType };
  }
  try {
    const sharp = (await import("sharp")).default;
    const converted = await sharp(buffer).png().toBuffer();
    return { buffer: converted, mimeType: "image/png" };
  } catch (err) {
    console.error(
      `[openai.responses] Failed to convert ${mimeType} to PNG:`,
      err,
    );
    return { buffer, mimeType };
  }
}

function extractResponseCitationSources(
  rawMessage: any,
): Record<string, { url: string; title: string }> | undefined {
  const sources: Record<string, { url: string; title: string }> = {};
  let hasSources = false;

  const extractFromBlocks = (blocks: any[]) => {
    for (const block of blocks) {
      if (block.type !== "output_text" || !Array.isArray(block.annotations))
        continue;
      for (const ann of block.annotations) {
        if (ann.type === "url_citation" && ann.url) {
          const key = `oai-${ann.url}`;
          sources[key] = { url: ann.url, title: ann.title || "" };
          hasSources = true;
        }
      }
    }
  };

  if (Array.isArray(rawMessage?.output)) {
    for (const item of rawMessage.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        extractFromBlocks(item.content);
      }
    }
  }

  if (Array.isArray(rawMessage?.content)) {
    extractFromBlocks(rawMessage.content);
  }

  return hasSources ? sources : undefined;
}

function injectCitationMarkers(
  textContent: string,
  rawMessage: any,
  citationSources?: Record<string, { url: string; title: string }>,
): string {
  if (!citationSources) return textContent;

  interface Annotation {
    start: number;
    end: number;
    url: string;
  }

  const annotations: Annotation[] = [];
  const extractAnnotations = (blocks: any[]) => {
    for (const block of blocks) {
      if (block.type !== "output_text" || !Array.isArray(block.annotations))
        continue;
      for (const ann of block.annotations) {
        if (
          ann.type === "url_citation" &&
          typeof ann.start_index === "number" &&
          typeof ann.end_index === "number" &&
          ann.url
        ) {
          annotations.push({
            start: ann.start_index,
            end: ann.end_index,
            url: ann.url,
          });
        }
      }
    }
  };

  if (Array.isArray(rawMessage?.output)) {
    for (const item of rawMessage.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        extractAnnotations(item.content);
      }
    }
  }

  if (annotations.length === 0) return textContent;
  annotations.sort((a, b) => b.start - a.start);

  let result = textContent;
  for (const ann of annotations) {
    const key = Object.entries(citationSources).find(
      ([, value]) => value.url === ann.url,
    )?.[0];
    if (!key || ann.start < 0 || ann.end > result.length) continue;
    const citedText = result.substring(ann.start, ann.end);
    result = `${result.substring(0, ann.start)}<cite index="${key}">${citedText}</cite>${result.substring(ann.end)}`;
  }

  return result;
}

export class OpenAIResponsesProvider implements AIProvider {
  readonly name = "openai";
  readonly kind = "openai.responses" as const;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  async chat(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    branchState?: import("@synapse/shared").EngineBranchState;
    tools?: ToolDefinition[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const resumeState =
      params.branchState?.engineKind === this.kind
        ? params.branchState
        : undefined;
    const resumedItems = Array.isArray(resumeState?.nativeState?.items)
      ? (resumeState.nativeState.items as unknown[])
      : null;
    const canResume =
      !!resumedItems &&
      resumeState?.metadata?.systemPrompt === params.system &&
      canResumeBranchFromWindow(params.contextWindow, resumeState);

    const sourceWindow = canResume
      ? buildBranchDeltaWindow(params.contextWindow, resumeState)
      : params.contextWindow;
    const preparedWindow = await this.compressContextWindow(sourceWindow);
    const conversationMessages =
      await this.compileContextWindow(preparedWindow);
    const deltaInput = await this.convertMessages(
      conversationMessages,
      params.multimodal,
    );
    const input = canResume ? [...resumedItems, ...deltaInput] : deltaInput;

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_output_tokens: this.config.maxTokens,
      instructions: params.system,
      input,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      body.tool_choice = "auto";
    }

    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OpenAI Responses API error (${response.status}): ${errorBody}`,
      );
    }

    const data = (await response.json()) as any;
    const output = Array.isArray(data.output) ? data.output : [];

    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];
    const serverToolCalls: AIResponse["serverToolCalls"] = [];

    for (const item of output) {
      if (item.type === "function_call" && item.name) {
        try {
          const inputObject =
            typeof item.arguments === "string"
              ? JSON.parse(item.arguments)
              : item.arguments || {};
          toolCalls.push({
            callId: randomUUID(),
            providerCallId: item.call_id || item.id,
            toolName: item.name,
            input: inputObject,
          });
        } catch {
          console.error(
            `Failed to parse Responses API tool call arguments for ${item.name}`,
          );
        }
        continue;
      }

      if (item.type === "web_search_call") {
        serverToolCalls?.push({
          type: "web_search",
          query: item.action?.query,
        });
        continue;
      }

      if (item.type === "message" && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === "output_text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
      }
    }

    const rawAssistantMessage = data;
    const citationSources = extractResponseCitationSources(rawAssistantMessage);
    const plainText = textParts.join("");
    const textContent = injectCitationMarkers(
      plainText,
      rawAssistantMessage,
      citationSources,
    );

    const contentBlocks: CanonicalContentBlock[] = [];
    if (textContent) contentBlocks.push(textBlock(textContent));

    const assistantMsg: ConversationMessage = {
      role: "assistant",
      content: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    const appliedKeys = [
      textContent
        ? buildAssistantMessageAppliedKey(
            params.branchState?.sessionId,
            textContent,
          )
        : undefined,
      buildToolCallBatchAppliedKey(toolCalls, textContent),
    ].filter((value): value is string => !!value);
    const branchState = params.branchState?.sessionId
      ? advanceEngineBranchState(
          params.branchState,
          params.contextWindow,
          {
            items: [...input, ...output],
          },
          {
            systemPrompt: params.system,
          },
          appliedKeys.length > 0 ? appliedKeys : undefined,
        )
      : undefined;

    return {
      context: [assistantMsg],
      tokensUsed: {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
      },
      stopReason:
        toolCalls.length > 0
          ? "tool_calls"
          : data.stop_reason || data.status || "completed",
      rawAssistantMessage,
      serverToolCalls:
        serverToolCalls && serverToolCalls.length > 0
          ? serverToolCalls
          : undefined,
      citationSources,
      branchState,
    };
  }

  async rebuildBranchState(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    branchState: import("@synapse/shared").EngineBranchState;
    tools?: ToolDefinition[];
    builtinTools?: import("@synapse/shared").AnthropicBuiltinTool[];
    multimodal?: MultimodalConfig;
  }) {
    const preparedWindow = await this.compressContextWindow(
      params.contextWindow,
    );
    const conversationMessages =
      await this.compileContextWindow(preparedWindow);
    const items = await this.convertMessages(
      conversationMessages,
      params.multimodal,
    );

    return advanceEngineBranchState(
      params.branchState,
      params.contextWindow,
      { items },
      { systemPrompt: params.system },
    );
  }

  protected async compressContextWindow(window: ProviderContextWindow) {
    return compressContextWindow(window);
  }

  protected async compileContextWindow(window: ProviderContextWindow) {
    return compileContextWindowToConversationMessages(window);
  }

  parseFileRefs(text: string): FileRefSegment[] {
    return parseFileRefSegments(text);
  }

  private async convertMessages(
    messages: ConversationMessage[],
    multimodal?: MultimodalConfig,
  ): Promise<unknown[]> {
    const result: unknown[] = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const resolved = await this.resolveBlocks(msg.content, multimodal);
          result.push({
            role: "user",
            content: resolved.nativeBlocks,
          });
          break;
        }

        case "assistant": {
          const text = extractText(msg.content);
          if (text) {
            result.push({
              role: "assistant",
              content: [{ type: "input_text", text }],
            });
          }
          if (msg.toolCalls) {
            for (const toolCall of msg.toolCalls) {
              result.push({
                type: "function_call",
                call_id: toolCall.providerCallId || toolCall.callId,
                name: toolCall.toolName,
                arguments: JSON.stringify(toolCall.input),
              });
            }
          }
          break;
        }

        case "tool_result": {
          for (const resultItem of msg.results) {
            const { textFallback } = await this.resolveBlocks(
              resultItem.content,
              multimodal,
            );
            result.push({
              type: "function_call_output",
              call_id: resultItem.providerCallId || resultItem.toolCallId,
              output: textFallback,
            });
          }
          break;
        }
      }
    }

    return result;
  }

  private async resolveBlocks(
    blocks: CanonicalContentBlock[],
    multimodal?: MultimodalConfig,
  ): Promise<{ nativeBlocks: unknown[]; textFallback: string }> {
    const supportedTypes = multimodal?.supported
      ? new Set(multimodal.types)
      : new Set<string>();
    const nativeBlocks: unknown[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (block.type === "text") {
        nativeBlocks.push({ type: "input_text", text: block.text });
        textParts.push(block.text);
        continue;
      }

      if (block.type === "mention") {
        const text = formatMentionText(block);
        nativeBlocks.push({ type: "input_text", text });
        textParts.push(text);
        continue;
      }

      if (!supportedTypes.has(block.category)) {
        const desc =
          block.category === "audio"
            ? await buildAudioFallbackContext(
                { ...block, category: "audio" },
                "Audio input is not enabled for this model configuration.",
              )
            : block.category === "image"
              ? await buildImageFallbackContext(
                  { ...block, category: "image" },
                  "Image input is not enabled for this model configuration.",
                )
              : `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`;
        nativeBlocks.push({ type: "input_text", text: desc });
        textParts.push(desc);
        const hint = this.buildFileRefHint(
          block.fileId,
          block.originalName,
          block.category,
        );
        nativeBlocks.push({ type: "input_text", text: hint });
        textParts.push(hint);
        continue;
      }

      try {
        let buffer = await readAsBuffer(block.storedName);
        let mimeType = block.mimeType;

        if (block.category === "image") {
          const converted = await ensureSupportedFormat(buffer, mimeType);
          buffer = converted.buffer;
          mimeType = converted.mimeType;
        }

        let nativeBlock: unknown | null = null;
        switch (block.category) {
          case "image": {
            nativeBlock =
              buffer.length <= BASE64_THRESHOLD
                ? {
                    type: "input_image",
                    image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
                  }
                : {
                    type: "input_image",
                    image_url: getFullUrl(block.storedName),
                  };
            break;
          }
          case "audio": {
            const format = mimeType.includes("wav")
              ? "wav"
              : mimeType.includes("mp3") || mimeType.includes("mpeg")
                ? "mp3"
                : "wav";
            nativeBlock = {
              type: "input_audio",
              input_audio: { data: buffer.toString("base64"), format },
            };
            break;
          }
          case "document":
          case "video":
            nativeBlock = null;
            break;
        }

        if (nativeBlock) {
          nativeBlocks.push(nativeBlock);
          textParts.push(`[${block.category}: ${block.originalName}]`);
        } else {
          const desc = `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`;
          nativeBlocks.push({ type: "input_text", text: desc });
          textParts.push(desc);
        }
      } catch (err: any) {
        console.error(
          `[openai.responses] Failed to resolve file_ref ${block.storedName}:`,
          err.message,
        );
        const desc = `[${block.category}: ${block.originalName} (read failed)]`;
        nativeBlocks.push({ type: "input_text", text: desc });
        textParts.push(desc);
      }

      const hint = this.buildFileRefHint(
        block.fileId,
        block.originalName,
        block.category,
      );
      nativeBlocks.push({ type: "input_text", text: hint });
      textParts.push(hint);
    }

    return { nativeBlocks, textFallback: textParts.join("\n") };
  }

  private buildFileRefHint(
    fileId: string,
    originalName: string,
    category: string,
  ): string {
    return [
      `This ${category} "${originalName}" is available as <FileRef id="${fileId}"/>.`,
      `To display it in your response, use exactly: <FileRef id="${fileId}"/>.`,
      `If a tool parameter expects a fileRef, pass the same exact string <FileRef id="${fileId}"/> instead of inventing a URL or data URI.`,
    ].join(" ");
  }
}
