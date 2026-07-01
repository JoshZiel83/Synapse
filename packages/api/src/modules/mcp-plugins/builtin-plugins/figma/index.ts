import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const figmaSeed: BuiltinOrgSeed = {
  slug: "figma",
  displayName: "Figma",
  description:
    "Connect Figma's official remote MCP server to read and write design context via OAuth.",
  plugins: [
    {
      slug: "remote-mcp",
      displayName: "Figma Remote MCP",
      displayNameI18n: i18n("Figma Remote MCP", "Figma 远程 MCP"),
      description:
        "Connect to Figma's official remote MCP server. Sign in with Figma OAuth; tools are discovered live.",
      descriptionI18n: i18n(
        "Connect to Figma's official remote MCP server. Sign in with Figma OAuth; tools are discovered live.",
        "连接 Figma 官方远程 MCP 服务，使用 Figma OAuth 登录授权；工具列表由 Figma 实时下发。"
      ),
      longDescription:
        "This plugin proxies Figma's official hosted MCP server (https://mcp.figma.com/mcp) over Streamable HTTP. Authentication uses Figma OAuth 2.1 (authorization-code + PKCE) — there is no personal-access-token path. The obtained access token is sent as a Bearer header at runtime. Tools (get design context, variables, screenshots, write-to-canvas, etc.) are discovered live from Figma. NOTE: Figma currently restricts the mcp:connect scope to clients on its MCP Catalog allowlist, so this plugin is gated behind MCP_ENABLE_FIGMA + a Catalog-approved OAuth client until access is granted.",
      longDescriptionI18n: i18n(
        "This plugin proxies Figma's official hosted MCP server (https://mcp.figma.com/mcp) over Streamable HTTP. Authentication uses Figma OAuth 2.1 (authorization-code + PKCE) — there is no personal-access-token path. The obtained access token is sent as a Bearer header at runtime. Tools (get design context, variables, screenshots, write-to-canvas, etc.) are discovered live from Figma. NOTE: Figma currently restricts the mcp:connect scope to clients on its MCP Catalog allowlist, so this plugin is gated behind MCP_ENABLE_FIGMA + a Catalog-approved OAuth client until access is granted.",
        "该插件通过 Streamable HTTP 代理 Figma 官方托管 MCP 服务（https://mcp.figma.com/mcp）。认证使用 Figma OAuth 2.1（授权码 + PKCE），不支持个人访问令牌。获取的访问令牌在运行时作为 Bearer 头发送。工具（获取设计上下文、变量、截图、写入画布等）由 Figma 实时下发。注意：Figma 当前将 mcp:connect scope 限制为其 MCP Catalog 白名单客户端，故本插件在拿到 Catalog 批准的 OAuth 客户端前由 MCP_ENABLE_FIGMA 开关 + clientId/secret 双重门控。"
      ),
      summaryI18n: i18n(
        "Figma design context and write-to-canvas via the official remote MCP (OAuth).",
        "通过 Figma 官方远程 MCP（OAuth）获取设计上下文并写入画布。"
      ),
      defaultLocale: "en",
      transport: "http",
      // Streamable HTTP. The OAuth access token (obtained via the
      // oauth2_authorization_code_pkce driver and stored in plugin_connections)
      // is injected as a Bearer header at runtime via the ${auth:...} template.
      entryPoint: JSON.stringify({
        url: "https://mcp.figma.com/mcp",
        headers: {
          Authorization: "Bearer ${auth:figmaAccount.accessToken}",
        },
      }),
      defaultReuseScope: "session",
      requiresHandshake: false,
      categorySlugs: ["integrations-and-automation"],
      tags: ["figma", "design", "oauth", "official", "mcp"],
      // Tools are discovered live from the remote server on connect.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          figmaAccount: { type: "object" },
        },
        required: ["figmaAccount"],
      },
      configFields: [
        {
          key: "figmaAccount",
          type: "auth_connection",
          titleI18n: i18n("Figma Account", "Figma 账号"),
          descriptionI18n: i18n(
            "Sign in to Figma with OAuth to authorize MCP access.",
            "使用 Figma OAuth 登录以授权 MCP 访问。"
          ),
          required: true,
          authBindingKey: "figma_account",
        },
      ],
      setupSteps: [
        {
          id: "figma_oauth",
          title: "Connect Figma",
          description:
            "Sign in with Figma OAuth. Requires a full or dev seat on the Figma workspace.",
          scope: "plugin",
          fields: ["figmaAccount"],
          helpUrl:
            "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "oauth",
            kind: "auth",
            titleI18n: i18n("Connect Figma", "连接 Figma"),
            descriptionI18n: i18n(
              "Sign in with Figma OAuth. You'll be redirected to Figma to allow access.",
              "使用 Figma OAuth 登录，将跳转到 Figma 进行授权。"
            ),
            scope: "plugin",
            fields: ["figmaAccount"],
            helpUrl:
              "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the connected Figma account and install the plugin.",
              "确认已连接的 Figma 账号后安装插件。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authBindings: [
        {
          key: "figma_account",
          driver: "oauth2_authorization_code_pkce",
          fieldKey: "figmaAccount",
          displayNameI18n: i18n("Figma", "Figma"),
          descriptionI18n: i18n(
            "Authorize Synapse to access Figma on your behalf via OAuth.",
            "通过 OAuth 授权 Synapse 代表你访问 Figma。"
          ),
          authorizeUrl: "https://www.figma.com/oauth/mcp",
          tokenUrl: "https://api.figma.com/v1/oauth/token",
          // The driver reads binding.scopes (array) and joins them into the
          // OAuth `scope` query param.
          scopes: ["mcp:connect"],
          // RFC 8707 resource indicator: Figma's protected-resource metadata
          // names the resource as the /mcp endpoint, and the OAuth server binds
          // the issued token to it. Without this, the token is not valid for
          // https://mcp.figma.com/mcp. The driver appends these to both the
          // authorize URL and the token request.
          extraAuthorizeParams: { resource: "https://mcp.figma.com/mcp" },
          extraTokenParams: { resource: "https://mcp.figma.com/mcp" },
          // NOTE: deliberately NO userInfoUrl. Figma's REST GET /v1/me requires
          // the `current_user:read` REST scope, which the MCP OAuth flow
          // (mcp:connect only) does not grant — fetching it would hard-fail the
          // install at the callback. externalAccountId/displayName fall back to
          // the token-response claims (sub / user_id / name).
          // Figma's OAuth metadata advertises client_secret_basic /
          // client_secret_post only (no public 'none'), so BOTH clientId and
          // clientSecret are required. Provisioned via env from a
          // Catalog-approved Figma OAuth app.
          inputs: {
            clientId: { source: "env", env: "FIGMA_OAUTH_CLIENT_ID" },
            clientSecret: { source: "env", env: "FIGMA_OAUTH_CLIENT_SECRET" },
          },
        },
      ],
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "Figma official remote MCP requires outbound network access and an OAuth-authorized Figma account.",
      },
    },
  ],
}
