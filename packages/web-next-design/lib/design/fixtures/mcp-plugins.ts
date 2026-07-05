// Curated MCP-plugin fixtures — our 12 REAL built-in plugins (高德/AMiner/哔哩哔哩/
// 飞书/Figma/Firecrawl/GitHub/GitLab/米家/Notion/小红书/智谱) with accurate metadata,
// replacing the faker garbage that rendered an empty "No plugins found" page. The
// views are strict z.strictObjects, so every field is supplied via builders.
import type {
  MarketplacePluginView,
  PluginCategoryView,
  MarketplacePluginCategoryView,
  PluginInstallationDetailView,
  PluginConfigFieldDefinition,
  PluginAuthBindingDefinition,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const WS = designWorkspaceId
const CREATED = ts("2026-05-01T08:00:00.000Z")
const UPDATED = ts("2026-06-28T08:00:00.000Z")
const zh = (zhCN: string, en: string) => ({ "zh-CN": zhCN, en })

// ── categories (real slugs) ──────────────────────────────────────────────────
const CATS: Array<[string, string, string]> = [
  ["search-and-retrieval", "搜索与检索", "Search & Retrieval"],
  ["social-and-content", "社交与内容", "Social & Content"],
  ["integrations-and-automation", "集成与自动化", "Integrations & Automation"],
  ["documents-and-reading", "文档与阅读", "Documents & Reading"],
  ["vision-and-ocr", "视觉与 OCR", "Vision & OCR"],
  ["media-generation", "媒体生成", "Media Generation"],
  ["audio-and-speech", "音频与语音", "Audio & Speech"],
  ["safety-and-moderation", "安全与审核", "Safety & Moderation"],
]

export const designPluginCategories: PluginCategoryView[] = CATS.map(
  ([slug, label, en], i) => ({
    id: `cat-${slug}`,
    slug,
    displayName: label,
    displayNameI18n: zh(label, en),
    description: "",
    descriptionI18n: zh("", ""),
    defaultLocale: "zh-CN",
    sortOrder: i,
  })
)

const inlineCat = (slug: string): MarketplacePluginCategoryView => {
  const c = designPluginCategories.find((x) => x.slug === slug)!
  return {
    id: c.id,
    slug: c.slug,
    displayName: c.displayName,
    displayNameI18n: c.displayNameI18n,
    description: c.description,
    descriptionI18n: c.descriptionI18n,
    defaultLocale: c.defaultLocale,
  }
}

// ── region + transport + auth helpers (region has NO contract field — a curated
// client-side classification of the 8 built-in publisher orgs) ────────────────
const OVERSEAS = new Set(["github", "gitlab", "figma", "notion", "firecrawl"])
export const pluginRegion = (slug: string): "overseas" | "china" =>
  OVERSEAS.has(slug) ? "overseas" : "china"
export const regionLabel = (slug: string) =>
  pluginRegion(slug) === "overseas" ? "海外" : "国内"

export const transportLabel = (t: string) =>
  t === "builtin" ? "内置" : t === "stdio" ? "本地" : "远程 MCP"

// map our plugin slug → the PLUGIN_BRAND_ICONS key (two differ)
const BRAND_KEY: Record<string, string> = { xhs: "xiaohongshu", "z-ai": "z_ai" }
export const pluginBrandSlug = (slug: string) => BRAND_KEY[slug] ?? slug

type AuthKind = "apikey" | "cookie" | "oauth" | "feishu" | "mijia" | "none"
export function pluginAuthLabel(p: MarketplacePluginView): string {
  const d = p.authBindings[0]?.driver
  if (d === "oauth2_authorization_code_pkce") return "需登录授权"
  if (d === "mijia_qr_login" || d === "feishu_cli_setup") return "需扫码授权"
  const secret = p.configFields.find((f) => f.secret || f.type === "secret")
  if (secret) return secret.key === "cookie" ? "需登录 Cookie" : "需 API Key"
  return "无需授权"
}

function authFields(auth: AuthKind): {
  fields: PluginConfigFieldDefinition[]
  bindings: PluginAuthBindingDefinition[]
} {
  switch (auth) {
    case "apikey":
      return {
        fields: [
          {
            key: "apiKey",
            type: "secret",
            titleI18n: zh("API Key", "API Key"),
            required: true,
            secret: true,
          },
        ],
        bindings: [],
      }
    case "cookie":
      return {
        fields: [
          {
            key: "cookie",
            type: "secret",
            titleI18n: zh("登录 Cookie", "Login Cookie"),
            descriptionI18n: zh(
              "从网页版登录后复制的 Cookie",
              "Cookie copied from the logged-in web session"
            ),
            required: true,
            secret: true,
          },
        ],
        bindings: [],
      }
    case "oauth":
      return {
        fields: [
          {
            key: "connection",
            type: "auth_connection",
            titleI18n: zh("账号授权", "Account"),
            required: true,
            authBindingKey: "oauth",
          },
        ],
        bindings: [
          {
            key: "oauth",
            driver: "oauth2_authorization_code_pkce",
            fieldKey: "connection",
            displayNameI18n: zh("登录授权", "Sign in"),
            scopes: ["read", "write"],
          },
        ],
      }
    case "feishu":
      return {
        fields: [
          {
            key: "connection",
            type: "auth_connection",
            titleI18n: zh("扫码授权", "QR sign-in"),
            required: true,
            authBindingKey: "feishu",
          },
        ],
        bindings: [
          {
            key: "feishu",
            driver: "feishu_cli_setup",
            fieldKey: "connection",
            displayNameI18n: zh("飞书扫码授权", "Feishu QR"),
          },
        ],
      }
    case "mijia":
      return {
        fields: [
          {
            key: "connection",
            type: "auth_connection",
            titleI18n: zh("扫码登录", "QR login"),
            required: true,
            authBindingKey: "mijia",
          },
        ],
        bindings: [
          {
            key: "mijia",
            driver: "mijia_qr_login",
            fieldKey: "connection",
            displayNameI18n: zh("米家扫码登录", "Mi Home QR"),
          },
        ],
      }
    default:
      return { fields: [], bindings: [] }
  }
}

// ── marketplace plugin builder (fills all 35 strict fields) ───────────────────
type Tool = { name: string; description: string }
function pluginView(o: {
  slug: string
  name: string
  nameEn: string
  desc: string
  long: string
  category: string
  transport: "builtin" | "http" | "sse" | "stdio"
  auth: AuthKind
  tags: string[]
  tools?: Tool[]
  permReason?: string
  version?: string
  extraFields?: PluginConfigFieldDefinition[]
}): MarketplacePluginView {
  const { fields, bindings } = authFields(o.auth)
  const configFields = [...fields, ...(o.extraFields ?? [])]
  return {
    id: `pl-${o.slug}`,
    orgId: `org-${o.slug}`,
    slug: o.slug,
    displayName: o.name,
    displayNameI18n: zh(o.name, o.nameEn),
    description: o.desc,
    descriptionI18n: zh(o.desc, o.nameEn),
    longDescription: o.long,
    longDescriptionI18n: zh(o.long, o.long),
    summaryI18n: zh(o.desc, o.nameEn),
    defaultLocale: "zh-CN",
    version: o.version ?? "1.0.0",
    transport: o.transport,
    entryPoint: `builtin/${o.slug}`,
    lifecycleScope: "workspace",
    defaultReuseScope: "workspace",
    defaultConversationTypeMask: 0,
    supportedReuseScopes: ["workspace", "conversation"],
    configSchema: {},
    configFields,
    defaultConfig: {},
    toolsManifest: (o.tools ?? []) as unknown[],
    validationRules: [],
    setupSteps: [],
    installFlow: { steps: [] },
    authBindings: bindings,
    authorization: {
      requiredPermissions: ["network:outbound"],
      reason: o.permReason ?? "需要访问外部服务以调用该插件的工具。",
    },
    tags: o.tags,
    categories: [inlineCat(o.category)],
    categorySlugs: [o.category],
    isActive: true,
    isBuiltin: true,
    downloadCount: 0,
    createdAt: CREATED,
    updatedAt: UPDATED,
    orgSlug: o.slug,
    orgDisplayName: o.name,
    publisher: {
      id: `pub-${o.slug}`,
      slug: o.slug,
      displayName: o.name,
      description: "",
      isVerified: true,
    },
    requiresHandshake: o.auth !== "none",
    metadata: {},
  }
}

export const designMarketplacePlugins: MarketplacePluginView[] = [
  pluginView({
    slug: "amap",
    name: "高德地图",
    nameEn: "AMap",
    desc: "高德官方 MCP：地理编码、POI 搜索、路线规划、天气、IP 定位。",
    long: "接入高德（Gaode）官方托管的 MCP 服务器，提供地理编码 / 逆地理编码、POI 搜索、行政区查询、天气、IP 定位与路线规划。工具在连接时由高德服务实时下发。",
    category: "search-and-retrieval",
    transport: "http",
    auth: "apikey",
    tags: ["地图", "地理", "官方"],
  }),
  pluginView({
    slug: "aminer",
    name: "AMiner 开放平台",
    nameEn: "AMiner",
    desc: "学术数据检索：学者、论文、专利、机构与会议。",
    long: "接入 AMiner 官方托管 MCP，覆盖学者、论文、专利、机构、会议的检索与详情、关系查询。工具在连接时实时下发。",
    category: "search-and-retrieval",
    transport: "sse",
    auth: "apikey",
    tags: ["学术", "论文", "检索", "官方"],
  }),
  pluginView({
    slug: "bilibili",
    name: "哔哩哔哩",
    nameEn: "Bilibili",
    desc: "读取 B 站视频/搜索/评论/用户，可选发评论、弹幕、动态。",
    long: "通过自建 MCP sidecar 读取哔哩哔哩的视频、搜索、评论、用户数据；写操作（评论 / 弹幕 / 动态）默认关闭、需显式开启且受账号风控限制。使用账号 Cookie 鉴权。",
    category: "social-and-content",
    transport: "http",
    auth: "cookie",
    tags: ["视频", "社交", "弹幕"],
    extraFields: [
      {
        key: "exposeWriteTools",
        type: "boolean",
        titleI18n: zh("开启写操作", "Expose write tools"),
        descriptionI18n: zh(
          "允许发评论 / 弹幕 / 动态（有账号风控风险）",
          "Allow posting comments / danmaku / dynamics"
        ),
        defaultValue: false,
      },
    ],
  }),
  pluginView({
    slug: "feishu",
    name: "飞书",
    nameEn: "Feishu",
    desc: "扫码接入飞书 / Lark，按需开启通讯录、消息、日历、文档、表格等。",
    long: "Synapse 原生插件，扫码授权后按你勾选的功能组开放为工具：通讯录、消息、日历、云文档、电子表格、多维表格、任务、云盘。仅申请所选功能所需的权限。",
    category: "integrations-and-automation",
    transport: "builtin",
    auth: "feishu",
    tags: ["协作", "办公", "文档"],
    tools: [
      { name: "feishu.im.send_text_message", description: "发送文本消息" },
      { name: "feishu.calendar.create_event", description: "创建日历日程" },
      { name: "feishu.docs.create_document", description: "新建云文档" },
      { name: "feishu.sheets.write_values", description: "写入电子表格" },
      { name: "feishu.base.create_record", description: "新建多维表格记录" },
      { name: "feishu.contacts.search_users", description: "搜索通讯录成员" },
    ],
  }),
  pluginView({
    slug: "figma",
    name: "Figma",
    nameEn: "Figma",
    desc: "登录后读写 Figma 设计上下文、变量、截图。",
    long: "接入 Figma 官方托管的远程 MCP（Streamable HTTP）。使用 Figma OAuth 登录后，可读取设计上下文与变量、获取截图、写入画布。",
    category: "integrations-and-automation",
    transport: "http",
    auth: "oauth",
    tags: ["设计", "协作"],
    tools: [
      { name: "get_design_context", description: "读取选中设计的上下文" },
      { name: "get_variables", description: "读取设计变量" },
      { name: "get_screenshots", description: "获取画面截图" },
      { name: "write_to_canvas", description: "写入画布" },
    ],
  }),
  pluginView({
    slug: "firecrawl",
    name: "Firecrawl",
    nameEn: "Firecrawl",
    desc: "抓取、爬取、映射、搜索、提取网页内容。",
    long: "接入 Firecrawl 托管的远程 MCP，让 Agent 抓取（scrape）、爬取（crawl）、映射（map）、搜索（search）、提取（extract）外部网页内容。",
    category: "search-and-retrieval",
    transport: "http",
    auth: "apikey",
    tags: ["网页", "抓取", "检索"],
    tools: [
      { name: "scrape", description: "抓取单个网页为干净内容" },
      { name: "crawl", description: "爬取整站" },
      { name: "map", description: "映射站点链接" },
      { name: "search", description: "网页搜索" },
      { name: "extract", description: "结构化提取" },
    ],
  }),
  pluginView({
    slug: "github",
    name: "GitHub",
    nameEn: "GitHub",
    desc: "GitHub 官方 MCP：读写仓库、Issue、PR，并注册 webhook。",
    long: "接入 GitHub 官方托管 MCP（HTTP），并复用同一 GitHub Token 注册仓库 webhook，让评论、PR、Issue 等事件回流。工具在连接时实时下发。",
    category: "integrations-and-automation",
    transport: "http",
    auth: "apikey",
    tags: ["代码", "开发", "官方"],
    extraFields: [
      {
        key: "apiBaseUrl",
        type: "text",
        titleI18n: zh("API 地址", "API base URL"),
        placeholderI18n: zh("https://api.github.com", "https://api.github.com"),
        defaultValue: "https://api.github.com",
      },
    ],
  }),
  pluginView({
    slug: "gitlab",
    name: "GitLab",
    nameEn: "GitLab",
    desc: "GitLab 官方 MCP：读写项目并创建 webhook。",
    long: "接入 GitLab 官方 MCP（HTTP），复用同一 GitLab Token 创建项目 webhook（评论、合并请求、流水线、推送）作为事件源。",
    category: "integrations-and-automation",
    transport: "http",
    auth: "apikey",
    tags: ["代码", "开发", "官方"],
  }),
  pluginView({
    slug: "mijia",
    name: "米家智能家居",
    nameEn: "Mijia",
    desc: "扫码绑定小米账号，查询与控制智能家居设备、场景。",
    long: "扫码登录小米米家账号后，将智能家居设备状态、能力、场景与设备控制开放给 AI（多租户共享 sidecar）。",
    category: "integrations-and-automation",
    transport: "http",
    auth: "mijia",
    tags: ["智能家居", "IoT", "小米"],
    tools: [
      { name: "get_home_overview", description: "获取家庭概览" },
      { name: "get_device_status", description: "查询设备状态" },
      { name: "control_by_intent", description: "按意图控制设备" },
      { name: "list_scenes", description: "列出场景" },
      { name: "execute_scene", description: "执行场景" },
      { name: "control_device", description: "控制单个设备" },
    ],
  }),
  pluginView({
    slug: "notion",
    name: "Notion",
    nameEn: "Notion",
    desc: "读写 Notion 页面、数据库与评论。",
    long: "通过自建 Notion MCP sidecar 读取与编辑 Notion 页面、数据库和评论。",
    category: "integrations-and-automation",
    transport: "http",
    auth: "apikey",
    tags: ["文档", "笔记", "协作"],
  }),
  pluginView({
    slug: "xhs",
    name: "小红书",
    nameEn: "Xiaohongshu",
    desc: "读取小红书 feed / 搜索 / 主页，发布笔记、评论、点赞、收藏。",
    long: "通过自建多租户 MCP sidecar 读取小红书 feed、搜索、用户主页，并可发布笔记、评论、点赞、收藏。使用每租户登录 Cookie 鉴权。",
    category: "social-and-content",
    transport: "http",
    auth: "cookie",
    tags: ["社交", "内容", "种草"],
  }),
  pluginView({
    slug: "z-ai",
    name: "智谱工具包",
    nameEn: "ZhipuAI Toolkit",
    desc: "智谱（GLM）官方：联网搜索、网页阅读、代码库分析、OCR、文件解析、图像生成、TTS。",
    long: "智谱 AI（GLM）官方工具包，暴露联网搜索、网页阅读、GitHub 代码库（ZRead）分析、OCR / 版面解析、文件解析、图像生成与语音合成等能力。",
    category: "search-and-retrieval",
    transport: "http",
    auth: "apikey",
    tags: ["智谱", "GLM", "搜索", "多模态"],
    tools: [
      { name: "webSearchPrime", description: "联网搜索" },
      { name: "webReader", description: "网页阅读" },
      { name: "get_repo_structure", description: "分析代码库结构" },
      { name: "ocr_image", description: "图片 OCR" },
      { name: "generate_image", description: "文生图" },
      { name: "text_to_speech", description: "语音合成" },
    ],
  }),
]

export const findMarketplacePlugin = (id: string) =>
  designMarketplacePlugins.find((p) => p.id === id || p.slug === id)

// ── installed builder + a few installed plugins with varied health ────────────
function installed(
  slug: string,
  o: {
    isEnabled: boolean
    status: "active" | "disabled" | "error" | "archived"
    configState: PluginInstallationDetailView["configState"]
  }
): PluginInstallationDetailView {
  const p = designMarketplacePlugins.find((x) => x.slug === slug)!
  return {
    id: `inst-${slug}`,
    workspaceId: WS,
    pluginId: p.id,
    lifecycleScope: "workspace",
    defaultReuseScope: "workspace",
    sourceDefaultConversationTypeMask: 0,
    workspaceConversationTypeMask: 0,
    conversationTypeMaskOverride: null,
    effectiveConversationTypeMask: 0,
    supportedReuseScopes: ["workspace", "conversation"],
    isEnabled: o.isEnabled,
    status: o.status,
    configData: {},
    configState: o.configState,
    approvedRuntimePermissions: ["network:outbound"],
    ownerWorkspaceMemberId: null,
    createdAt: CREATED,
    updatedAt: UPDATED,
    sourceCatalogItemId: null,
    sourceCatalogVersionId: null,
    sourceSyncMode: null,
    pluginSlug: p.slug,
    pluginDisplayName: p.displayName,
    pluginDescription: p.description,
    pluginDisplayNameI18n: p.displayNameI18n,
    pluginDescriptionI18n: p.descriptionI18n,
    pluginLongDescriptionI18n: p.longDescriptionI18n,
    pluginSummaryI18n: p.summaryI18n,
    defaultLocale: p.defaultLocale,
    transport: p.transport,
    pluginLifecycleScope: p.lifecycleScope,
    pluginDefaultReuseScope: p.defaultReuseScope,
    pluginSupportedReuseScopes: p.supportedReuseScopes,
    toolsManifest: p.toolsManifest,
    pluginCategories: p.categories,
    pluginCategorySlugs: p.categorySlugs,
    pluginVersion: p.version,
    configSchema: {},
    configFields: p.configFields,
    installFlow: p.installFlow,
    authBindings: p.authBindings,
    isBuiltin: true,
    pluginValidationRules: [],
    pluginSetupSteps: [],
    orgId: p.orgId,
    orgSlug: p.orgSlug,
    orgDisplayName: p.orgDisplayName,
    authorization: p.authorization,
    revision: { authorization: p.authorization },
  }
}

export const designInstalledPlugins: PluginInstallationDetailView[] = [
  // fully working: configured API key, enabled
  installed("github", {
    isEnabled: true,
    status: "active",
    configState: [
      {
        key: "apiKey",
        isConfigured: true,
        maskedValue: "ghp_••••4f2a",
        updatedAt: UPDATED,
      },
    ],
  }),
  // firecrawl: enabled + configured
  installed("firecrawl", {
    isEnabled: true,
    status: "active",
    configState: [
      {
        key: "apiKey",
        isConfigured: true,
        maskedValue: "fc-••••9b1c",
        updatedAt: UPDATED,
      },
    ],
  }),
  // feishu: connected via QR (auth_connection with account), enabled
  installed("feishu", {
    isEnabled: true,
    status: "active",
    configState: [
      {
        key: "connection",
        isConfigured: true,
        authConnectionId: "conn-feishu",
        accountDisplayName: "林墨 · 设计工作区",
        updatedAt: UPDATED,
      },
    ],
  }),
  // amap: installed but not configured yet → 需配置
  installed("amap", {
    isEnabled: true,
    status: "active",
    configState: [{ key: "apiKey", isConfigured: false }],
  }),
  // notion: disabled (kept, off)
  installed("notion", {
    isEnabled: false,
    status: "disabled",
    configState: [
      {
        key: "apiKey",
        isConfigured: true,
        maskedValue: "secret_••••7d3e",
        updatedAt: UPDATED,
      },
    ],
  }),
]

export const findInstalledPlugin = (id: string) =>
  designInstalledPlugins.find(
    (p) => p.id === id || p.pluginId === id || p.pluginSlug === id
  )
