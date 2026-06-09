import type { BuiltinOrgSeed } from "../types.js"

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN })

export const amapSeed: BuiltinOrgSeed = {
  slug: "amap",
  displayName: "AMap",
  description:
    "AMap (Gaode) official MCP server for geocoding, POI search, weather, and routing.",
  plugins: [
    {
      slug: "openapi",
      displayName: "AMap Web Service",
      displayNameI18n: i18n("AMap Web Service", "高德地图 Web 服务"),
      description:
        "Connect to AMap's official MCP server for maps, search, and routing. Tools are discovered live from AMap.",
      descriptionI18n: i18n(
        "Connect to AMap's official MCP server for maps, search, and routing. Tools are discovered live from AMap.",
        "连接高德地图官方 MCP 服务，覆盖地图检索、地理编码、天气和路径规划。工具列表由高德实时下发。"
      ),
      longDescription:
        "This plugin proxies AMap's official hosted MCP server (https://mcp.amap.com/mcp). It covers geocoding, reverse geocoding, POI search, district lookup, weather, IP geolocation, and routing. Tools and their schemas are discovered live from AMap so they always match the upstream server.",
      longDescriptionI18n: i18n(
        "This plugin proxies AMap's official hosted MCP server (https://mcp.amap.com/mcp). It covers geocoding, reverse geocoding, POI search, district lookup, weather, IP geolocation, and routing. Tools and their schemas are discovered live from AMap so they always match the upstream server.",
        "该插件代理高德地图官方托管 MCP 服务（https://mcp.amap.com/mcp），覆盖地理编码、逆地理编码、POI 搜索、行政区查询、天气、IP 定位和路径规划。工具及其参数结构由高德实时下发，始终与官方一致。"
      ),
      summaryI18n: i18n(
        "Mapping, geocoding, POI search, and routing powered by AMap's official MCP.",
        "由高德地图官方 MCP 提供的地图检索、地理编码和路径规划工具包。"
      ),
      defaultLocale: "zh-CN",
      transport: "http",
      // Streamable HTTP; the AMap key is injected as the `key` query param
      // (AMap authenticates via URL query, NOT an Authorization header). The
      // remote client URL-encodes it via URLSearchParams.
      entryPoint: JSON.stringify({
        url: "https://mcp.amap.com/mcp",
        query: { key: "${config:apiKey}" },
      }),
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/amap.svg",
      categorySlugs: ["search-and-retrieval"],
      tags: [
        "amap",
        "gaode",
        "maps",
        "geocoding",
        "poi",
        "weather",
        "routing",
        "official",
        "mcp",
      ],
      // Tools are discovered live from the remote server on connect.
      toolsManifest: [],
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            sensitive: true,
            description: "AMap Web Service API key (服务平台选择 Web 服务).",
          },
        },
        required: ["apiKey"],
      },
      configFields: [
        {
          key: "apiKey",
          type: "secret",
          titleI18n: i18n("API Key", "API Key"),
          descriptionI18n: i18n(
            "Your AMap API key. Create it in the AMap console with service platform 'Web 服务'.",
            "你的高德 API Key。在高德开放平台控制台创建，服务平台请选择「Web 服务」。"
          ),
          placeholderI18n: i18n(
            "Paste your AMap Web Service key",
            "粘贴你的高德 Web 服务 Key"
          ),
          required: true,
          secret: true,
        },
      ],
      validationRules: [
        {
          field: "apiKey",
          rule: "required",
          message: "AMap API key is required.",
        },
        {
          field: "apiKey",
          rule: "min_length",
          value: 8,
          message: "AMap API key looks too short",
        },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure AMap Key",
          description:
            "Add your AMap Web Service API key. The key is passed to AMap's official MCP server.",
          scope: "plugin",
          fields: ["apiKey"],
          helpUrl: "https://lbs.amap.com/api/mcp-server/gettingstarted",
          helpText:
            "Create a Web Service API key in the AMap developer console.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect AMap", "连接高德地图"),
            descriptionI18n: i18n(
              "Enter your AMap Web Service API key. It is sent to AMap's official MCP server.",
              "填写高德地图 Web 服务 API Key，将用于连接高德官方 MCP 服务。"
            ),
            scope: "plugin",
            fields: ["apiKey"],
            helpUrl: "https://lbs.amap.com/api/mcp-server/gettingstarted",
            helpTextI18n: i18n(
              "Create a Web Service API key in the AMap developer console.",
              "在高德开放平台控制台创建 Web 服务 API Key。"
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the configured key and install the plugin.",
              "确认 API Key 配置后安装插件。"
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        reason:
          "AMap official MCP server requires outbound network access for geocoding, search, and routing requests.",
      },
    },
  ],
}
