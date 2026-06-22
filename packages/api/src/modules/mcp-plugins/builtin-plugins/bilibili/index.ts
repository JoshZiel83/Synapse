import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

// 哔哩哔哩 (Bilibili) read + write via a SELF-HOSTED multi-tenant MCP sidecar.
// The sidecar is the shared `_mcp_base` Streamable-HTTP front end plus a LIB-WRAP
// adapter over the upstream `Nemo2011/bilibili-api` Python library (GPL-3.0,
// accepted as an arms-length independent sidecar process — F2). Per-(tenant,
// cookie) isolation is real: the adapter builds a fresh per-instance Credential
// from the connected account's web Cookie, attached per call. The Cookie is a
// per-install secret; the sidecar URL is env-gated. There are intentionally NO
// authBindings (Bilibili has no public OAuth/api-key; the closed 3-driver enum
// has no cookie driver) — the Cookie is a plain `secret` config field (github
// plaintext-secret model). Write tools (comment/danmaku/dynamic) are gated
// server-side by X-Bili-Expose-Write (default off; ToS-grey + rate-limited).
export const bilibiliSeed: BuiltinOrgSeed = {
  slug: "bilibili",
  displayName: "哔哩哔哩",
  description:
    "Bilibili read + write via a self-hosted MCP sidecar wrapping bilibili-api (cookie auth, per-tenant account).",
  plugins: [
    {
      slug: "bilibili-mcp",
      displayName: "Bilibili MCP",
      displayNameI18n: i18n("Bilibili MCP", "哔哩哔哩 MCP"),
      description:
        "Read Bilibili video/search/comment/user data and (opt-in) comment, send danmaku, and post dynamics via a self-hosted MCP sidecar.",
      descriptionI18n: i18n(
        "Read Bilibili video/search/comment/user data and (opt-in) comment, send danmaku, and post dynamics via a self-hosted MCP sidecar.",
        "通过自托管 MCP sidecar 读取哔哩哔哩视频/搜索/评论/用户数据，并（可选开启）评论、发送弹幕、发布动态。"
      ),
      longDescription:
        "Self-hosted Bilibili MCP sidecar wrapping the bilibili-api library. Each install connects its own account via a web Cookie (SESSDATA + bili_jct). Write tools are opt-in and per-account rate-limited; automated interaction is ToS-grey and carries account-risk-control exposure.",
      longDescriptionI18n: i18n(
        "Self-hosted Bilibili MCP sidecar wrapping the bilibili-api library. Each install connects its own account via a web Cookie (SESSDATA + bili_jct). Write tools are opt-in and per-account rate-limited; automated interaction is ToS-grey and carries account-risk-control exposure.",
        "自托管哔哩哔哩 MCP sidecar，封装 bilibili-api 库。每个安装通过 web Cookie（SESSDATA + bili_jct）连接独立账号。写工具默认关闭、按账号限速；自动化交互属 ToS 灰色地带，存在账号风控风险。"
      ),
      summaryI18n: i18n(
        "Bilibili read + write via a self-hosted MCP sidecar (cookie auth, per-tenant account).",
        "通过自托管 MCP sidecar 读写哔哩哔哩（Cookie 认证，每租户独立账号）。"
      ),
      defaultLocale: "zh-CN",
      transport: "http",
      // The sidecar URL is env-gated; the cookie and per-install tenant id are
      // forwarded as headers. X-Bili-Cookie carries the raw web Cookie (SESSDATA
      // + bili_jct + buvid3); X-Bili-Tenant=installationId is the per-tenant
      // routing + isolation key; X-Bili-Expose-Write gates the write tools.
      // `${config:exposeWriteTools}` resolves a boolean `false` as "present"
      // (not missing), so the required-template check does not fail closed.
      entryPoint: JSON.stringify({
        url: "${env:BILIBILI_MCP_URL}",
        headers: {
          "X-Bili-Cookie": "${config:cookie}",
          "X-Bili-Tenant": "${runtime:installationId}",
          "X-Bili-Expose-Write": "${config:exposeWriteTools}",
        },
      }),
      defaultReuseScope: "session",
      supportedReuseScopes: [
        "turn",
        "session",
        "conversation",
        "actor",
        "workspace",
      ],
      requiresHandshake: false,
      iconAssetPath: "assets/icons/bilibili.svg",
      categorySlugs: ["social-and-content"],
      tags: [
        "bilibili",
        "bili",
        "video",
        "social",
        "content",
        "danmaku",
        "sidecar",
        "mcp",
        "cookie",
      ],
      // Tools are discovered live from the sidecar; the manifest is a fallback
      // only. Write tools are gated server-side by X-Bili-Expose-Write.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          cookie: { type: "string", sensitive: true },
          accountLabel: { type: "string" },
          exposeWriteTools: { type: "boolean" },
        },
        required: ["cookie"],
      },
      configFields: [
        {
          key: "cookie",
          type: "secret",
          required: true,
          secret: true,
          titleI18n: i18n("Web Session Cookie", "Web 会话 Cookie"),
          descriptionI18n: i18n(
            "Paste your logged-in Bilibili web Cookie (must include SESSDATA and bili_jct). This deployment runs a per-tenant account.",
            "粘贴已登录的哔哩哔哩 web Cookie（需包含 SESSDATA 与 bili_jct）。本部署为每租户独立账号。"
          ),
          placeholderI18n: i18n(
            "SESSDATA=...; bili_jct=...; buvid3=...",
            "SESSDATA=...; bili_jct=...; buvid3=..."
          ),
        },
        {
          key: "accountLabel",
          type: "text",
          titleI18n: i18n("Account Label", "账号标签"),
          descriptionI18n: i18n(
            "A name to identify this account for auditing and rate-bucketing.",
            "用于审计与限速分桶标识该账号的名称。"
          ),
        },
        {
          key: "exposeWriteTools",
          type: "boolean",
          defaultValue: false,
          titleI18n: i18n("Expose Write Tools", "暴露写工具"),
          descriptionI18n: i18n(
            "Enable comment / danmaku / dynamic-post tools (default off; per-account rate-limited; carries account-risk-control exposure).",
            "启用评论 / 弹幕 / 发布动态工具（默认关闭；按账号限速；存在账号风控风险）。"
          ),
        },
      ],
      // Required: the X-Bili-Expose-Write header template references
      // `${config:exposeWriteTools}`, which must resolve (boolean false counts as
      // present) — otherwise the engine fails the install closed.
      defaultConfig: { exposeWriteTools: false },
      validationRules: [
        {
          field: "cookie",
          rule: "required",
          message: "Bilibili cookie is required.",
        },
        {
          field: "cookie",
          rule: "min_length",
          value: 20,
          message: "Cookie looks too short — include SESSDATA and bili_jct.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure Bilibili",
          description:
            "Paste your logged-in Bilibili web Cookie and choose whether to enable write tools.",
          scope: "plugin",
          fields: ["cookie", "accountLabel", "exposeWriteTools"],
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect Bilibili", "连接哔哩哔哩"),
            descriptionI18n: i18n(
              "Paste your logged-in Bilibili web Cookie (SESSDATA + bili_jct). This install runs its own account; write tools stay off unless enabled, and automated interaction carries account-risk-control exposure.",
              "粘贴已登录的哔哩哔哩 web Cookie（SESSDATA + bili_jct）。本安装拥有独立账号；除非启用，写工具保持关闭，自动化交互存在账号风控风险。"
            ),
            scope: "plugin",
            fields: ["cookie", "accountLabel", "exposeWriteTools"],
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the account and install. Write tools stay disabled unless you enabled them above.",
              "确认账号后安装。除非已在上方启用，写工具保持禁用。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      // NO authBindings (plaintext cookie-secret model; platform has no OAuth).
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "Bilibili MCP sidecar requires outbound network access to Bilibili on behalf of the connected account.",
      },
    },
  ],
}
