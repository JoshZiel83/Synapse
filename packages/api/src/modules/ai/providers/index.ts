import type { AIProvider, AIProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export type { AIProvider, AIProviderConfig };

export function createAIProvider(
  providerName: string,
  providerConfig: AIProviderConfig
): AIProvider {
  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider(providerConfig);
    case 'openai':
      return new OpenAIProvider(providerConfig);
    default:
      throw new Error(`Unknown AI provider: ${providerName}. Supported: anthropic, openai`);
  }
}
