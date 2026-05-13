import type { MarketplaceItemKind, LocalizedText } from "@synapse/shared"

export interface BuiltinCapabilityCategorySeed {
  slug: string
  targetKind: MarketplaceItemKind
  displayName: string
  displayNameI18n?: LocalizedText
  description?: string
  descriptionI18n?: LocalizedText
  defaultLocale?: string
  sortOrder: number
}

const i18n = (en: string, zhCN: string): LocalizedText => ({
  en,
  "zh-CN": zhCN,
})

export const builtinCapabilityCategories: BuiltinCapabilityCategorySeed[] = [
  {
    slug: "search-and-retrieval",
    targetKind: "plugin",
    displayName: "Search & Retrieval",
    displayNameI18n: i18n("Search & Retrieval", "搜索与检索"),
    description:
      "Search the web, retrieve references, and gather external information.",
    descriptionI18n: i18n(
      "Search the web, retrieve references, and gather external information.",
      "搜索网络、检索资料并收集外部信息。"
    ),
    defaultLocale: "en",
    sortOrder: 10,
  },
  {
    slug: "documents-and-reading",
    targetKind: "plugin",
    displayName: "Documents & Reading",
    displayNameI18n: i18n("Documents & Reading", "文档与阅读"),
    description:
      "Read webpages, parse files, and extract structured document content.",
    descriptionI18n: i18n(
      "Read webpages, parse files, and extract structured document content.",
      "读取网页、解析文件并提取结构化文档内容。"
    ),
    defaultLocale: "en",
    sortOrder: 20,
  },
  {
    slug: "vision-and-ocr",
    targetKind: "plugin",
    displayName: "Vision & OCR",
    displayNameI18n: i18n("Vision & OCR", "视觉与 OCR"),
    description:
      "Analyze images, screenshots, diagrams, and extract text from visual content.",
    descriptionI18n: i18n(
      "Analyze images, screenshots, diagrams, and extract text from visual content.",
      "分析图片、截图、图表，并从视觉内容中提取文字。"
    ),
    defaultLocale: "en",
    sortOrder: 30,
  },
  {
    slug: "audio-and-speech",
    targetKind: "plugin",
    displayName: "Audio & Speech",
    displayNameI18n: i18n("Audio & Speech", "音频与语音"),
    description:
      "Transcribe audio, synthesize speech, and work with spoken media.",
    descriptionI18n: i18n(
      "Transcribe audio, synthesize speech, and work with spoken media.",
      "转录音频、合成语音，并处理语音媒体内容。"
    ),
    defaultLocale: "en",
    sortOrder: 40,
  },
  {
    slug: "media-generation",
    targetKind: "plugin",
    displayName: "Media Generation",
    displayNameI18n: i18n("Media Generation", "媒体生成"),
    description:
      "Generate images, audio, and other media artifacts from prompts.",
    descriptionI18n: i18n(
      "Generate images, audio, and other media artifacts from prompts.",
      "根据提示生成图片、音频和其他媒体产物。"
    ),
    defaultLocale: "en",
    sortOrder: 50,
  },
  {
    slug: "safety-and-moderation",
    targetKind: "plugin",
    displayName: "Safety & Moderation",
    displayNameI18n: i18n("Safety & Moderation", "安全与审核"),
    description:
      "Review content for policy, compliance, and moderation outcomes.",
    descriptionI18n: i18n(
      "Review content for policy, compliance, and moderation outcomes.",
      "审核内容的策略、合规和安全风险结果。"
    ),
    defaultLocale: "en",
    sortOrder: 60,
  },
  {
    slug: "integrations-and-automation",
    targetKind: "plugin",
    displayName: "Integrations & Automation",
    displayNameI18n: i18n("Integrations & Automation", "集成与自动化"),
    description:
      "Connect external systems, services, and workflows into the platform.",
    descriptionI18n: i18n(
      "Connect external systems, services, and workflows into the platform.",
      "把外部系统、服务和工作流接入平台。"
    ),
    defaultLocale: "en",
    sortOrder: 70,
  },
]
