import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { callMcpTool } from './mcp-pool.js';

const MCP_ENDPOINT = 'https://open.bigmodel.cn/api/mcp/zread/mcp';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_doc',
    description: 'Search within documents for relevant content.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_repo_structure',
    description: 'Get the file structure of a code repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'URL of the repository' },
      },
      required: ['repo_url'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file content from a code repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'URL of the repository' },
        file_path: { type: 'string', description: 'Path to the file within the repository' },
      },
      required: ['repo_url', 'file_path'],
    },
  },
];

export const zreadFeature: SubFeature = {
  featureKey: 'feature_zread',

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  },

  async execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string> {
    const apiKey = config.apiKey as string;
    return callMcpTool(MCP_ENDPOINT, apiKey, toolName, input);
  },
};
