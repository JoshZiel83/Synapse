import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const aminerSeed: BuiltinOrgSeed = {
  slug: "aminer",
  displayName: "AMiner",
  description:
    "AMiner official MCP server for scholar, paper, patent, organization, and venue search.",
  plugins: [
    {
      slug: "openapi",
      displayName: "AMiner Open Platform",
      displayNameI18n: i18n("AMiner Open Platform", "AMiner 开放平台"),
      description:
        "Connect to AMiner's official MCP server for academic data. Tools are discovered live from AMiner.",
      descriptionI18n: i18n(
        "Connect to AMiner's official MCP server for academic data. Tools are discovered live from AMiner.",
        "连接 AMiner 官方 MCP 服务获取学术数据。工具列表由 AMiner 实时下发。"
      ),
      longDescription:
        "This plugin proxies AMiner's official hosted MCP server (https://mcp.aminer.cn/sse) over the legacy SSE transport. It covers scholar, paper, patent, organization, and venue search plus detail and relation lookups. Tools and their schemas are discovered live from AMiner.",
      longDescriptionI18n: i18n(
        "This plugin proxies AMiner's official hosted MCP server (https://mcp.aminer.cn/sse) over the legacy SSE transport. It covers scholar, paper, patent, organization, and venue search plus detail and relation lookups. Tools and their schemas are discovered live from AMiner.",
        "该插件通过 SSE 传输代理 AMiner 官方托管 MCP 服务（https://mcp.aminer.cn/sse），覆盖学者、论文、专利、机构、期刊检索以及详情与关系查询。工具及其参数结构由 AMiner 实时下发。"
      ),
      summaryI18n: i18n(
        "Academic search powered by AMiner's official MCP.",
        "由 AMiner 官方 MCP 提供的学术检索工具包。"
      ),
      defaultLocale: "zh-CN",
      transport: "sse",
      // Legacy SSE transport (AMiner's /mcp Streamable-HTTP path 404s). The
      // platform token is sent as a Bearer header and forwarded upstream.
      entryPoint: JSON.stringify({
        url: "https://mcp.aminer.cn/sse",
        headers: { Authorization: "Bearer ${config:apiKey}" },
      }),
      defaultInstanceScope: "workspace",
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/aminer.svg",
      categorySlugs: ["search-and-retrieval", "documents-and-reading"],
      tags: [
        "aminer",
        "academic",
        "research",
        "papers",
        "scholars",
        "patents",
        "official",
        "mcp",
      ],
      // Tools are discovered live from the remote server on connect.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            sensitive: true,
            description:
              "AMiner platform token (from the AMiner open-platform console).",
          },
        },
        required: ["apiKey"],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: i18n("Platform Token", "平台 Token"),
          descriptionI18n: i18n(
            "Your AMiner platform token. Generate it in the AMiner open-platform console.",
            "你的 AMiner 平台 Token，请在 AMiner 开放平台控制台生成。"
          ),
          placeholderI18n: i18n(
            "Paste your AMiner platform token",
            "粘贴你的 AMiner 平台 Token"
          ),
          required: true,
          secret: true,
        },
      ],
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "AMiner platform token is required.",
        },
        {
          field: "apiKey",
          rule: "min_length",
          value: 8,
          message: "AMiner platform token looks too short",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure AMiner Token",
          description:
            "Add your AMiner platform token. It is forwarded to AMiner's official MCP server.",
          scope: "plugin",
          fields: ["apiKey"],
          helpUrl: "https://open.aminer.cn/open/board?tab=control",
          helpText: "Generate a platform token in the AMiner console.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect AMiner", "连接 AMiner"),
            descriptionI18n: i18n(
              "Enter your AMiner platform token. It is forwarded to AMiner's official MCP server.",
              "填写 AMiner 平台 Token，将转发给 AMiner 官方 MCP 服务。"
            ),
            scope: "plugin",
            fields: ["apiKey"],
            helpUrl: "https://open.aminer.cn/open/board?tab=control",
            helpTextI18n: i18n(
              "Generate a platform token in the AMiner open-platform console.",
              "在 AMiner 开放平台控制台生成平台 Token。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the configured token and install the plugin.",
              "确认 Token 配置后安装插件。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "AMiner official MCP server requires outbound network access to call AMiner academic data APIs.",
      },
    },
  ],
}
