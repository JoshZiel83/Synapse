import type { BuiltinOrgSeed } from '../types.js';

const zhipuConfig = {
  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', sensitive: true, description: 'ZhipuAI API key' },
      feature_search: { type: 'boolean', description: 'Enable Web Search' },
      feature_reader: { type: 'boolean', description: 'Enable Web Reader' },
      feature_zread: { type: 'boolean', description: 'Enable ZRead Document Analysis' },
      feature_vision: { type: 'boolean', description: 'Enable Vision Analysis' },
      feature_stt: { type: 'boolean', description: 'Enable Speech-to-Text' },
      feature_image_gen: { type: 'boolean', description: 'Enable Image Generation' },
      feature_tts: { type: 'boolean', description: 'Enable Text-to-Speech' },
    },
    required: ['apiKey'],
  },
  defaultConfig: {
    feature_search: true,
    feature_reader: true,
    feature_zread: true,
    feature_vision: true,
    feature_stt: true,
    feature_image_gen: true,
    feature_tts: true,
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
  description: 'ZhipuAI official toolkit providing web search, reading, document analysis, vision, speech-to-text, image generation, and text-to-speech capabilities.',
  plugins: [
    {
      slug: 'toolkit',
      displayName: 'ZhipuAI Toolkit',
      description: 'Unified ZhipuAI toolkit with web search, reading, document analysis, vision, STT, image generation, and TTS.',
      longDescription: 'A comprehensive AI toolkit powered by ZhipuAI. Includes web search (WebSearchPrime), web page reading, document/code analysis (ZRead), image/video analysis (GLM-4V), speech-to-text (GLM-ASR), image generation (CogView), and text-to-speech (GLM-TTS). Enable or disable individual features via configuration toggles.',
      transport: 'builtin',
      entryPoint: 'z_ai/toolkit',
      lifecycleScope: 'workspace',
      tags: ['search', 'web', 'reader', 'documents', 'code', 'vision', 'image', 'ocr', 'stt', 'tts', 'image-gen', 'builtin'],
      toolsManifest: [
        // Search
        { name: 'webSearchPrime', description: 'Search the web for information', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        // Reader
        { name: 'webReader', description: 'Read and extract content from a web page URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
        // ZRead
        { name: 'search_doc', description: 'Search within documents', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'get_repo_structure', description: 'Get repository file structure', inputSchema: { type: 'object', properties: { repo_url: { type: 'string' } }, required: ['repo_url'] } },
        { name: 'read_file', description: 'Read file content from a repository', inputSchema: { type: 'object', properties: { repo_url: { type: 'string' }, file_path: { type: 'string' } }, required: ['repo_url', 'file_path'] } },
        // Vision
        { name: 'image_analysis', description: 'Analyze an image and describe its content', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, focus: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'extract_text_from_screenshot', description: 'Extract text from a screenshot (OCR)', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, language: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'diagnose_error_screenshot', description: 'Diagnose an error from a screenshot', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, context: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'understand_technical_diagram', description: 'Understand a technical diagram', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, diagram_type: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'analyze_data_visualization', description: 'Analyze a chart or data visualization', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, questions: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'ui_diff_check', description: 'Compare two UI screenshots', inputSchema: { type: 'object', properties: { beforeFileRef: { type: 'string' }, afterFileRef: { type: 'string' }, focus_areas: { type: 'string' } }, required: ['beforeFileRef', 'afterFileRef'] } },
        { name: 'image_qa', description: 'Answer questions about an image', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, question: { type: 'string' } }, required: ['fileRef', 'question'] } },
        { name: 'video_analysis', description: 'Analyze video content', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, question: { type: 'string' } }, required: ['fileRef'] } },
        // STT
        { name: 'audio_transcription', description: 'Transcribe audio to text', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' } }, required: ['fileRef'] } },
        // Image Generation
        { name: 'generate_image', description: 'Generate an image from a text prompt', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string' }, model: { type: 'string' }, quality: { type: 'string' } }, required: ['prompt'] } },
        // TTS
        { name: 'text_to_speech', description: 'Convert text to speech audio', inputSchema: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' }, speed: { type: 'number' }, format: { type: 'string' } }, required: ['text'] } },
      ],
      ...zhipuConfig,
    },
  ],
};
