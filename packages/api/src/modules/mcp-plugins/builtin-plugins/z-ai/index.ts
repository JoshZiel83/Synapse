import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

const zhipuConfig = {
  configSchema: {
    type: "object",
    properties: {
      apiKey: {
        type: "string",
        sensitive: true,
        description: "ZhipuAI API key",
      },
      feature_search: { type: "boolean", description: "Enable Web Search" },
      feature_reader: { type: "boolean", description: "Enable Web Reader" },
      feature_zread: {
        type: "boolean",
        description: "Enable ZRead Document Analysis",
      },
      feature_ocr: {
        type: "boolean",
        description: "Enable official OCR service",
      },
      feature_file_parser: {
        type: "boolean",
        description: "Enable official synchronous file parser",
      },
      feature_layout_parsing: {
        type: "boolean",
        description: "Enable official GLM-OCR layout parsing",
      },
      feature_moderation: {
        type: "boolean",
        description: "Enable official content safety moderation",
      },
      feature_vision: {
        type: "boolean",
        description: "Enable Vision Analysis",
      },
      feature_stt: { type: "boolean", description: "Enable Speech-to-Text" },
      feature_image_gen: {
        type: "boolean",
        description: "Enable Image Generation",
      },
      feature_tts: { type: "boolean", description: "Enable Text-to-Speech" },
    },
    required: ["apiKey"],
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
    {
      field: "apiKey",
      rule: "required" as const,
      message: "API key is required",
    },
    {
      field: "apiKey",
      rule: "min_length" as const,
      value: 10,
      message: "API key seems too short",
    },
  ],
  configFields: [
    {
      key: "apiKey",
      type: "secret" as const,
      titleI18n: i18n("API Key", "API 密钥"),
      descriptionI18n: i18n("Your ZhipuAI API key.", "你的智谱 API 密钥。"),
      placeholderI18n: i18n("Paste your API key", "粘贴你的 API 密钥"),
      required: true,
      secret: true,
    },
    {
      key: "feature_search",
      type: "boolean" as const,
      titleI18n: i18n("Enable Web Search", "启用联网搜索"),
      descriptionI18n: i18n(
        "Expose the official web search tools.",
        "暴露官方联网搜索工具。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_reader",
      type: "boolean" as const,
      titleI18n: i18n("Enable Web Reader", "启用网页阅读"),
      descriptionI18n: i18n(
        "Expose the official web reader tools.",
        "暴露官方网页阅读工具。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_zread",
      type: "boolean" as const,
      titleI18n: i18n("Enable ZRead", "启用 ZRead"),
      descriptionI18n: i18n(
        "Expose repository search and file reading tools.",
        "暴露仓库搜索和文件读取工具。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_ocr",
      type: "boolean" as const,
      titleI18n: i18n("Enable OCR", "启用 OCR"),
      descriptionI18n: i18n(
        "Expose the official OCR service.",
        "暴露官方 OCR 服务。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_file_parser",
      type: "boolean" as const,
      titleI18n: i18n("Enable File Parser", "启用文件解析"),
      descriptionI18n: i18n(
        "Expose the official synchronous file parser.",
        "暴露官方同步文件解析能力。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_layout_parsing",
      type: "boolean" as const,
      titleI18n: i18n("Enable Layout Parsing", "启用版面解析"),
      descriptionI18n: i18n(
        "Expose GLM-OCR layout parsing.",
        "暴露 GLM-OCR 版面解析能力。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_moderation",
      type: "boolean" as const,
      titleI18n: i18n("Enable Content Moderation", "启用内容安全"),
      descriptionI18n: i18n(
        "Expose the official content moderation API.",
        "暴露官方内容安全审核能力。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_vision",
      type: "boolean" as const,
      titleI18n: i18n("Enable Vision Tools", "启用视觉工具"),
      descriptionI18n: i18n(
        "Expose screenshot, image, and video understanding tools.",
        "暴露截图、图片和视频理解工具。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_stt",
      type: "boolean" as const,
      titleI18n: i18n("Enable Speech to Text", "启用语音转文本"),
      descriptionI18n: i18n(
        "Expose GLM-ASR transcription.",
        "暴露 GLM-ASR 转写能力。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_image_gen",
      type: "boolean" as const,
      titleI18n: i18n("Enable Image Generation", "启用图像生成"),
      descriptionI18n: i18n(
        "Expose the official image generation API.",
        "暴露官方图像生成能力。"
      ),
      defaultValue: true,
    },
    {
      key: "feature_tts",
      type: "boolean" as const,
      titleI18n: i18n("Enable Text to Speech", "启用文本转语音"),
      descriptionI18n: i18n(
        "Expose GLM-TTS speech synthesis.",
        "暴露 GLM-TTS 语音合成能力。"
      ),
      defaultValue: true,
    },
  ],
  setupSteps: [
    {
      id: "api_key",
      title: "Configure API Key",
      description:
        "Enter your ZhipuAI API key. You can obtain one from the ZhipuAI developer platform.",
      scope: "plugin" as const,
      fields: ["apiKey"],
      helpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
      helpText: "Navigate to your ZhipuAI dashboard to create an API key.",
    },
  ],
  installFlow: {
    steps: [
      {
        id: "credentials",
        kind: "form" as const,
        titleI18n: i18n("Connect your ZhipuAI account", "连接你的智谱账号"),
        descriptionI18n: i18n(
          "Paste an API key to enable this toolkit.",
          "粘贴 API 密钥以启用该工具包。"
        ),
        scope: "plugin" as const,
        fields: ["apiKey"],
        helpUrl: "https://open.bigmodel.cn/usercenter/apikeys",
        helpTextI18n: i18n(
          "Create an API key in the ZhipuAI dashboard and paste it here.",
          "在智谱开放平台创建 API 密钥后粘贴到这里。"
        ),
      },
      {
        id: "features",
        kind: "form" as const,
        titleI18n: i18n("Choose enabled capabilities", "选择启用的能力"),
        descriptionI18n: i18n(
          "Decide which official ZhipuAI tools should be exposed to your actors.",
          "决定向你的 Actor 暴露哪些官方智谱能力。"
        ),
        scope: "plugin" as const,
        fields: [
          "feature_search",
          "feature_reader",
          "feature_zread",
          "feature_ocr",
          "feature_file_parser",
          "feature_layout_parsing",
          "feature_moderation",
          "feature_vision",
          "feature_stt",
          "feature_image_gen",
          "feature_tts",
        ],
      },
      {
        id: "review",
        kind: "confirm" as const,
        titleI18n: i18n("Review and install", "确认并安装"),
        descriptionI18n: i18n(
          "Review the selected scope and enabled capabilities before installing.",
          "确认安装范围和已启用能力后再执行安装。"
        ),
        scope: "plugin" as const,
        fields: [],
      },
    ],
  },
}

export const zAiSeed: BuiltinOrgSeed = {
  slug: "z_ai",
  displayName: "ZhipuAI",
  description:
    "ZhipuAI official toolkit providing web search, reading, document analysis, OCR, layout parsing, content moderation, vision, speech-to-text, image generation, and text-to-speech capabilities.",
  plugins: [
    {
      slug: "toolkit",
      displayName: "ZhipuAI Toolkit",
      description:
        "Unified ZhipuAI toolkit with search, web reading, code/document analysis, OCR, layout parsing, content moderation, vision, STT, image generation, and TTS.",
      longDescription:
        "A comprehensive AI toolkit powered by ZhipuAI. Includes official Web Search API, official Reader API, ZRead repository analysis, official OCR service, official GLM-OCR layout parsing, official content moderation, image/video analysis (GLM-4V), speech-to-text (GLM-ASR), image generation (GLM-Image / CogView), and text-to-speech (GLM-TTS). Enable or disable individual features via configuration toggles.",
      displayNameI18n: i18n("ZhipuAI Toolkit", "智谱工具包"),
      descriptionI18n: i18n(
        "Unified ZhipuAI toolkit with search, web reading, code/document analysis, OCR, layout parsing, content moderation, vision, STT, image generation, and TTS.",
        "统一的智谱工具包，涵盖联网搜索、网页阅读、仓库分析、OCR、版面解析、内容安全、视觉理解、语音转文本、图像生成与文本转语音。"
      ),
      longDescriptionI18n: i18n(
        "A comprehensive AI toolkit powered by ZhipuAI. Includes official Web Search API, official Reader API, ZRead repository analysis, official OCR service, official GLM-OCR layout parsing, official content moderation, image/video analysis (GLM-4V), speech-to-text (GLM-ASR), image generation (GLM-Image / CogView), and text-to-speech (GLM-TTS). Enable or disable individual features via configuration toggles.",
        "由智谱能力驱动的综合工具包，包含官方联网搜索、网页阅读、ZRead 仓库分析、OCR、GLM-OCR 版面解析、内容安全、图片/视频理解、语音转写、图像生成和语音合成，并支持按功能开关控制。"
      ),
      summaryI18n: i18n(
        "Official ZhipuAI toolkit for multimodal, search, and document workflows.",
        "用于多模态、联网搜索和文档处理的官方智谱工具包。"
      ),
      defaultLocale: "zh-CN",
      transport: "builtin",
      entryPoint: "z_ai/toolkit",
      defaultInstanceScope: "workspace",
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/z_ai.svg",
      authorization: {
        requiredPermissions: ["network:outbound", "files:read", "files:write"],
        reason:
          "ZhipuAI toolkit needs outbound network access and file read/write access to process FileRefs and store generated artifacts.",
      },
      categorySlugs: [
        "search-and-retrieval",
        "documents-and-reading",
        "vision-and-ocr",
        "audio-and-speech",
        "media-generation",
        "safety-and-moderation",
      ],
      tags: [
        "search",
        "web",
        "reader",
        "documents",
        "code",
        "vision",
        "image",
        "ocr",
        "layout",
        "moderation",
        "file-parser",
        "stt",
        "tts",
        "image-gen",
        "builtin",
      ],
      toolsManifest: [
        // Search
        {
          name: "webSearchPrime",
          description:
            "Search the web with the official ZhipuAI Web Search API. Supports search engine selection, intent detection, recency filters, domain filters, and result size controls. This wrapper defaults to search_std, searchIntent=false, count=10.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query. The official API recommends keeping it within 70 characters.",
              },
              searchEngine: {
                type: "string",
                enum: [
                  "search_std",
                  "search_pro",
                  "search_pro_sogou",
                  "search_pro_quark",
                ],
              },
              searchIntent: {
                type: "boolean",
                description:
                  "Whether to let the API detect search intent before executing the search.",
              },
              count: {
                type: "integer",
                description: "Number of results to return, 1-50.",
              },
              domainFilter: {
                type: "string",
                description:
                  "Optional domain whitelist filter such as www.example.com.",
              },
              recencyFilter: {
                type: "string",
                enum: ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
              },
              contentSize: { type: "string", enum: ["medium", "high"] },
              requestId: { type: "string" },
              userId: { type: "string" },
            },
            required: ["query"],
          },
        },
        // Reader
        {
          name: "webReader",
          description:
            "Read and parse a web page with the official ZhipuAI Reader API. Supports cache control, return format, image retention, and image/link summaries. This wrapper follows the official defaults unless you override them.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "Target web page URL to fetch and parse.",
              },
              timeout: { type: "integer" },
              noCache: { type: "boolean" },
              returnFormat: { type: "string", enum: ["markdown", "text"] },
              retainImages: { type: "boolean" },
              noGfm: { type: "boolean" },
              keepImgDataUrl: { type: "boolean" },
              withImagesSummary: { type: "boolean" },
              withLinksSummary: { type: "boolean" },
            },
            required: ["url"],
          },
        },
        // ZRead
        {
          name: "search_doc",
          description:
            "Search a supported open-source GitHub repository for docs, issues, PRs, release notes, and related project knowledge.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query for repository docs or project knowledge.",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_repo_structure",
          description:
            "Get the directory structure and file tree of a supported open-source GitHub repository.",
          inputSchema: {
            type: "object",
            properties: {
              repo_url: {
                type: "string",
                description: "Public GitHub repository URL.",
              },
            },
            required: ["repo_url"],
          },
        },
        {
          name: "read_file",
          description:
            "Read the full contents of a file from a supported open-source GitHub repository.",
          inputSchema: {
            type: "object",
            properties: {
              repo_url: {
                type: "string",
                description: "Public GitHub repository URL.",
              },
              file_path: {
                type: "string",
                description: "Path to the target file inside the repository.",
              },
            },
            required: ["repo_url", "file_path"],
          },
        },
        // OCR / file parser
        {
          name: "ocr_image",
          description:
            "Run the official ZhipuAI OCR service on an image FileRef, with optional language hint and confidence output.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: {
                type: "string",
                description: "Image FileRef to send to OCR.",
              },
              languageType: {
                type: "string",
                enum: [
                  "CHN_ENG",
                  "AUTO",
                  "ENG",
                  "JAP",
                  "KOR",
                  "FRE",
                  "SPA",
                  "POR",
                  "GER",
                  "ITA",
                  "RUS",
                  "DAN",
                  "DUT",
                  "MAL",
                  "SWE",
                  "IND",
                  "POL",
                  "ROM",
                  "TUR",
                  "GRE",
                  "HUN",
                  "THA",
                  "VIE",
                  "ARA",
                  "HIN",
                ],
              },
              probability: {
                type: "boolean",
                description: "Whether to include confidence output.",
              },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "parse_file_sync",
          description:
            "Run the official ZhipuAI synchronous file parser on a document or image FileRef. May return parsed text and/or a structured parsing result archive.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: {
                type: "string",
                description: "Document or image FileRef to parse.",
              },
              fileType: {
                type: "string",
                enum: [
                  "WPS",
                  "PDF",
                  "DOCX",
                  "DOC",
                  "XLS",
                  "XLSX",
                  "PPT",
                  "PPTX",
                  "PNG",
                  "JPG",
                  "JPEG",
                  "CSV",
                  "TXT",
                  "MD",
                  "HTML",
                  "BMP",
                  "GIF",
                  "WEBP",
                  "HEIC",
                  "EPS",
                  "ICNS",
                  "IM",
                  "PCX",
                  "PPM",
                  "TIFF",
                  "XBM",
                  "HEIF",
                  "JP2",
                ],
              },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "layout_parsing",
          description:
            "Run the official GLM-OCR layout parsing API on an image or PDF FileRef. Returns markdown text, layout metadata, and optional visualization images.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: {
                type: "string",
                description: "Image or PDF FileRef to parse.",
              },
              returnCropImages: { type: "boolean" },
              needLayoutVisualization: { type: "boolean" },
              startPageId: { type: "integer" },
              endPageId: { type: "integer" },
              requestId: { type: "string" },
              userId: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "moderate_content",
          description:
            "Run the official ZhipuAI content safety API on text and/or FileRefs. Supports text, image, audio, and video moderation.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              fileRef: { type: "string" },
              fileRefs: { type: "array", items: { type: "string" } },
            },
            required: [],
          },
        },
        // Vision
        {
          name: "ui_to_artifact",
          description:
            "Convert a UI screenshot into code guidance, a generation prompt, a design specification, or a natural-language description.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              artifactType: {
                type: "string",
                enum: [
                  "frontend_code",
                  "design_prompt",
                  "design_spec",
                  "natural_language",
                ],
              },
              framework: { type: "string" },
              instructions: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "image_analysis",
          description:
            "General-purpose image understanding for visual content not covered by the more specialized screenshot or diagram tools.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              focus: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "extract_text_from_screenshot",
          description:
            "Extract visible text from screenshots, code panes, terminal output, documents, and other on-screen text.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              language: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "diagnose_error_screenshot",
          description:
            "Analyze an error screenshot, popup, stack trace, or failing UI state and provide diagnosis plus suggested fixes.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              context: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "understand_technical_diagram",
          description:
            "Interpret architecture diagrams, flowcharts, UML, ER diagrams, and other technical drawings.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              diagram_type: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "analyze_data_visualization",
          description:
            "Analyze dashboards, charts, and graphs to extract trends, anomalies, and key business insights.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              questions: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        {
          name: "ui_diff_check",
          description:
            "Compare two UI screenshots to find visual differences, regressions, and design-to-implementation mismatches.",
          inputSchema: {
            type: "object",
            properties: {
              beforeFileRef: { type: "string" },
              afterFileRef: { type: "string" },
              focus_areas: { type: "string" },
            },
            required: ["beforeFileRef", "afterFileRef"],
          },
        },
        {
          name: "image_qa",
          description: "Answer questions about an image",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              question: { type: "string" },
            },
            required: ["fileRef", "question"],
          },
        },
        {
          name: "video_analysis",
          description:
            "Analyze video content and summarize key scenes, events, and details. Intended for common MP4/MOV/M4V-style video understanding workflows.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              question: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        // STT
        {
          name: "audio_transcription",
          description:
            "Transcribe audio to text with the official GLM-ASR API. Supports FileRef input, optional prompt context, hotwords, requestId, and userId.",
          inputSchema: {
            type: "object",
            properties: {
              fileRef: { type: "string" },
              prompt: { type: "string" },
              hotwords: { type: "array", items: { type: "string" } },
              requestId: { type: "string" },
              userId: { type: "string" },
            },
            required: ["fileRef"],
          },
        },
        // Image Generation
        {
          name: "generate_image",
          description:
            "Generate an image with the official ZhipuAI image API. Supports model, quality, size, watermarkEnabled, and userId.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              size: { type: "string" },
              model: {
                type: "string",
                enum: [
                  "glm-image",
                  "cogview-4-250304",
                  "cogview-4",
                  "cogview-3-flash",
                ],
              },
              quality: { type: "string", enum: ["standard", "hd"] },
              watermarkEnabled: { type: "boolean" },
              userId: { type: "string" },
            },
            required: ["prompt"],
          },
        },
        // TTS
        {
          name: "text_to_speech",
          description:
            "Convert text to speech audio with the official GLM-TTS API. Supports voice, speed, volume, format, and watermarkEnabled.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string" },
              voice: {
                type: "string",
                enum: [
                  "tongtong",
                  "chuichui",
                  "xiaochen",
                  "jam",
                  "kazi",
                  "douji",
                  "luodo",
                ],
              },
              speed: { type: "number" },
              volume: { type: "number" },
              format: { type: "string", enum: ["wav", "pcm"] },
              watermarkEnabled: { type: "boolean" },
            },
            required: ["text"],
          },
        },
      ],
      ...zhipuConfig,
    },
  ],
}
