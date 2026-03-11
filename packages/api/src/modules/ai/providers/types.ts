import type { AIResponse, ToolDefinition, AnthropicBuiltinTool, MultimodalConfig, ProviderContextWindow } from '@synapse/shared';

export interface AIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

export type FileRefSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; fileId: string };

export interface AIProvider {
  readonly name: string;
  chat(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse>;

  /** Parse FileRef references from model output text */
  parseFileRefs(text: string): FileRefSegment[];
}
