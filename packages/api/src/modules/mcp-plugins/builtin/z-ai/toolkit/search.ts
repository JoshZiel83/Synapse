import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { callMcpTool, extractMcpTextResult } from './mcp-pool.js';

const MCP_ENDPOINT = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'webSearchPrime',
    description: 'Search the web for real-time information using ZhipuAI Web Search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
];

export const searchFeature: SubFeature = {
  featureKey: 'feature_search',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    return extractMcpTextResult(await callMcpTool(MCP_ENDPOINT, apiKey, toolName, input));
  },
};
