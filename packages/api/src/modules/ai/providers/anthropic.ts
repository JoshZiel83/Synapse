import type { AIMessage, AIResponse, ToolDefinition, ToolCall, AnthropicBuiltinTool, ContinuationEntry } from '@synapse/shared';
import type { AIProvider, AIProviderConfig } from './types.js';

// Map tool names to their latest versioned type identifiers
const BUILTIN_TOOL_TYPES: Record<string, string> = {
  web_search: 'web_search_20250305',
  web_fetch: 'web_fetch_20250910',
};

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  async chat(params: {
    system: string;
    messages: AIMessage[];
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    continuationHistory?: ContinuationEntry[];
    multimodalContent?: unknown[];
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, '');

    // Build messages: initial messages + continuation history
    const allMessages: Record<string, unknown>[] = params.messages.map((m, i) => {
      // If multimodal content is provided, use it for the last user message
      if (params.multimodalContent && i === params.messages.length - 1 && m.role === 'user') {
        return { role: m.role, content: params.multimodalContent };
      }
      return { role: m.role, content: m.content };
    });

    // Append continuation history (multi-turn tool use)
    if (params.continuationHistory && params.continuationHistory.length > 0) {
      for (const entry of params.continuationHistory) {
        // Raw assistant message (contains tool_use blocks) — pass back as-is
        allMessages.push({
          role: 'assistant',
          content: entry.rawAssistantMessage,
        });
        // Tool results as a user message with tool_result content blocks
        const toolResultBlocks = entry.toolResults.map((tr) => {
          if (typeof tr.content !== 'string') {
            const blocks = tr.content as any[];
            for (const b of blocks) {
              console.log(`[anthropic] tool_result block for ${tr.toolName}: keys=${Object.keys(b).join(',')}, type=${b.type}, mimeType=${b.mimeType}, hasData=${!!b.data}, dataLen=${typeof b.data === 'string' ? b.data.length : 'N/A'}`);
            }
          }
          return {
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            content: typeof tr.content === 'string'
              ? tr.content
              : convertMcpContentToAnthropic(tr.content),
            is_error: tr.isError || false,
          };
        });
        allMessages.push({
          role: 'user',
          content: toolResultBlocks,
        });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: params.system,
      messages: allMessages,
    };

    // Build tools array: custom tools + built-in server tools
    const allTools: Record<string, unknown>[] = [];

    if (params.tools && params.tools.length > 0) {
      for (const t of params.tools) {
        allTools.push({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        });
      }
    }

    if (params.builtinTools && params.builtinTools.length > 0) {
      for (const toolName of params.builtinTools) {
        const toolType = BUILTIN_TOOL_TYPES[toolName];
        if (toolType) {
          allTools.push({
            type: toolType,
            name: toolName,
          });
        }
      }
    }

    if (allTools.length > 0) {
      body.tools = allTools;
      body.tool_choice = { type: 'auto' };
    }

    // Increase timeout when server tools are enabled (they can take a long time)
    const hasServerTools = params.builtinTools && params.builtinTools.length > 0;
    const timeoutMs = hasServerTools ? 300_000 : 120_000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; id?: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason?: string;
    };

    const toolCalls: ToolCall[] = [];
    let textContent = '';

    // Debug: log content block types for diagnosing server tool behavior
    const blockTypes = data.content.map((b) => b.type);
    if (blockTypes.some((t) => t !== 'text' && t !== 'tool_use')) {
      console.log(`[anthropic] non-standard blocks: ${JSON.stringify(blockTypes)} stop_reason=${data.stop_reason}`);
    }

    for (const block of data.content) {
      if (block.type === 'tool_use' && block.name && block.input) {
        toolCalls.push({ id: block.id || '', name: block.name, input: block.input });
      } else if (block.type === 'text' && block.text) {
        textContent += block.text;
      }
      // Skip server_tool_use, web_search_tool_result, web_fetch_tool_result
      // These are intermediate blocks handled by Anthropic's server
    }

    return {
      toolCalls,
      textContent,
      tokensUsed: {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
      },
      stopReason: data.stop_reason || 'end_turn',
      rawAssistantMessage: data.content,
    };
  }
}

/**
 * Convert MCP content blocks to Anthropic tool_result content format.
 *
 * MCP spec (2025-06-18) content types:
 *   TextContent:  { type: "text", text: "..." }
 *   ImageContent: { type: "image", data: "<base64>", mimeType: "image/png" }
 *   AudioContent: { type: "audio", data: "<base64>", mimeType: "audio/wav" }
 *   EmbeddedResource: { type: "resource", resource: { uri, mimeType, text|blob } }
 *
 * Some MCP servers (e.g. CUA) may return blocks already in Anthropic format:
 *   { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 *
 * Anthropic tool_result content blocks:
 *   TextBlockParam:  { type: "text", text: "..." }
 *   ImageBlockParam: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 */
function convertMcpContentToAnthropic(blocks: unknown[]): unknown[] {
  return blocks.map((block: any) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text || '' };
      case 'image': {
        // Case 1: Already in Anthropic format { source: { type, media_type, data } }
        if (block.source?.data) {
          return {
            type: 'image',
            source: {
              type: block.source.type || 'base64',
              media_type: block.source.media_type || 'image/png',
              data: block.source.data,
            },
          };
        }
        // Case 2: MCP standard format { data, mimeType }
        const mimeType = block.mimeType || block.mime_type || 'image/png';
        if (!block.data) {
          return { type: 'text', text: `[Image: missing data, keys=${Object.keys(block).join(',')}]` };
        }
        return {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: block.data },
        };
      }
      case 'resource':
        if (block.resource?.text) {
          return { type: 'text', text: block.resource.text };
        }
        if (block.resource?.blob && block.resource?.mimeType?.startsWith('image/')) {
          return {
            type: 'image',
            source: { type: 'base64', media_type: block.resource.mimeType, data: block.resource.blob },
          };
        }
        return { type: 'text', text: JSON.stringify(block) };
      default:
        // Pass through blocks that are already in Anthropic format (e.g. image with source)
        if (block.source?.data && block.source?.media_type) {
          return block;
        }
        return { type: 'text', text: JSON.stringify(block) };
    }
  });
}
