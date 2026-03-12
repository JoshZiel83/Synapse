import { ToolDefinition } from '@synapse/shared';
import type { SubFeature } from './types.js';
import { callMcpTool, extractMcpTextResult } from './mcp-pool.js';

const MCP_ENDPOINT = 'https://open.bigmodel.cn/api/mcp/zread/mcp';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_doc',
    description: 'Search a supported open-source GitHub repository for documentation, knowledge, recent issues, pull requests, and related project context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for repository docs, issues, PRs, release notes, or other indexed project knowledge.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_repo_structure',
    description: 'Get the directory structure and file tree of a supported open-source GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'Public GitHub repository URL in the form https://github.com/owner/repo' },
      },
      required: ['repo_url'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a specific file from a supported open-source GitHub repository.',
    parameters: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'Public GitHub repository URL in the form https://github.com/owner/repo' },
        file_path: { type: 'string', description: 'Path to the target file inside the repository, for example src/index.ts' },
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
    return extractMcpTextResult(await callMcpTool(MCP_ENDPOINT, apiKey, toolName, input));
  },
};
