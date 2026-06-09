import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const githubSeed: BuiltinOrgSeed = {
  slug: "github",
  displayName: "GitHub",
  description:
    "GitHub official MCP integration with optional GitHub API-backed automation event sources.",
  plugins: [
    {
      slug: "official-mcp",
      displayName: "GitHub Official MCP",
      description:
        "Connect to GitHub's official MCP server and reuse the same credentials for GitHub repository event sources.",
      longDescription:
        "Installs GitHub's official MCP server over HTTP. The same GitHub token can also be reused to register repository webhooks through the official GitHub API, so GitHub comments, pull requests, workflow runs, and pushes can enter Synapse as automation event sources.",
      displayNameI18n: i18n("GitHub Official MCP", "GitHub 官方 MCP"),
      descriptionI18n: i18n(
        "Connect to GitHub's official MCP server and reuse the same credentials for GitHub repository event sources.",
        "连接 GitHub 官方 MCP Server，并复用同一组凭证创建 GitHub 仓库事件源。"
      ),
      longDescriptionI18n: i18n(
        "Installs GitHub's official MCP server over HTTP. The same GitHub token can also be reused to register repository webhooks through the official GitHub API, so GitHub comments, pull requests, workflow runs, and pushes can enter Synapse as automation event sources.",
        "通过 HTTP 安装 GitHub 官方 MCP Server。同一组 GitHub Token 还可以通过 GitHub 官方 API 注册仓库 webhook，让评论、PR、Review、Workflow Run 和 Push 事件进入 Synapse 自动化系统。"
      ),
      summaryI18n: i18n(
        "Official GitHub MCP plus GitHub API-backed event sources.",
        "官方 GitHub MCP，加上 GitHub API 驱动的事件源。"
      ),
      defaultLocale: "en",
      transport: "http",
      // Explicit Authorization header (the global apiKey→Bearer fallback was
      // removed when the remote client became transport-pure).
      entryPoint: JSON.stringify({
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${config:apiKey}" },
      }),
      defaultReuseScope: "conversation",
      requiresHandshake: false,
      categorySlugs: ["integrations-and-automation"],
      iconAssetPath: "assets/icons/github.svg",
      tags: [
        "github",
        "official",
        "mcp",
        "http",
        "pull-request",
        "issues",
        "workflow",
        "automation",
      ],
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          apiKey: { type: "string", sensitive: true },
          apiBaseUrl: { type: "string" },
        },
        required: ["apiKey"],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: i18n("Personal Access Token", "个人访问令牌"),
          descriptionI18n: i18n(
            "Provide a GitHub token that can access the repositories you want to use in MCP and automation.",
            "填写可访问目标仓库的 GitHub Token，用于 MCP 与自动化事件源。"
          ),
          required: true,
          secret: true,
        },
        {
          key: "apiBaseUrl",
          type: "text",
          titleI18n: i18n("GitHub API Base URL", "GitHub API 地址"),
          descriptionI18n: i18n(
            "Override the GitHub REST API base URL if you are using GitHub Enterprise.",
            "如果你使用 GitHub Enterprise，可覆盖 GitHub REST API 基础地址。"
          ),
          defaultValue: "https://api.github.com",
        },
      ],
      defaultConfig: {
        apiBaseUrl: "https://api.github.com",
      },
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "GitHub token is required.",
        },
        {
          field: "apiKey",
          rule: "min_length",
          value: 20,
          message: "GitHub token looks too short.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure GitHub",
          description:
            "Paste a GitHub token that can access the repositories you need.",
          scope: "plugin",
          fields: ["apiKey", "apiBaseUrl"],
          helpUrl:
            "https://docs.github.com/en/copilot/how-tos/context/model-context-protocol/using-the-github-mcp-server",
          helpText: "Open the GitHub MCP setup guide.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect GitHub", "连接 GitHub"),
            descriptionI18n: i18n(
              "Configure the GitHub token used by the official MCP server and GitHub event sources.",
              "配置 GitHub Token。该凭证会同时用于官方 MCP 和 GitHub 事件源。"
            ),
            scope: "plugin",
            fields: ["apiKey", "apiBaseUrl"],
            helpUrl:
              "https://docs.github.com/en/copilot/how-tos/context/model-context-protocol/using-the-github-mcp-server",
            helpTextI18n: i18n(
              "Open the GitHub MCP setup guide.",
              "查看 GitHub MCP 配置文档。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and install", "确认并安装"),
            descriptionI18n: i18n(
              "Install the GitHub MCP plugin, then optionally create GitHub event sources.",
              "安装 GitHub MCP 插件，然后按需创建 GitHub 事件源。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "GitHub official MCP and GitHub webhook management require outbound network access.",
      },
    },
  ],
}
