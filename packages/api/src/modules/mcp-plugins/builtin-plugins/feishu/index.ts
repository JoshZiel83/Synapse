import path from "path";
import { createRequire } from "module";
import type { BuiltinOrgSeed } from "../types.js";
import { buildFeishuToolRuntime } from "../../builtin/feishu/openapi/runtime.js";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });
const require = createRequire(import.meta.url);

const defaultConfig = {
  language: "zh",
  tools: "preset.default",
};

const toolsManifest = buildFeishuToolRuntime(defaultConfig).toolsManifest;
const larkMcpPackageRoot = path.dirname(
  require.resolve("@larksuiteoapi/lark-mcp/package.json"),
);
const feishuStdioEntryPoint = JSON.stringify({
  command: "${node}",
  args: [
    path.join(larkMcpPackageRoot, "dist/cli.js"),
    "mcp",
    "--mode",
    "stdio",
    "--tool-name-case",
    "dot",
    "--token-mode",
    "user_access_token",
    "--language",
    "${config:language}",
  ],
  env: {
    APP_ID: "${env:FEISHU_MCP_APP_ID}",
    APP_SECRET: "${env:FEISHU_MCP_APP_SECRET}",
    USER_ACCESS_TOKEN: "${config:feishuAccount.accessToken}",
    LARK_TOOLS: "${config:tools}",
  },
});

export const feishuSeed: BuiltinOrgSeed = {
  slug: "feishu",
  displayName: "Feishu",
  description: "Feishu official MCP integration powered by the official Lark OpenAPI MCP toolkit.",
  plugins: [
    {
      slug: "openapi",
      displayName: "Feishu Official MCP",
      description: "Official Feishu OpenAPI MCP with one-click OAuth sign-in for user-scoped access.",
      longDescription:
        "Connect Synapse to Feishu using the official Lark OpenAPI MCP toolkit. Users authorize their own Feishu account with one click, while the platform-managed app credentials stay server-side in environment variables. The default toolset covers IM, docs, wiki, contacts, and Bitable workflows supported by the official MCP package.",
      displayNameI18n: i18n("Feishu Official MCP", "飞书官方 MCP"),
      descriptionI18n: i18n(
        "Official Feishu OpenAPI MCP with one-click OAuth sign-in for user-scoped access.",
        "基于官方 Feishu OpenAPI MCP 的飞书插件，支持一键 OAuth 登录访问用户态能力。",
      ),
      longDescriptionI18n: i18n(
        "Connect Synapse to Feishu using the official Lark OpenAPI MCP toolkit. Users authorize their own Feishu account with one click, while the platform-managed app credentials stay server-side in environment variables. The default toolset covers IM, docs, wiki, contacts, and Bitable workflows supported by the official MCP package.",
        "通过官方 Lark OpenAPI MCP 工具包把 Synapse 连接到飞书。用户只需一键授权自己的飞书账号，平台托管的应用凭据始终保留在服务端环境变量中。默认工具集覆盖 IM、文档、知识库、联系人和多维表格等官方支持场景。",
      ),
      summaryI18n: i18n(
        "Official Feishu MCP with platform-managed OAuth and user account connection.",
        "使用平台托管 OAuth 和用户账号授权的官方飞书 MCP。",
      ),
      defaultLocale: "zh-CN",
      transport: "stdio",
      entryPoint: feishuStdioEntryPoint,
      defaultInstanceScope: "workspace",
      defaultReuseScope: "turn",
      requiresHandshake: false,
      categorySlugs: [
        "integrations-and-automation",
        "documents-and-reading",
      ],
      tags: [
        "feishu",
        "lark",
        "official",
        "mcp",
        "oauth",
        "docs",
        "wiki",
        "bitable",
        "im",
        "stdio",
      ],
      toolsManifest,
      configSchema: {
        type: "object",
        properties: {
          feishuAccount: { type: "object" },
          language: { type: "string" },
          tools: { type: "string" },
        },
        required: ["feishuAccount"],
      },
      configFields: [
        {
          key: "feishuAccount",
          type: "oauth_connection",
          titleI18n: i18n("Feishu Account", "飞书账号"),
          descriptionI18n: i18n(
            "Authorize your Feishu account to enable user-scoped Feishu tools.",
            "授权你的飞书账号以启用用户态的飞书工具能力。",
          ),
          required: true,
          authProviderKey: "feishu_oauth",
        },
        {
          key: "language",
          type: "select",
          titleI18n: i18n("Tool Language", "工具语言"),
          descriptionI18n: i18n(
            "Choose the language used in tool names and descriptions.",
            "选择工具名称和描述展示语言。",
          ),
          defaultValue: defaultConfig.language,
          options: [
            { value: "zh", labelI18n: i18n("Chinese", "中文") },
            { value: "en", labelI18n: i18n("English", "英文") },
          ],
        },
        {
          key: "tools",
          type: "textarea",
          titleI18n: i18n("Enabled Tools", "启用工具"),
          descriptionI18n: i18n(
            "Comma or space separated tool names or preset names such as preset.default or preset.calendar.default.",
            "填写逗号或空格分隔的工具名或 preset 名称，例如 preset.default、preset.calendar.default。",
          ),
          placeholderI18n: i18n(
            "preset.default",
            "preset.default",
          ),
          defaultValue: defaultConfig.tools,
        },
      ],
      defaultConfig,
      setupSteps: [
        {
          id: "feishu_oauth",
          title: "Connect Feishu",
          description: "Authorize your Feishu account to let Synapse call the official Feishu MCP tools as you.",
          scope: "plugin",
          fields: ["feishuAccount"],
          helpUrl: "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction",
          helpText: "Review the official Feishu MCP documentation.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "connect",
            kind: "form",
            titleI18n: i18n("Connect Feishu", "连接飞书"),
            descriptionI18n: i18n(
              "Authorize your Feishu account with one click.",
              "一键授权你的飞书账号。",
            ),
            scope: "plugin",
            fields: ["feishuAccount"],
            helpUrl: "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction",
            helpTextI18n: i18n(
              "Open the official Feishu MCP guide.",
              "查看飞书官方 MCP 接入文档。",
            ),
          },
          {
            id: "preferences",
            kind: "form",
            titleI18n: i18n("Configure Tools", "配置工具"),
            descriptionI18n: i18n(
              "Choose the display language and the official tool presets you want to expose.",
              "选择工具展示语言，以及要暴露的官方工具 preset。",
            ),
            scope: "plugin",
            fields: ["language", "tools"],
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the connection and selected tools before installing.",
              "确认账号连接和所选工具后安装。",
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authProviders: [
        {
          key: "feishu_oauth",
          kind: "oauth2_authorization_code_pkce",
          displayNameI18n: i18n("Feishu", "飞书"),
          descriptionI18n: i18n(
            "Official Feishu OAuth provider for Synapse-managed MCP access.",
            "用于 Synapse 托管 MCP 接入的官方飞书 OAuth 提供方。",
          ),
          authorizeUrl: "https://open.feishu.cn/open-apis/authen/v1/authorize",
          tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
          userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
          clientIdEnv: "FEISHU_MCP_APP_ID",
          clientSecretEnv: "FEISHU_MCP_APP_SECRET",
          profileIdPath: "data.open_id",
          profileDisplayNamePath: "data.name",
          profileAvatarUrlPath: "data.avatar_url",
          configFieldKey: "feishuAccount",
          metadata: {
            tokenRequestContentType: "application/json",
            callbackUrlEnv: "FEISHU_MCP_CALLBACK_URL",
          },
        },
      ],
      authorization: {
        requiredPermissions: ["network:outbound"],
        defaultGrantScope: "workspace",
        reason: "Feishu MCP needs outbound network access to call official Feishu OpenAPI endpoints on behalf of the user.",
      },
    },
  ],
};
