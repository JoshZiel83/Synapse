import type { BuiltinOrgSeed } from "../types.js";
import { aminerToolDefinitions } from "../../builtin/aminer/openapi/tool-specs.js";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });

export const aminerSeed: BuiltinOrgSeed = {
  slug: "aminer",
  displayName: "AMiner",
  description: "AMiner academic research toolkit for scholar, paper, patent, organization, venue, and deep research workflows.",
  plugins: [
    {
      slug: "openapi",
      displayName: "AMiner Open Platform",
      displayNameI18n: i18n("AMiner Open Platform", "AMiner 开放平台"),
      description: "Official-style AMiner academic data toolkit wrapped as a builtin MCP plugin for scholar, paper, organization, venue, patent, and deep research workflows.",
      descriptionI18n: i18n(
        "Official-style AMiner academic data toolkit wrapped as a builtin MCP plugin for scholar, paper, organization, venue, patent, and deep research workflows.",
        "把 AMiner 学术数据能力包装成内置 MCP 插件，覆盖学者、论文、机构、期刊、专利和深度研究工作流。",
      ),
      longDescription:
        "This builtin plugin wraps AMiner Open Platform endpoints into MCP tools with cleaner input schemas, better parameter descriptions, and human-readable output formatting. It supports scholar lookup, paper search, academic QA search, organization and venue discovery, patent search, and AMiner deep research.",
      longDescriptionI18n: i18n(
        "This builtin plugin wraps AMiner Open Platform endpoints into MCP tools with cleaner input schemas, better parameter descriptions, and human-readable output formatting. It supports scholar lookup, paper search, academic QA search, organization and venue discovery, patent search, and AMiner deep research.",
        "该插件把 AMiner 开放平台接口封装成 MCP 工具，提供更干净的输入定义、更清晰的参数说明和更可读的输出格式，支持学者查询、论文搜索、学术问答、机构/期刊发现、专利搜索和 AMiner 沉思。",
      ),
      summaryI18n: i18n(
        "Academic search and research toolkit powered by AMiner.",
        "由 AMiner 提供的学术检索与研究工具包。",
      ),
      defaultLocale: "zh-CN",
      transport: "builtin",
      entryPoint: "aminer/openapi",
      defaultInstanceScope: "workspace",
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      categorySlugs: [
        "search-and-retrieval",
        "documents-and-reading",
      ],
      tags: [
        "aminer",
        "academic",
        "research",
        "papers",
        "scholars",
        "organizations",
        "venues",
        "patents",
        "builtin",
      ],
      toolsManifest: aminerToolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            sensitive: true,
            description: "AMiner API key used to sign JWT tokens.",
          },
          userId: {
            type: "string",
            description: "AMiner user ID embedded into the signed JWT payload.",
          },
          apiToken: {
            type: "string",
            sensitive: true,
            description: "Optional prebuilt AMiner JWT token. Prefer apiKey + userId for automatic token generation.",
          },
          tokenTtlSeconds: {
            type: "integer",
            description: "JWT lifetime in seconds when auto-signing tokens with apiKey + userId.",
          },
          timeoutMs: {
            type: "integer",
            description: "Optional request timeout in milliseconds.",
          },
        },
        anyOf: [
          {
            required: ["apiKey", "userId"],
          },
          {
            required: ["apiToken"],
          },
        ],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: i18n("API Key", "API Key"),
          descriptionI18n: i18n(
            "Your AMiner API key. The plugin will sign short-lived JWT tokens automatically.",
            "你的 AMiner API Key。插件会自动签发短期 JWT token。",
          ),
          placeholderI18n: i18n(
            "Paste your AMiner API key",
            "粘贴你的 AMiner API Key",
          ),
          secret: true,
        },
        {
          key: "userId",
          type: "text",
          titleI18n: i18n("User ID", "用户 ID"),
          descriptionI18n: i18n(
            "Your AMiner user ID used in the JWT payload.",
            "你的 AMiner 用户 ID，会写入 JWT payload。",
          ),
          placeholderI18n: i18n(
            "Paste your AMiner user ID",
            "粘贴你的 AMiner 用户 ID",
          ),
        },
        {
          key: "apiToken",
          type: "secret",
          titleI18n: i18n("JWT Token", "JWT Token"),
          descriptionI18n: i18n(
            "Optional fallback: paste a prebuilt AMiner JWT token directly.",
            "可选兜底项：直接粘贴已经生成好的 AMiner JWT token。",
          ),
          placeholderI18n: i18n(
            "Paste a prebuilt JWT token",
            "粘贴已生成的 JWT token",
          ),
          secret: true,
        },
        {
          key: "tokenTtlSeconds",
          type: "number",
          titleI18n: i18n("JWT TTL (s)", "JWT 有效期（秒）"),
          descriptionI18n: i18n(
            "Lifetime for auto-generated JWT tokens. Default is 7200 seconds.",
            "自动生成 JWT token 的有效期，默认 7200 秒。",
          ),
          defaultValue: 7200,
        },
        {
          key: "timeoutMs",
          type: "number",
          titleI18n: i18n("Timeout (ms)", "超时时间（毫秒）"),
          descriptionI18n: i18n(
            "Optional request timeout. Leave empty to use the 60 second default.",
            "可选请求超时时间。留空时默认 60 秒。",
          ),
        },
      ],
      defaultConfig: {
        tokenTtlSeconds: 7200,
        timeoutMs: 60000,
      },
      validationRules: [
        { field: "apiKey", rule: "min_length", value: 8, message: "AMiner API key looks too short" },
        { field: "userId", rule: "min_length", value: 4, message: "AMiner user ID looks too short" },
        { field: "apiToken", rule: "min_length", value: 20, message: "AMiner JWT token looks too short" },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure AMiner Credentials",
          description: "Prefer API key + user ID so the plugin can sign JWT tokens automatically. A prebuilt JWT token also works as a fallback.",
          scope: "plugin",
          fields: ["apiKey", "userId", "apiToken"],
          helpUrl: "https://datacenter.aminer.cn/",
          helpText: "Use your AMiner API key and user ID from the AMiner console, or paste a prebuilt JWT token.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect AMiner", "连接 AMiner"),
            descriptionI18n: i18n(
              "Prefer API key + user ID for automatic JWT signing. You can also paste a prebuilt JWT token.",
              "推荐填写 API Key + 用户 ID，让插件自动签 JWT；也可以直接粘贴已生成的 JWT token。",
            ),
            scope: "plugin",
            fields: ["apiKey", "userId", "apiToken", "tokenTtlSeconds", "timeoutMs"],
            helpUrl: "https://datacenter.aminer.cn/",
            helpTextI18n: i18n(
              "Use your AMiner API key and user ID from the AMiner console, or paste a JWT token generated from them.",
              "使用控制台里的 AMiner API Key 和用户 ID，或直接粘贴基于它们生成的 JWT token。",
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the configured token and install the plugin.",
              "确认 token 配置后安装插件。",
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        defaultGrantScope: "workspace",
        reason: "AMiner Open Platform requires outbound network access to call AMiner academic data APIs.",
      },
    },
  ],
};
