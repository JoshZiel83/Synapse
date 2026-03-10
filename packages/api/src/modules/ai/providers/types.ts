import type { AIResponse, ToolDefinition, AnthropicBuiltinTool, ContinuationEntry, ConversationMessage, MultimodalConfig } from '@synapse/shared';

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
    messages: ConversationMessage[];
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    continuationHistory?: ContinuationEntry[];
    multimodalContent?: unknown[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse>;
}
