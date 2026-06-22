import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

// Firecrawl hosted remote MCP. Authentication is api-key-in-URL-PATH: the
// plaintext `fc-` key is templated into the endpoint path (NOT a header, NOT a
// query param, NOT OAuth). This is the gitlab/amap "templated-URL" archetype
// with the secret in the path segment. There are intentionally NO authBindings
// (the closed 3-driver enum has no api-key driver); the key is a plain `secret`
// configField (github plaintext-secret model). The keyless OAuth/DCR endpoint
// (mcp.firecrawl.dev/v2/mcp) is deliberately NOT used (decision D2: avoid OAuth
// app registration). Overseas-only; env-gated in builtin-plugins/index.ts.
export const firecrawlSeed: BuiltinOrgSeed = {
  slug: "firecrawl",
  displayName: "Firecrawl",
  description:
    "Firecrawl hosted MCP for web scraping, crawling, mapping, search, and extraction.",
  plugins: [
    {
      slug: "remote-mcp",
      displayName: "Firecrawl Remote MCP",
      displayNameI18n: i18n("Firecrawl Remote MCP", "Firecrawl 远程 MCP"),
      description:
        "Web scrape, crawl, map, search, and extract; tools discovered live.",
      descriptionI18n: i18n(
        "Web scrape, crawl, map, search, and extract; tools discovered live.",
        "网页抓取、爬取、站点地图、搜索与抽取；工具实时下发。"
      ),
      longDescription:
        "Firecrawl hosted remote MCP. Your fc- API key is embedded in the MCP endpoint URL path.",
      longDescriptionI18n: i18n(
        "Firecrawl hosted remote MCP. Your fc- API key is embedded in the MCP endpoint URL path.",
        "Firecrawl 托管远程 MCP；你的 fc- API Key 嵌入 MCP 端点 URL path 中。"
      ),
      summaryI18n: i18n(
        "Web scrape/crawl/search/extract via Firecrawl hosted MCP.",
        "通过 Firecrawl 托管 MCP 抓取/爬取/搜索/抽取网页。"
      ),
      defaultLocale: "en",
      transport: "http",
      // api-key-in-PATH: renderTemplate does a raw string substitution on the
      // path (only query.key goes through searchParams.set), so the fc- key
      // interpolates cleanly. Missing config fails closed in the engine.
      entryPoint: JSON.stringify({
        url: "https://mcp.firecrawl.dev/${config:apiKey}/v2/mcp",
        protocol: "streamable-http",
      }),
      // Stateless read tools; reuse across the workspace (amap/aminer precedent).
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/firecrawl.svg",
      categorySlugs: ["search-and-retrieval", "documents-and-reading"],
      tags: [
        "firecrawl",
        "web",
        "scrape",
        "crawl",
        "search",
        "extract",
        "mcp",
        "http",
        "official",
      ],
      // Tools are discovered live from the upstream server; the manifest is a
      // fallback only. Firecrawl is effectively read-only (no write tools).
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            sensitive: true,
            description: "Firecrawl API key (fc-...)",
          },
        },
        required: ["apiKey"],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          required: true,
          secret: true,
          titleI18n: i18n("API Key", "API Key"),
          descriptionI18n: i18n(
            "Your Firecrawl fc- API key from firecrawl.dev.",
            "你的 Firecrawl fc- API Key，来自 firecrawl.dev。"
          ),
          placeholderI18n: i18n("fc-...", "fc-..."),
        },
      ],
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "Firecrawl API key is required.",
        },
        {
          field: "apiKey",
          rule: "prefix",
          value: "fc-",
          message: "Firecrawl key should start with fc-.",
        },
        {
          field: "apiKey",
          rule: "min_length",
          value: 10,
          message: "Firecrawl key looks too short.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure Firecrawl",
          description: "Paste your Firecrawl fc- API key.",
          scope: "plugin",
          fields: ["apiKey"],
          helpUrl: "https://docs.firecrawl.dev/mcp-server",
          helpText: "Open the Firecrawl MCP guide.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect Firecrawl", "连接 Firecrawl"),
            descriptionI18n: i18n(
              "Enter your Firecrawl fc- API key. It is embedded in the MCP endpoint URL.",
              "填写 Firecrawl fc- API Key，将嵌入 MCP 端点地址。"
            ),
            scope: "plugin",
            fields: ["apiKey"],
            helpUrl: "https://docs.firecrawl.dev/mcp-server",
            helpTextI18n: i18n(
              "Create an API key at firecrawl.dev.",
              "在 firecrawl.dev 创建 API Key。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the key and install.",
              "确认 Key 后安装。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      // NO authBindings (plaintext-secret model).
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "Firecrawl hosted MCP requires outbound network access to scrape and crawl external sites.",
      },
    },
  ],
}
