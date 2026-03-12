import type { BuiltinOrgSeed } from '../types.js';

const zhipuConfig = {
  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', sensitive: true, description: 'ZhipuAI API key' },
      feature_search: { type: 'boolean', description: 'Enable Web Search' },
      feature_reader: { type: 'boolean', description: 'Enable Web Reader' },
      feature_zread: { type: 'boolean', description: 'Enable ZRead Document Analysis' },
      feature_ocr: { type: 'boolean', description: 'Enable official OCR service' },
      feature_file_parser: { type: 'boolean', description: 'Enable official synchronous file parser' },
      feature_layout_parsing: { type: 'boolean', description: 'Enable official GLM-OCR layout parsing' },
      feature_moderation: { type: 'boolean', description: 'Enable official content safety moderation' },
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
    feature_ocr: true,
    feature_file_parser: true,
    feature_layout_parsing: true,
    feature_moderation: true,
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
  description: 'ZhipuAI official toolkit providing web search, reading, document analysis, OCR, layout parsing, content moderation, vision, speech-to-text, image generation, and text-to-speech capabilities.',
  plugins: [
    {
      slug: 'toolkit',
      displayName: 'ZhipuAI Toolkit',
      description: 'Unified ZhipuAI toolkit with search, web reading, code/document analysis, OCR, layout parsing, content moderation, vision, STT, image generation, and TTS.',
      longDescription: 'A comprehensive AI toolkit powered by ZhipuAI. Includes official Web Search API, official Reader API, ZRead repository analysis, official OCR service, official GLM-OCR layout parsing, official content moderation, image/video analysis (GLM-4V), speech-to-text (GLM-ASR), image generation (GLM-Image / CogView), and text-to-speech (GLM-TTS). Enable or disable individual features via configuration toggles.',
      transport: 'builtin',
      entryPoint: 'z_ai/toolkit',
      defaultBindingScope: 'workspace',
      defaultReuseScope: 'workspace',
      requiresHandshake: false,
      authorization: {
        requiredPermissions: ['network:outbound', 'files:read', 'files:write'],
        defaultGrantScope: 'workspace',
        reason: 'ZhipuAI toolkit needs outbound network access and file read/write access to process FileRefs and store generated artifacts.',
      },
      tags: ['search', 'web', 'reader', 'documents', 'code', 'vision', 'image', 'ocr', 'layout', 'moderation', 'file-parser', 'stt', 'tts', 'image-gen', 'builtin'],
      toolsManifest: [
        // Search
        { name: 'webSearchPrime', description: 'Search the web with the official ZhipuAI Web Search API. Supports search engine selection, intent detection, recency filters, domain filters, and result size controls. This wrapper defaults to search_std, searchIntent=false, count=10.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query. The official API recommends keeping it within 70 characters.' }, searchEngine: { type: 'string', enum: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'] }, searchIntent: { type: 'boolean', description: 'Whether to let the API detect search intent before executing the search.' }, count: { type: 'integer', description: 'Number of results to return, 1-50.' }, domainFilter: { type: 'string', description: 'Optional domain whitelist filter such as www.example.com.' }, recencyFilter: { type: 'string', enum: ['oneDay', 'oneWeek', 'oneMonth', 'oneYear', 'noLimit'] }, contentSize: { type: 'string', enum: ['medium', 'high'] }, requestId: { type: 'string' }, userId: { type: 'string' } }, required: ['query'] } },
        // Reader
        { name: 'webReader', description: 'Read and parse a web page with the official ZhipuAI Reader API. Supports cache control, return format, image retention, and image/link summaries. This wrapper follows the official defaults unless you override them.', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Target web page URL to fetch and parse.' }, timeout: { type: 'integer' }, noCache: { type: 'boolean' }, returnFormat: { type: 'string', enum: ['markdown', 'text'] }, retainImages: { type: 'boolean' }, noGfm: { type: 'boolean' }, keepImgDataUrl: { type: 'boolean' }, withImagesSummary: { type: 'boolean' }, withLinksSummary: { type: 'boolean' } }, required: ['url'] } },
        // ZRead
        { name: 'search_doc', description: 'Search a supported open-source GitHub repository for docs, issues, PRs, release notes, and related project knowledge.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search query for repository docs or project knowledge.' } }, required: ['query'] } },
        { name: 'get_repo_structure', description: 'Get the directory structure and file tree of a supported open-source GitHub repository.', inputSchema: { type: 'object', properties: { repo_url: { type: 'string', description: 'Public GitHub repository URL.' } }, required: ['repo_url'] } },
        { name: 'read_file', description: 'Read the full contents of a file from a supported open-source GitHub repository.', inputSchema: { type: 'object', properties: { repo_url: { type: 'string', description: 'Public GitHub repository URL.' }, file_path: { type: 'string', description: 'Path to the target file inside the repository.' } }, required: ['repo_url', 'file_path'] } },
        // OCR / file parser
        { name: 'ocr_image', description: 'Run the official ZhipuAI OCR service on an image FileRef, with optional language hint and confidence output.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string', description: 'Image FileRef to send to OCR.' }, languageType: { type: 'string', enum: ['CHN_ENG', 'AUTO', 'ENG', 'JAP', 'KOR', 'FRE', 'SPA', 'POR', 'GER', 'ITA', 'RUS', 'DAN', 'DUT', 'MAL', 'SWE', 'IND', 'POL', 'ROM', 'TUR', 'GRE', 'HUN', 'THA', 'VIE', 'ARA', 'HIN'] }, probability: { type: 'boolean', description: 'Whether to include confidence output.' } }, required: ['fileRef'] } },
        { name: 'parse_file_sync', description: 'Run the official ZhipuAI synchronous file parser on a document or image FileRef. May return parsed text and/or a structured parsing result archive.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string', description: 'Document or image FileRef to parse.' }, fileType: { type: 'string', enum: ['WPS', 'PDF', 'DOCX', 'DOC', 'XLS', 'XLSX', 'PPT', 'PPTX', 'PNG', 'JPG', 'JPEG', 'CSV', 'TXT', 'MD', 'HTML', 'BMP', 'GIF', 'WEBP', 'HEIC', 'EPS', 'ICNS', 'IM', 'PCX', 'PPM', 'TIFF', 'XBM', 'HEIF', 'JP2'] } }, required: ['fileRef'] } },
        { name: 'layout_parsing', description: 'Run the official GLM-OCR layout parsing API on an image or PDF FileRef. Returns markdown text, layout metadata, and optional visualization images.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string', description: 'Image or PDF FileRef to parse.' }, returnCropImages: { type: 'boolean' }, needLayoutVisualization: { type: 'boolean' }, startPageId: { type: 'integer' }, endPageId: { type: 'integer' }, requestId: { type: 'string' }, userId: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'moderate_content', description: 'Run the official ZhipuAI content safety API on text and/or FileRefs. Supports text, image, audio, and video moderation.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, fileRef: { type: 'string' }, fileRefs: { type: 'array', items: { type: 'string' } } }, required: [] } },
        // Vision
        { name: 'ui_to_artifact', description: 'Convert a UI screenshot into code guidance, a generation prompt, a design specification, or a natural-language description.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, artifactType: { type: 'string', enum: ['frontend_code', 'design_prompt', 'design_spec', 'natural_language'] }, framework: { type: 'string' }, instructions: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'image_analysis', description: 'General-purpose image understanding for visual content not covered by the more specialized screenshot or diagram tools.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, focus: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'extract_text_from_screenshot', description: 'Extract visible text from screenshots, code panes, terminal output, documents, and other on-screen text.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, language: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'diagnose_error_screenshot', description: 'Analyze an error screenshot, popup, stack trace, or failing UI state and provide diagnosis plus suggested fixes.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, context: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'understand_technical_diagram', description: 'Interpret architecture diagrams, flowcharts, UML, ER diagrams, and other technical drawings.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, diagram_type: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'analyze_data_visualization', description: 'Analyze dashboards, charts, and graphs to extract trends, anomalies, and key business insights.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, questions: { type: 'string' } }, required: ['fileRef'] } },
        { name: 'ui_diff_check', description: 'Compare two UI screenshots to find visual differences, regressions, and design-to-implementation mismatches.', inputSchema: { type: 'object', properties: { beforeFileRef: { type: 'string' }, afterFileRef: { type: 'string' }, focus_areas: { type: 'string' } }, required: ['beforeFileRef', 'afterFileRef'] } },
        { name: 'image_qa', description: 'Answer questions about an image', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, question: { type: 'string' } }, required: ['fileRef', 'question'] } },
        { name: 'video_analysis', description: 'Analyze video content and summarize key scenes, events, and details. Intended for common MP4/MOV/M4V-style video understanding workflows.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, question: { type: 'string' } }, required: ['fileRef'] } },
        // STT
        { name: 'audio_transcription', description: 'Transcribe audio to text with the official GLM-ASR API. Supports FileRef input, optional prompt context, hotwords, requestId, and userId.', inputSchema: { type: 'object', properties: { fileRef: { type: 'string' }, prompt: { type: 'string' }, hotwords: { type: 'array', items: { type: 'string' } }, requestId: { type: 'string' }, userId: { type: 'string' } }, required: ['fileRef'] } },
        // Image Generation
        { name: 'generate_image', description: 'Generate an image with the official ZhipuAI image API. Supports model, quality, size, watermarkEnabled, and userId.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, size: { type: 'string' }, model: { type: 'string', enum: ['glm-image', 'cogview-4-250304', 'cogview-4', 'cogview-3-flash'] }, quality: { type: 'string', enum: ['standard', 'hd'] }, watermarkEnabled: { type: 'boolean' }, userId: { type: 'string' } }, required: ['prompt'] } },
        // TTS
        { name: 'text_to_speech', description: 'Convert text to speech audio with the official GLM-TTS API. Supports voice, speed, volume, format, and watermarkEnabled.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string', enum: ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'] }, speed: { type: 'number' }, volume: { type: 'number' }, format: { type: 'string', enum: ['wav', 'pcm'] }, watermarkEnabled: { type: 'boolean' } }, required: ['text'] } },
      ],
      ...zhipuConfig,
    },
  ],
};
