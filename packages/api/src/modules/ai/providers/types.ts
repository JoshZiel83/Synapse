import type { AIResponse, ToolDefinition, AnthropicBuiltinTool, ContinuationEntry, ToolRound, ConversationMessage, MultimodalConfig } from '@synapse/shared';

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
    canonicalRounds?: ToolRound[];
    multimodalContent?: unknown[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse>;
}
