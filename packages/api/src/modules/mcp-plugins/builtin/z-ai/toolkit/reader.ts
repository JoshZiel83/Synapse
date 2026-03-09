import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { callMcpTool } from './mcp-pool.js';

const MCP_ENDPOINT = 'https://open.bigmodel.cn/api/mcp/web_reader/mcp';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'webReader',
    description: 'Read and extract clean, readable content from a web page URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL of the web page to read' },
      },
      required: ['url'],
    },
  },
];

export const readerFeature: SubFeature = {
  featureKey: 'feature_reader',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    return callMcpTool(MCP_ENDPOINT, apiKey, toolName, input);
  },
};
