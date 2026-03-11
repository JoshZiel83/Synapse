import type { ToolDefinition } from '@synapse/shared';

/**
 * Serialize a platform-canonical ToolDefinition for a specific provider's API format.
 */
export function serializeToolForProvider(
  tool: ToolDefinition,
  providerType: 'anthropic' | 'openai'
): Record<string, unknown> {
  switch (providerType) {
    case 'anthropic':
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      };
    case 'openai':
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      };
    default:
      throw new Error(`Unknown provider type: ${providerType}`);
  }
}
