import type { AIMessage, AIResponse, ToolDefinition, ToolCall, ContinuationEntry } from '@synapse/shared';
import type { AIProvider, AIProviderConfig } from './types.js';

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  async chat(params: {
    system: string;
    messages: AIMessage[];
    tools?: ToolDefinition[];
    continuationHistory?: ContinuationEntry[];
  }): Promise<AIResponse> {
    const base = this.config.baseUrl.replace(/\/+$/, '');

    const openaiMessages: Record<string, unknown>[] = [
      { role: 'system', content: params.system },
      ...params.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Append continuation history (multi-turn tool use)
    if (params.continuationHistory && params.continuationHistory.length > 0) {
      for (const entry of params.continuationHistory) {
        // Raw assistant message (contains tool_calls array) — pass back as-is
        openaiMessages.push(entry.rawAssistantMessage as Record<string, unknown>);
        // Each tool result as a separate role:"tool" message
        for (const tr of entry.toolResults) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content,
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
