import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const mijiaSeed: BuiltinOrgSeed = {
  slug: "mijia",
  displayName: "Mijia",
  description:
    "Connect a Xiaomi/Mi Home account and let Synapse inspect device state or control smart home devices.",
  plugins: [
    {
      slug: "smarthome",
      displayName: "Mijia Smart Home",
      displayNameI18n: i18n("Mijia Smart Home", "米家智能家居"),
      description:
        "Bind a Mi Home account with QR code sign-in and expose device state, scenes, and device controls to AI.",
      descriptionI18n: i18n(
        "Bind a Mi Home account with QR code sign-in and expose device state, scenes, and device controls to AI.",
        "通过二维码绑定米家账号，把设备状态、场景和设备控制能力暴露给 AI。"
      ),
      longDescription:
        "Connects Synapse to Xiaomi Mi Home via the Mijia MCP sidecar. Scan a QR code once to bind your account; the bound credentials are forwarded per request to the sidecar (one shared deployment serves many accounts). AI can then list homes and devices, inspect capabilities and status, run scenes, and control devices. Tools are discovered live from the sidecar.",
      longDescriptionI18n: i18n(
        "Connects Synapse to Xiaomi Mi Home via the Mijia MCP sidecar. Scan a QR code once to bind your account; the bound credentials are forwarded per request to the sidecar (one shared deployment serves many accounts). AI can then list homes and devices, inspect capabilities and status, run scenes, and control devices. Tools are discovered live from the sidecar.",
        "通过 Mijia MCP sidecar 把 Synapse 连接到小米米家。扫码绑定一次账号，绑定凭据按请求转发给 sidecar（一个共享部署服务多个账号）。随后 AI 可以列出家庭和设备、查看能力与状态、执行场景并控制设备。工具列表由 sidecar 实时下发。"
      ),
      summaryI18n: i18n(
        "Mi Home account binding with AI-readable device state and control tools.",
        "扫码绑定米家账号，并向 AI 提供设备状态读取和控制工具。"
      ),
      defaultLocale: "zh-CN",
      // Proxies the multi-tenant Mijia MCP sidecar over Streamable HTTP. The
      // bound account's auth dict (serialized to the upstream mijiaAPI canonical
      // shape by the mijia_qr_login auth-secret serializer) is base64'd into the
      // X-Mijia-Auth header; the installation id scopes per-install isolation in
      // the sidecar; X-Mijia-Expose-Raw gates low-level tools.
      transport: "http",
      entryPoint: JSON.stringify({
        url: "${env:MIJIA_MCP_URL}",
        headers: {
          "X-Mijia-Auth": "${auth_b64:mijiaAccount}",
          "X-Mijia-Tenant": "${runtime:installationId}",
          "X-Mijia-Expose-Raw": "${config:exposeRawMiotTools}",
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
      iconAssetPath: "assets/icons/mijia.svg",
      categorySlugs: ["integrations-and-automation"],
      tags: ["mijia", "mi-home", "xiaomi", "smarthome", "iot", "qr-login"],
      // Tools are discovered live from the sidecar on connect.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          locale: {
            type: "string",
          },
          exposeRawMiotTools: {
            type: "boolean",
          },
          mijiaAccount: {
            type: "object",
          },
        },
        required: ["mijiaAccount"],
      },
      configFields: [
        {
          key: "locale",
          type: "select",
          titleI18n: i18n("Account Locale", "账号区域"),
          descriptionI18n: i18n(
            "Choose the Xiaomi account locale used for login and cloud requests.",
            "选择米家账号登录和云端请求使用的区域语言。"
          ),
          defaultValue: "zh_CN",
          options: [
            { value: "zh_CN", labelI18n: i18n("China Mainland", "中国大陆") },
            {
              value: "en_US",
              labelI18n: i18n("United States / Global", "全球 / 美国"),
            },
          ],
        },
        {
          key: "mijiaAccount",
          type: "auth_connection",
          titleI18n: i18n("Mi Home Account", "米家账号"),
          descriptionI18n: i18n(
            "Scan a QR code with the Mi Home app to bind your account. One installation binds one Mi Home account (shared by the installation's authorized members); members who need their own account should create a separate installation.",
            "使用米家 App 扫描二维码完成账号绑定。一个安装绑定一个米家账号（由该安装的授权成员共享）；若成员需要使用自己的米家账号，请创建单独安装。"
          ),
          required: true,
          authBindingKey: "mijia_account",
        },
        {
          key: "exposeRawMiotTools",
          type: "boolean",
          titleI18n: i18n("Expose Raw MIOT Tools", "暴露原始 MIOT 工具"),
          descriptionI18n: i18n(
            "Expose low-level raw property/action tools in addition to the friendly device tools.",
            "除友好的设备工具外，同时暴露底层原始属性和动作工具。"
          ),
          defaultValue: false,
        },
      ],
      defaultConfig: {
        locale: "zh_CN",
        exposeRawMiotTools: false,
      },
      setupSteps: [
        {
          id: "mijia_locale",
          title: "Choose Account Region",
          description:
            "Select the Xiaomi account locale that should be used for QR sign-in.",
          scope: "plugin",
          fields: ["locale"],
        },
        {
          id: "mijia_bind",
          title: "Bind Mi Home Account",
          description:
            "Scan the QR code with the Mi Home app to authorize Synapse.",
          scope: "plugin",
          fields: ["mijiaAccount"],
        },
        {
          id: "mijia_preferences",
          title: "Choose Tool Exposure",
          description:
            "Decide whether to expose low-level raw MIOT tools alongside the friendly device tools.",
          scope: "plugin",
          fields: ["exposeRawMiotTools"],
        },
      ],
      installFlow: {
        steps: [
          {
            id: "region",
            kind: "form",
            titleI18n: i18n("Choose Region", "选择区域"),
            descriptionI18n: i18n(
              "Select the Mi Home account locale.",
              "选择米家账号区域。"
            ),
            scope: "plugin",
            fields: ["locale"],
          },
          {
            id: "bind",
            kind: "auth",
            titleI18n: i18n("Bind Mi Home", "绑定米家"),
            descriptionI18n: i18n(
              "Scan a QR code with the Mi Home app. The session stays inside Synapse and can be refreshed automatically.",
              "使用米家 App 扫描二维码。会话保存在 Synapse 内，并会自动尝试刷新。"
            ),
            scope: "plugin",
            fields: ["mijiaAccount"],
          },
          {
            id: "preferences",
            kind: "form",
            titleI18n: i18n("Tool Preferences", "工具偏好"),
            descriptionI18n: i18n(
              "Choose whether to expose low-level raw MIOT tools in addition to the safe friendly tools.",
              "选择除了友好的工具之外，是否还要暴露底层原始 MIOT 工具。"
            ),
            scope: "plugin",
            fields: ["exposeRawMiotTools"],
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the account binding and install the plugin.",
              "确认账号绑定与工具暴露策略后安装插件。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authBindings: [
        {
          key: "mijia_account",
          driver: "mijia_qr_login",
          fieldKey: "mijiaAccount",
          displayNameI18n: i18n("Mi Home", "米家"),
          descriptionI18n: i18n(
            "Scan a QR code with the Mi Home app to authorize Synapse-managed smart home access.",
            "使用米家 App 扫描二维码，以授权 Synapse 托管的智能家居访问。"
          ),
          prerequisiteFields: ["locale"],
        },
      ],
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "Mijia cloud access requires outbound network requests to Xiaomi account and Mi Home device APIs on behalf of the connected user.",
      },
    },
  ],
}
