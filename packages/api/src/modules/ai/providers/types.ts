import type { AIMessage, AIResponse, ToolDefinition, AnthropicBuiltinTool, ContinuationEntry } from '@synapse/shared';

export interface AIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

export interface AIProvider {
  readonly name: string;
  chat(params: {
    system: string;
    messages: AIMessage[];
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    continuationHistory?: ContinuationEntry[];
  }): Promise<AIResponse>;
}
