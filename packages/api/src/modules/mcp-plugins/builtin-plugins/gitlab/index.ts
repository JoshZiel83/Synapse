import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const gitlabSeed: BuiltinOrgSeed = {
  slug: "gitlab",
  displayName: "GitLab",
  description:
    "GitLab official MCP integration with optional GitLab API-backed automation event sources.",
  plugins: [
    {
      slug: "official-mcp",
      displayName: "GitLab Official MCP",
      description:
        "Connect to GitLab's official MCP endpoint and reuse the same token for GitLab project event sources.",
      longDescription:
        "Installs GitLab's official MCP endpoint over HTTP. The same GitLab token can also be reused to create project webhooks through the official GitLab API, so GitLab notes, merge requests, pipelines, and pushes can enter Synapse as automation event sources.",
      displayNameI18n: i18n("GitLab Official MCP", "GitLab 官方 MCP"),
      descriptionI18n: i18n(
        "Connect to GitLab's official MCP endpoint and reuse the same token for GitLab project event sources.",
        "连接 GitLab 官方 MCP Endpoint，并复用同一组 Token 创建 GitLab 项目事件源。"
      ),
      longDescriptionI18n: i18n(
        "Installs GitLab's official MCP endpoint over HTTP. The same GitLab token can also be reused to create project webhooks through the official GitLab API, so GitLab notes, merge requests, pipelines, and pushes can enter Synapse as automation event sources.",
        "通过 HTTP 安装 GitLab 官方 MCP Endpoint。同一组 GitLab Token 还可以通过 GitLab 官方 API 创建项目 webhook，让 Note、Merge Request、Pipeline 和 Push 事件进入 Synapse 自动化系统。"
      ),
      summaryI18n: i18n(
        "Official GitLab MCP plus GitLab API-backed event sources.",
        "官方 GitLab MCP，加上 GitLab API 驱动的事件源。"
      ),
      defaultLocale: "en",
      transport: "http",
      // Explicit Authorization header (the global apiKey→Bearer fallback was
      // removed when the remote client became transport-pure).
      entryPoint:
        '{"url":"${config:baseUrl}/api/v4/mcp","headers":{"Authorization":"Bearer ${config:apiKey}"}}',
      defaultAttachmentScope: "workspace",
      defaultReuseScope: "conversation",
      requiresHandshake: false,
      categorySlugs: ["integrations-and-automation"],
      iconAssetPath: "assets/icons/gitlab.svg",
      tags: [
        "gitlab",
        "official",
        "mcp",
        "http",
        "merge-request",
        "pipeline",
        "notes",
        "automation",
      ],
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          apiKey: { type: "string", sensitive: true },
          baseUrl: { type: "string" },
        },
        required: ["apiKey"],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: i18n("Personal Access Token", "个人访问令牌"),
          descriptionI18n: i18n(
            "Provide a GitLab token that can access the projects you want to use in MCP and automation.",
            "填写可访问目标项目的 GitLab Token，用于 MCP 与自动化事件源。"
          ),
          required: true,
          secret: true,
        },
        {
          key: "baseUrl",
          type: "text",
          titleI18n: i18n("GitLab Base URL", "GitLab 地址"),
          descriptionI18n: i18n(
            "Override the GitLab instance base URL when using a self-managed instance.",
            "如果你使用自建 GitLab，可覆盖实例基础地址。"
          ),
          defaultValue: "https://gitlab.com",
        },
      ],
      defaultConfig: {
        baseUrl: "https://gitlab.com",
      },
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "GitLab token is required.",
        },
        {
          field: "apiKey",
          rule: "min_length",
          value: 20,
          message: "GitLab token looks too short.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure GitLab",
          description:
            "Paste a GitLab token that can access the projects you need.",
          scope: "plugin",
          fields: ["apiKey", "baseUrl"],
          helpUrl:
            "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/",
          helpText: "Open the GitLab MCP setup guide.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect GitLab", "连接 GitLab"),
            descriptionI18n: i18n(
              "Configure the GitLab token used by the official MCP endpoint and GitLab event sources.",
              "配置 GitLab Token。该凭证会同时用于官方 MCP 和 GitLab 事件源。"
            ),
            scope: "plugin",
            fields: ["apiKey", "baseUrl"],
            helpUrl:
              "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/",
            helpTextI18n: i18n(
              "Open the GitLab MCP setup guide.",
              "查看 GitLab MCP 配置文档。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and install", "确认并安装"),
            descriptionI18n: i18n(
              "Install the GitLab MCP plugin, then optionally create GitLab event sources.",
              "安装 GitLab MCP 插件，然后按需创建 GitLab 事件源。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "GitLab official MCP and GitLab webhook management require outbound network access.",
      },
    },
  ],
}
