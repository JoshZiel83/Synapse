import type { AIResponse, ToolDefinition, ToolCall, ContinuationEntry, ToolRound, ConversationMessage, MultimodalConfig } from '@synapse/shared';
import type { AIProvider, AIProviderConfig } from './types.js';
import { convertToOpenAIMessages } from '../message-converter.js';
import { resolveContentBlocks } from '../content-resolve.js';
import { serializeToolForProvider } from './tool-serializer.js';

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  async chat(params: {
    system: string;
    messages: ConversationMessage[];
    tools?: ToolDefinition[];
    continuationHistory?: ContinuationEntry[];
    canonicalRounds?: ToolRound[];
    multimodalContent?: unknown[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, '');

    // Convert ConversationMessage[] to OpenAI format (includes system message)
    const openaiMessages = await convertToOpenAIMessages(params.messages, params.system, params.multimodal);

    // If multimodal content is provided, replace last user message content
    if (params.multimodalContent && openaiMessages.length > 0) {
      // Find the last user message
      for (let i = openaiMessages.length - 1; i >= 0; i--) {
        if ((openaiMessages[i] as any).role === 'user') {
          openaiMessages[i] = { role: 'user', content: params.multimodalContent };
          break;
        }
      }
    }

    // Append canonical rounds (preferred path — platform-canonical ToolRound[])
    if (params.canonicalRounds && params.canonicalRounds.length > 0) {
      for (const round of params.canonicalRounds) {
        openaiMessages.push({
          role: 'assistant',
          content: round.textContent || null,
          tool_calls: round.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
        for (const tr of round.toolResults) {
          let content: string;
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            const hasFileRef = tr.content.some((b: any) => b?.type === 'file_ref');
            if (hasFileRef) {
              const { textFallback } = await resolveContentBlocks(
                tr.content as any,
                'openai',
                params.multimodal,
              );
              content = textFallback;
            } else {
              content = JSON.stringify(tr.content);
            }
          } else {
            content = JSON.stringify(tr.content);
          }
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content,
          });
        }
      }
    }
    // Legacy path: ContinuationEntry[] (backward compat — will be removed)
    else if (params.continuationHistory && params.continuationHistory.length > 0) {
      for (const entry of params.continuationHistory) {
        openaiMessages.push(entry.rawAssistantMessage as Record<string, unknown>);
        for (const tr of entry.toolResults) {
          let content: string;
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            const hasFileRef = tr.content.some((b: any) => b?.type === 'file_ref');
            if (hasFileRef) {
              const { textFallback } = await resolveContentBlocks(
                tr.content as any,
                'openai',
                params.multimodal,
              );
              content = textFallback;
            } else {
              content = JSON.stringify(tr.content);
            }
          } else {
            content = JSON.stringify(tr.content);
          }
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content,
          });
        }
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      messages: openaiMessages,
    };

    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools.map((t) => serializeToolForProvider(t, 'openai'));
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
          toolCalls.push({ id: tc.id, name: tc.function.name, input });
        } catch {
          console.error(`Failed to parse tool call arguments for ${tc.function.name}`);
        }
      }
    }

    return {
      toolCalls,
      textContent,
      tokensUsed: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
      },
      stopReason: choice?.finish_reason || 'stop',
      rawAssistantMessage: message,
    };
  }
}
