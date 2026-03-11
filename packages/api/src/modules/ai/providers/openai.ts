import type { AIResponse, ToolDefinition, ToolCall, ConversationMessage, MultimodalConfig, CanonicalContentBlock, ProviderContextWindow } from '@synapse/shared';
import { extractText } from '@synapse/shared';
import { randomUUID } from 'crypto';
import type { AIProvider, AIProviderConfig, FileRefSegment } from './types.js';
import { readAsBuffer, getFullUrl } from '../../../infrastructure/storage/index.js';
import { compileContextWindowToConversationMessages, compressContextWindow } from '../context-compiler.js';
import { parseFileRefSegments } from '../fileref-resolver.js';
import { buildAudioFallbackContext } from '../audio-fallback.js';

const SUPPORTED_IMAGE_FORMATS = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

// OpenAI enforces 20 MB per image
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
    const sharp = (await import('sharp')).default;
    const converted = await sharp(buffer).png().toBuffer();
    return { buffer: converted, mimeType: 'image/png' };
  } catch (err) {
    console.error(`[openai] Failed to convert ${mimeType} to PNG:`, err);
    return { buffer, mimeType };
  }
}

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  async chat(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    tools?: ToolDefinition[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, '');

    const preparedWindow = await this.compressContextWindow(params.contextWindow);
    const conversationMessages = await this.compileContextWindow(preparedWindow);
    const openaiMessages = await this.convertMessages(conversationMessages, params.system, params.multimodal);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: openaiMessages,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          role: string;
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const message = choice?.message;
    const toolCalls: ToolCall[] = [];
    const textContent = message?.content || '';

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        try {
          const input = JSON.parse(tc.function.arguments);
          toolCalls.push({
            callId: randomUUID(),
            providerCallId: tc.id,
            toolName: tc.function.name,
            input,
          });
        } catch {
          console.error(`Failed to parse tool call arguments for ${tc.function.name}`);
        }
      }
    }

    // Build canonical context
    const contentBlocks: CanonicalContentBlock[] = [];
    if (textContent) contentBlocks.push({ type: 'text', text: textContent });

    const assistantMsg: ConversationMessage = {
      role: 'assistant' as const,
      content: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    return {
      context: [assistantMsg],
      tokensUsed: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
      stopReason: choice?.finish_reason || 'stop',
      rawAssistantMessage: message,
    };
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

  // ─── Internal: message conversion ───

  private async convertMessages(
    messages: ConversationMessage[],
    systemPrompt: string,
    multimodal?: MultimodalConfig,
  ): Promise<Record<string, unknown>[]> {
    const result: Record<string, unknown>[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      switch (msg.role) {
        case 'user': {
          const resolved = await this.resolveBlocks(msg.content, multimodal);
          // If we have mixed content (images etc), use content array; otherwise plain string
          const hasNonText = resolved.nativeBlocks.some((b: any) => b.type !== 'text');
          result.push({
            role: 'user',
            content: hasNonText ? resolved.nativeBlocks : resolved.textFallback,
          });
          break;
        }

        case 'assistant': {
          const text = extractText(msg.content);
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            result.push({
              role: 'assistant',
              content: text || null,
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.providerCallId || tc.callId,
                type: 'function',
                function: {
                  name: tc.toolName,
                  arguments: JSON.stringify(tc.input),
                },
              })),
            });
          } else {
            result.push({ role: 'assistant', content: text });
          }
          break;
        }

        case 'tool_result': {
          for (const tr of msg.results) {
            const { textFallback } = await this.resolveBlocks(tr.content, multimodal);
            result.push({
              role: 'tool',
              tool_call_id: tr.providerCallId || tr.toolCallId,
              content: textFallback,
            });
          }
          break;
        }
      }
    }

    return result;
  }

  // ─── Internal: resolve CanonicalContentBlock[] → OpenAI native blocks ───

  private async resolveBlocks(
    blocks: CanonicalContentBlock[],
    multimodal?: MultimodalConfig,
  ): Promise<{ nativeBlocks: unknown[]; textFallback: string }> {
    const supportedTypes = multimodal?.supported ? new Set(multimodal.types) : new Set<string>();
    const nativeBlocks: unknown[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        nativeBlocks.push({ type: 'text', text: block.text });
        textParts.push(block.text);
        continue;
      }

      // file_ref block — check multimodal capability
      if (!supportedTypes.has(block.category)) {
        const desc = block.category === 'audio'
          ? await buildAudioFallbackContext(
              { ...block, category: 'audio' },
              'Audio input is not enabled for this model configuration.',
            )
          : `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)})]`;
        nativeBlocks.push({ type: 'text', text: desc });
        textParts.push(desc);
        // Always inject FileRef hint even for unsupported types
        const hint = this.buildFileRefHint(block.fileId, block.originalName, block.category);
        nativeBlocks.push({ type: 'text', text: hint });
        textParts.push(hint);
        continue;
      }

      // Supported — read from disk and build OpenAI native block
      try {
        let buffer = await readAsBuffer(block.storedName);
        let mimeType = block.mimeType;

        if (block.category === 'image') {
          const converted = await ensureSupportedFormat(buffer, mimeType);
          buffer = converted.buffer;
          mimeType = converted.mimeType;
        }

        let nativeBlock: unknown | null = null;
        switch (block.category) {
          case 'image': {
            if (buffer.length <= BASE64_THRESHOLD) {
              nativeBlock = { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } };
            } else {
              nativeBlock = { type: 'image_url', image_url: { url: getFullUrl(block.storedName) } };
            }
            break;
          }
          case 'audio': {
            const format = mimeType.includes('wav') ? 'wav'
              : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
              : 'wav';
            nativeBlock = { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } };
            break;
          }
          case 'document':
            // OpenAI Chat Completions API does not support document/PDF blocks
            nativeBlock = null;
            break;
          case 'video':
            nativeBlock = null;
            break;
        }

        if (nativeBlock) {
          nativeBlocks.push(nativeBlock);
          textParts.push(`[${block.category}: ${block.originalName}]`);
        } else {
          const desc = `[${block.category}: ${block.originalName} (${block.mimeType}, ${formatBytes(block.sizeBytes)}) - provider does not support this type]`;
          nativeBlocks.push({ type: 'text', text: desc });
          textParts.push(desc);
        }
      } catch (err: any) {
        console.error(`[openai] Failed to resolve file_ref ${block.storedName}:`, err.message);
        const desc = `[${block.category}: ${block.originalName} (read failed)]`;
        nativeBlocks.push({ type: 'text', text: desc });
        textParts.push(desc);
      }

      // Inject FileRef hint after every file_ref block
      const hint = this.buildFileRefHint(block.fileId, block.originalName, block.category);
      nativeBlocks.push({ type: 'text', text: hint });
      textParts.push(hint);
    }

    return { nativeBlocks, textFallback: textParts.join('\n') };
  }

  private buildFileRefHint(fileId: string, originalName: string, category: string): string {
    return [
      `This ${category} "${originalName}" is available as <FileRef id="${fileId}"/>.`,
      `To display it in your response, use exactly: <FileRef id="${fileId}"/>.`,
      `If a tool parameter expects a fileRef, pass the same exact string <FileRef id="${fileId}"/> instead of inventing a URL or data URI.`,
    ].join(' ');
  }
}
