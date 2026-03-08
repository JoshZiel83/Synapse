import type { BuiltinOrgSeed } from './types.js';

const zhipuApiKeyConfig = {
  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', sensitive: true, description: 'ZhipuAI API key' },
    },
    required: ['apiKey'],
  },
  validationRules: [
    { field: 'apiKey', rule: 'required' as const, message: 'API key is required' },
    { field: 'apiKey', rule: 'min_length' as const, value: 10, message: 'API key seems too short' },
  ],
  setupSteps: [{
    id: 'api_key',
    title: 'Configure API Key',
    description: 'Enter your ZhipuAI API key. You can obtain one from the ZhipuAI developer platform.',
    scope: 'plugin' as const,
    fields: ['apiKey'],
    helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    helpText: 'Navigate to your ZhipuAI dashboard to create an API key.',
  }],
};

export const zAiSeed: BuiltinOrgSeed = {
  slug: 'z_ai',
  displayName: 'ZhipuAI',
  description: 'ZhipuAI official MCP plugins providing web search, reading, document analysis, and vision capabilities.',
  plugins: [
    {
      slug: 'search',
      displayName: 'Web Search',
      description: 'Search the web using ZhipuAI web search service.',
      longDescription: 'Provides real-time web search capabilities powered by ZhipuAI. Returns relevant search results with titles, snippets, and URLs.',
      transport: 'http',
      entryPoint: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
      lifecycleScope: 'workspace',
      tags: ['search', 'web', 'builtin'],
      toolsManifest: [{ name: 'webSearchPrime', description: 'Search the web for information', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      ...zhipuApiKeyConfig,
    },
    {
      slug: 'reader',
      displayName: 'Web Reader',
      description: 'Read and extract content from web pages using ZhipuAI.',
      longDescription: 'Fetches web pages and extracts clean, readable content. Useful for reading articles, documentation, and other web content.',
      transport: 'http',
      entryPoint: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp',
      lifecycleScope: 'workspace',
      tags: ['reader', 'web', 'builtin'],
      toolsManifest: [{ name: 'webReader', description: 'Read and extract content from a web page URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }],
      ...zhipuApiKeyConfig,
    },
    {
      slug: 'zread',
      displayName: 'ZRead Document Analysis',
      description: 'Analyze documents, code repos, and files using ZhipuAI ZRead service.',
      longDescription: 'Advanced document analysis including code repository exploration, file reading, and document search capabilities.',
      transport: 'http',
      entryPoint: 'https://open.bigmodel.cn/api/mcp/zread/mcp',
      lifecycleScope: 'workspace',
      tags: ['documents', 'code', 'analysis', 'builtin'],
      toolsManifest: [
        { name: 'search_doc', description: 'Search within documents', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'get_repo_structure', description: 'Get repository file structure', inputSchema: { type: 'object', properties: { repo_url: { type: 'string' } }, required: ['repo_url'] } },
        { name: 'read_file', description: 'Read file content from a repository', inputSchema: { type: 'object', properties: { repo_url: { type: 'string' }, file_path: { type: 'string' } }, required: ['repo_url', 'file_path'] } },
      ],
      ...zhipuApiKeyConfig,
    },
    {
      slug: 'vision',
      displayName: 'Vision Analysis',
      description: 'Analyze images, screenshots, diagrams, and videos using ZhipuAI GLM-4V.',
      longDescription: 'Powerful vision capabilities including image analysis, OCR, error diagnosis, diagram understanding, data visualization analysis, UI comparison, and video analysis.',
      transport: 'builtin',
      entryPoint: 'vision',
      lifecycleScope: 'session',
      tags: ['vision', 'image', 'ocr', 'builtin'],
      toolsManifest: [
        { name: 'image_analysis', description: 'Analyze an image and describe its content', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, focus: { type: 'string' } }, required: ['image_url'] } },
        { name: 'extract_text_from_screenshot', description: 'Extract text from a screenshot (OCR)', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, language: { type: 'string' } }, required: ['image_url'] } },
        { name: 'diagnose_error_screenshot', description: 'Diagnose an error from a screenshot', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, context: { type: 'string' } }, required: ['image_url'] } },
        { name: 'understand_technical_diagram', description: 'Understand a technical diagram', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, diagram_type: { type: 'string' } }, required: ['image_url'] } },
        { name: 'analyze_data_visualization', description: 'Analyze a chart or data visualization', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, questions: { type: 'string' } }, required: ['image_url'] } },
        { name: 'ui_diff_check', description: 'Compare two UI screenshots', inputSchema: { type: 'object', properties: { image_url_before: { type: 'string' }, image_url_after: { type: 'string' }, focus_areas: { type: 'string' } }, required: ['image_url_before', 'image_url_after'] } },
        { name: 'image_qa', description: 'Answer questions about an image', inputSchema: { type: 'object', properties: { image_url: { type: 'string' }, question: { type: 'string' } }, required: ['image_url', 'question'] } },
        { name: 'video_analysis', description: 'Analyze video content', inputSchema: { type: 'object', properties: { video_url: { type: 'string' }, question: { type: 'string' } }, required: ['video_url'] } },
      ],
      ...zhipuApiKeyConfig,
    },
  ],
};
