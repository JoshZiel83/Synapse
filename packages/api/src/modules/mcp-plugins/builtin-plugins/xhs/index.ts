import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

// 小红书 (Xiaohongshu / RedNote) read + write via a SELF-HOSTED multi-tenant MCP
// sidecar. The sidecar is the shared `_mcp_base` Streamable-HTTP front end plus
// the generic MCP-PROXY adapter in lifecycle="per_tenant" mode: it orchestrates
// a per-(tenant,cookie) pool of UNMODIFIED vendored Go xpzouying/xiaohongshu-mcp
// backends bound loopback-only (one logged-in account per backend). Cookie is a
// per-install secret; the sidecar URL is env-gated. There are intentionally NO
// authBindings (Xiaohongshu has no public OAuth/API key; the closed 3-driver
// enum has no cookie/api-key driver) — the cookie is a plain `secret` config
// field (github plaintext-secret model). 大陆-facing; ToS-grey + account-ban
// risk; env-gated (MCP_ENABLE_XHS && XHS_MCP_URL) in builtin-plugins/index.ts.
export const xhsSeed: BuiltinOrgSeed = {
  slug: "xiaohongshu",
  displayName: "小红书",
  description:
    "Xiaohongshu read + write via a self-hosted multi-tenant MCP sidecar (per-tenant accounts, cookie auth).",
  plugins: [
    {
      slug: "xhs-mcp",
      displayName: "Xiaohongshu MCP",
      displayNameI18n: i18n("Xiaohongshu MCP", "小红书 MCP"),
      description:
        "Read Xiaohongshu feeds/search/profiles and publish notes, comment, like, and favorite via a self-hosted MCP sidecar.",
      descriptionI18n: i18n(
        "Read Xiaohongshu feeds/search/profiles and publish notes, comment, like, and favorite via a self-hosted multi-tenant MCP sidecar (per-tenant accounts).",
        "通过自托管多租户 MCP sidecar（每租户独立账号）读取小红书信息流/搜索/主页，并发布笔记、评论、点赞、收藏。"
      ),
      longDescription:
        "Self-hosted Xiaohongshu MCP sidecar. Each install gets its own logged-in account; a per-(tenant,cookie) backend process is spawned inside one shared container. Publishing/commenting is ToS-grey and carries account-ban risk; all pool backends share the container egress IP.",
      longDescriptionI18n: i18n(
        "Self-hosted Xiaohongshu MCP sidecar. Each install gets its own logged-in account; a per-(tenant,cookie) backend process is spawned inside one shared container. Publishing/commenting is ToS-grey and carries account-ban risk; all pool backends share the container egress IP.",
        "自托管小红书 MCP sidecar。每个安装拥有独立的已登录账号，在同一共享容器内按 (租户, Cookie) 拉起独立后端进程。发布/评论属 ToS 灰色地带，存在账号封禁风险；所有池后端共享容器出口 IP。"
      ),
      summaryI18n: i18n(
        "Xiaohongshu read + write via a self-hosted MCP sidecar (cookie auth, per-tenant account).",
        "通过自托管 MCP sidecar 读写小红书（Cookie 认证，每租户独立账号）。"
      ),
      defaultLocale: "zh-CN",
      transport: "http",
      // The sidecar URL is env-gated; the cookie and per-install tenant id are
      // forwarded as headers. X-Xhs-Cookie carries the raw web Cookie (a1 +
      // web_session); X-Xhs-Tenant=installationId is the per-tenant routing +
      // isolation key; X-Xhs-Expose-Write gates the write tools (default off).
      // `${config:exposeWriteTools}` resolves a boolean `false` as "present"
      // (not missing), so the required-template check does not fail closed.
      entryPoint: JSON.stringify({
        url: "${env:XHS_MCP_URL}",
        headers: {
          "X-Xhs-Cookie": "${config:cookie}",
          "X-Xhs-Tenant": "${runtime:installationId}",
          "X-Xhs-Expose-Write": "${config:exposeWriteTools}",
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
      iconAssetPath: "assets/icons/xiaohongshu.svg",
      categorySlugs: ["social-and-content"],
      tags: [
        "xiaohongshu",
        "xhs",
        "rednote",
        "social",
        "content",
        "note",
        "sidecar",
        "mcp",
        "cookie",
      ],
      // Tools are discovered live from the upstream backend; the manifest is a
      // fallback only. Write tools are gated server-side by X-Xhs-Expose-Write.
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
            "Paste your logged-in Xiaohongshu web Cookie (a1 + web_session). This deployment runs a per-tenant account; publishing/commenting carries account-ban risk.",
            "粘贴已登录的小红书 web Cookie（a1 + web_session）。本部署为每租户独立账号；发布/评论存在账号封禁风险。"
          ),
          placeholderI18n: i18n(
            "a1=...; web_session=...",
            "a1=...; web_session=..."
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
            "Enable publishing/commenting/like/favorite tools (default off; carries account-ban risk).",
            "启用发布/评论/点赞/收藏工具（默认关闭；存在封号风险）。"
          ),
        },
      ],
      // Required: the X-Xhs-Expose-Write header template references
      // `${config:exposeWriteTools}`, which must resolve (boolean false counts
      // as present) — otherwise the engine fails the install closed.
      defaultConfig: { exposeWriteTools: false },
      validationRules: [
        {
          field: "cookie",
          rule: "required",
          message: "Xiaohongshu cookie is required.",
        },
        {
          field: "cookie",
          rule: "min_length",
          value: 20,
          message: "Cookie looks too short — include a1 and web_session.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure Xiaohongshu",
          description:
            "Paste your logged-in Xiaohongshu web Cookie and choose whether to enable write tools.",
          scope: "plugin",
          fields: ["cookie", "accountLabel", "exposeWriteTools"],
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect Xiaohongshu", "连接小红书"),
            descriptionI18n: i18n(
              "Paste your logged-in Xiaohongshu web Cookie. This install runs its own per-tenant account; publishing/commenting carries account-ban risk, and all accounts in this deployment share one egress IP (≈3 accounts/IP risk-control cap).",
              "粘贴已登录的小红书 web Cookie。本安装拥有独立账号；发布/评论存在账号封禁风险，且本部署所有账号共享同一出口 IP（约 3 账号/IP 风控上限）。"
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
          "Xiaohongshu MCP sidecar requires outbound network access to Xiaohongshu on behalf of the connected account.",
      },
    },
  ],
}
