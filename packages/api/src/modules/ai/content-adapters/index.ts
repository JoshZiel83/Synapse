/**
 * Content adapter registry — maps ProviderType to its ContentAdapterStrategy.
 *
 * To add a new provider: create a new strategy file and register it in the
 * `adapters` map below.
 */
import type { ProviderType } from '@synapse/shared';
import type { ContentAdapterStrategy } from './types.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';

const adapters: Record<string, ContentAdapterStrategy> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
};

export function getContentAdapter(providerType?: ProviderType): ContentAdapterStrategy {
  return adapters[providerType || 'anthropic'] || anthropicAdapter;
}

export type { ContentAdapterStrategy, PreparedMedia } from './types.js';
