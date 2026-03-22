import path from "path";
import { createRequire } from "module";
import type { BuiltinOrgSeed } from "../types.js";
import { buildFeishuToolRuntime } from "../../builtin/feishu/openapi/runtime.js";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });
const require = createRequire(import.meta.url);

const defaultConfig = {
  domain: "https://open.feishu.cn",
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
    APP_ID: "${config:appId}",
    APP_SECRET: "${config:appSecret}",
    USER_ACCESS_TOKEN: "${config:feishuAccount.secretPayload.accessToken}",
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
      description: "Official Feishu OpenAPI MCP with user-provided app credentials and one-click OAuth sign-in.",
      longDescription:
        "Connect Synapse to Feishu using the official Lark OpenAPI MCP toolkit. Users first provide their own Feishu app credentials, then authorize their Feishu account with one click. The default toolset covers IM, docs, wiki, contacts, and Bitable workflows supported by the official MCP package.",
      displayNameI18n: i18n("Feishu Official MCP", "飞书官方 MCP"),
      descriptionI18n: i18n(
        "Official Feishu OpenAPI MCP with user-provided app credentials and one-click OAuth sign-in.",
        "基于官方 Feishu OpenAPI MCP 的飞书插件，先填写应用配置，再一键 OAuth 登录访问用户态能力。",
      ),
      longDescriptionI18n: i18n(
        "Connect Synapse to Feishu using the official Lark OpenAPI MCP toolkit. Users first provide their own Feishu app credentials, then authorize their Feishu account with one click. The default toolset covers IM, docs, wiki, contacts, and Bitable workflows supported by the official MCP package.",
        "通过官方 Lark OpenAPI MCP 工具包把 Synapse 连接到飞书。用户先填写自己的飞书应用配置，再一键授权飞书账号。默认工具集覆盖 IM、文档、知识库、联系人和多维表格等官方支持场景。",
      ),
      summaryI18n: i18n(
        "Official Feishu MCP with user-managed app credentials and account authorization.",
        "使用用户自填应用配置和账号授权的官方飞书 MCP。",
      ),
      defaultLocale: "zh-CN",
      transport: "stdio",
      entryPoint: feishuStdioEntryPoint,
      defaultInstanceScope: "workspace",
      defaultReuseScope: "turn",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/feishu.svg",
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
          appId: { type: "string" },
          appSecret: { type: "string", sensitive: true },
          domain: { type: "string" },
          feishuAccount: { type: "object" },
          language: { type: "string" },
          tools: { type: "string" },
        },
        required: ["appId", "appSecret", "feishuAccount"],
      },
      configFields: [
        {
          key: "appId",
          type: "text",
          titleI18n: i18n("App ID", "应用 ID"),
          descriptionI18n: i18n(
            "Enter the App ID of your Feishu app.",
            "填写你的飞书应用 App ID。",
          ),
          required: true,
        },
        {
          key: "appSecret",
          type: "secret",
          titleI18n: i18n("App Secret", "应用 Secret"),
          descriptionI18n: i18n(
            "Enter the App Secret of your Feishu app.",
            "填写你的飞书应用 App Secret。",
          ),
          required: true,
          secret: true,
        },
        {
          key: "domain",
          type: "text",
          titleI18n: i18n("Open Platform Domain", "开放平台域名"),
          descriptionI18n: i18n(
            "Override the Feishu Open Platform domain if needed.",
            "如有需要，可覆盖飞书开放平台域名。",
          ),
          defaultValue: defaultConfig.domain,
        },
        {
          key: "feishuAccount",
          type: "auth_connection",
          titleI18n: i18n("Feishu Account", "飞书账号"),
          descriptionI18n: i18n(
            "Authorize your Feishu account to enable user-scoped Feishu tools.",
            "授权你的飞书账号以启用用户态的飞书工具能力。",
          ),
          required: true,
          authBindingKey: "feishu_user",
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
          id: "feishu_credentials",
          title: "Configure Feishu App",
          description: "Provide the Feishu app credentials used for OAuth.",
          scope: "plugin",
          fields: ["appId", "appSecret", "domain"],
          helpUrl: "https://open.feishu.cn/document/home/introduction-to-lark-open-platform",
          helpText: "Review the Feishu Open Platform guide.",
        },
        {
          id: "feishu_user",
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
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Configure App", "填写应用配置"),
            descriptionI18n: i18n(
              "Enter your Feishu app credentials before account authorization.",
              "先填写飞书应用配置，再进行账号授权。",
            ),
            scope: "plugin",
            fields: ["appId", "appSecret", "domain"],
            helpUrl: "https://open.feishu.cn/document/home/introduction-to-lark-open-platform",
            helpTextI18n: i18n(
              "Open the Feishu Open Platform guide.",
              "查看飞书开放平台文档。",
            ),
          },
          {
            id: "connect",
            kind: "auth",
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
      authBindings: [
        {
          key: "feishu_user",
          driver: "oauth2_authorization_code_pkce",
          fieldKey: "feishuAccount",
          displayNameI18n: i18n("Feishu", "飞书"),
          descriptionI18n: i18n(
            "Official Feishu OAuth provider for Synapse-managed MCP access.",
            "用于 Synapse 托管 MCP 接入的官方飞书 OAuth 提供方。",
          ),
          prerequisiteFields: ["appId", "appSecret"],
          ownerScope: "installation",
          authorizeUrl: "https://open.feishu.cn/open-apis/authen/v1/authorize",
          tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
          userInfoUrl: "https://open.feishu.cn/open-apis/authen/v1/user_info",
          profileIdPath: "data.open_id",
          profileDisplayNamePath: "data.name",
          profileAvatarUrlPath: "data.avatar_url",
          inputs: {
            clientId: { source: "config", field: "appId" },
            clientSecret: { source: "config", field: "appSecret" },
            callbackUrl: { source: "derived", name: "oauth_callback_url" },
          },
          metadata: {
            tokenRequestContentType: "application/json",
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
