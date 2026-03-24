import type {
  AIResponse,
  EngineBranchState,
  ToolDefinition,
  AnthropicBuiltinTool,
  ModelEngineKind,
  MultimodalConfig,
  ProviderContextWindow,
} from '@synapse/shared';

export interface AIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  engineKind: ModelEngineKind;
}

export type FileRefSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; fileId: string };

export interface AIProvider {
  readonly name: string;
  readonly kind: ModelEngineKind;
  chat(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    branchState?: EngineBranchState;
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    multimodal?: MultimodalConfig;
  }): Promise<AIResponse>;
  rebuildBranchState(params: {
    system: string;
    contextWindow: ProviderContextWindow;
    branchState: EngineBranchState;
    tools?: ToolDefinition[];
    builtinTools?: AnthropicBuiltinTool[];
    multimodal?: MultimodalConfig;
  }): Promise<EngineBranchState>;

  /** Parse FileRef references from model output text */
  parseFileRefs(text: string): FileRefSegment[];
}
