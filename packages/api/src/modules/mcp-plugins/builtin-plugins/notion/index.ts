import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

// Notion via a self-hosted MCP sidecar (MCP-PROXY, lifecycle="shared"). Each
// installation pastes its own INTERNAL integration token (ntn_…, legacy
// secret_…); the token is forwarded per request in the Notion-Token header and
// bound to that installation. The sidecar's generic MCP-proxy adapter injects
// the same token on the upstream MCP initialize, so the vendored Node backend
// (@notionhq/notion-mcp-server, pinned) authenticates each (tenant, token) on
// its own MCP session — true per-install isolation, no shared backend auth
// state. The OAuth-only hosted mcp.notion.com is deliberately NOT used
// (decision D2: avoid OAuth app registration). There are intentionally NO
// authBindings (github plaintext-secret model). Overseas-only; env-gated on
// NOTION_MCP_URL in builtin-plugins/index.ts.
export const notionSeed: BuiltinOrgSeed = {
  slug: "notion",
  displayName: "Notion",
  description:
    "Read and edit Notion pages, databases, and comments via a self-hosted Notion MCP sidecar.",
  plugins: [
    {
      slug: "notion-mcp",
      displayName: "Notion",
      displayNameI18n: i18n("Notion", "Notion"),
      description:
        "Read and edit Notion pages, databases, and comments via a self-hosted Notion MCP sidecar.",
      descriptionI18n: i18n(
        "Read and edit Notion pages, databases, and comments via a self-hosted Notion MCP sidecar.",
        "通过自托管的 Notion MCP sidecar 读取和编辑 Notion 页面、数据库与评论。"
      ),
      longDescription:
        "Connects Synapse to Notion through a self-hosted Notion MCP sidecar using an internal integration token (ntn_…). Each installation's token is forwarded per request and bound to that installation, so the integration only sees pages and databases you explicitly share with it. Tools are discovered live from the sidecar.",
      longDescriptionI18n: i18n(
        "Connects Synapse to Notion through a self-hosted Notion MCP sidecar using an internal integration token (ntn_…). Each installation's token is forwarded per request and bound to that installation, so the integration only sees pages and databases you explicitly share with it. Tools are discovered live from the sidecar.",
        "通过自托管的 Notion MCP sidecar 用内部集成令牌（ntn_…）把 Synapse 连接到 Notion。每个安装的令牌按请求转发并绑定到该安装，集成只能访问你显式共享给它的页面和数据库。工具列表由 sidecar 实时下发。"
      ),
      summaryI18n: i18n(
        "Notion pages, databases, and comments with an internal integration token.",
        "用内部集成令牌读写 Notion 页面、数据库与评论。"
      ),
      defaultLocale: "en",
      // Proxies the multi-tenant Notion MCP sidecar over Streamable HTTP. The
      // installation's integration token is forwarded in Notion-Token; the
      // installation id scopes per-install isolation in the sidecar;
      // X-Notion-Expose-Raw gates low-level tools. X-Notion-Expose-Raw is a
      // REQUIRED template (not ${config?:}) — it stays resolvable because
      // exposeRawTools has defaultConfig:false and the engine treats boolean
      // false as "present"; keep defaultConfig.exposeRawTools so a future field
      // removal cannot connect-break.
      transport: "http",
      entryPoint: JSON.stringify({
        url: "${env:NOTION_MCP_URL}",
        headers: {
          "Notion-Token": "${config:notionToken}",
          "X-Notion-Tenant": "${runtime:installationId}",
          "X-Notion-Expose-Raw": "${config:exposeRawTools}",
        },
      }),
      defaultReuseScope: "conversation",
      supportedReuseScopes: [
        "turn",
        "session",
        "conversation",
        "actor",
        "workspace",
      ],
      requiresHandshake: false,
      categorySlugs: ["integrations-and-automation", "documents-and-reading"],
      tags: [
        "notion",
        "docs",
        "database",
        "wiki",
        "mcp",
        "http",
        "sidecar",
        "automation",
      ],
      // Tools are discovered live from the sidecar on connect.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          notionToken: { type: "string", sensitive: true },
          exposeRawTools: { type: "boolean" },
        },
        required: ["notionToken"],
      },
      configFields: [
        {
          key: "notionToken",
          type: "secret",
          required: true,
          secret: true,
          titleI18n: i18n("Internal Integration Token", "内部集成令牌"),
          descriptionI18n: i18n(
            "Paste a Notion INTERNAL integration secret (starts with ntn_). Create one at notion.so/my-integrations, then SHARE each target page/database with the integration.",
            "粘贴 Notion 内部集成密钥（以 ntn_ 开头）。在 notion.so/my-integrations 创建，然后把目标页面/数据库共享给该集成。"
          ),
          placeholderI18n: i18n("ntn_…", "ntn_…"),
        },
        {
          key: "exposeRawTools",
          type: "boolean",
          defaultValue: false,
          titleI18n: i18n(
            "Expose Low-Level Notion API Tools",
            "暴露底层 Notion API 工具"
          ),
          descriptionI18n: i18n(
            "Also expose raw low-level Notion API tools alongside the curated ones.",
            "在精选工具之外，同时暴露底层原始 Notion API 工具。"
          ),
        },
      ],
      defaultConfig: { exposeRawTools: false },
      validationRules: [
        {
          field: "notionToken",
          rule: "required",
          message: "Notion integration token is required.",
        },
        {
          field: "notionToken",
          rule: "min_length",
          value: 20,
          message: "Notion token looks too short.",
        },
        {
          field: "notionToken",
          rule: "prefix",
          value: "ntn_",
          message:
            "Use an INTERNAL integration token (starts with ntn_). Legacy secret_ tokens also work — relax this rule if needed.",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Connect Notion",
          description:
            "Create an internal integration at notion.so/my-integrations, share your pages/databases with it, then paste the ntn_ token.",
          scope: "plugin",
          fields: ["notionToken", "exposeRawTools"],
          helpUrl: "https://www.notion.so/my-integrations",
          helpText: "Open Notion integrations.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect Notion", "连接 Notion"),
            descriptionI18n: i18n(
              "Create an internal integration, SHARE each target page/database with it, then paste the ntn_ token. Holding the token alone grants no access.",
              "创建内部集成，把每个目标页面/数据库共享给它，然后粘贴 ntn_ 令牌。仅持有令牌不授予任何访问权限。"
            ),
            scope: "plugin",
            fields: ["notionToken", "exposeRawTools"],
            helpUrl: "https://www.notion.so/my-integrations",
            helpTextI18n: i18n(
              "Create an internal integration at notion.so/my-integrations.",
              "在 notion.so/my-integrations 创建内部集成。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the token and install.",
              "确认令牌后安装。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      // NO authBindings (github plaintext-secret model).
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "Notion MCP requires outbound network access to api.notion.com via the Notion sidecar.",
      },
    },
  ],
}
