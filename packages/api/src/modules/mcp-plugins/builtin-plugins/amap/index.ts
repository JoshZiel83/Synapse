import type { BuiltinOrgSeed } from "../types.js";
import { amapToolDefinitions } from "../../builtin/amap/openapi/tool-specs.js";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });

export const amapSeed: BuiltinOrgSeed = {
  slug: "amap",
  displayName: "AMap",
  description: "AMap location toolkit for geocoding, POI search, district lookup, weather, IP location, coordinate conversion, and route planning.",
  plugins: [
    {
      slug: "openapi",
      displayName: "AMap Web Service",
      displayNameI18n: i18n("AMap Web Service", "高德地图 Web 服务"),
      description: "Official-style AMap Web Service toolkit wrapped as a builtin MCP plugin for maps, search, and routing workflows.",
      descriptionI18n: i18n(
        "Official-style AMap Web Service toolkit wrapped as a builtin MCP plugin for maps, search, and routing workflows.",
        "把高德地图 Web 服务能力包装成内置 MCP 插件，覆盖地图检索、地理编码、路径规划等工作流。",
      ),
      longDescription:
        "This builtin plugin wraps AMap Web Service APIs into MCP tools with cleaner input schemas, clearer parameter descriptions, and human-readable output formatting. It covers geocoding, reverse geocoding, POI search, place suggestions, district lookup, weather, IP geolocation, coordinate conversion, and routing.",
      longDescriptionI18n: i18n(
        "This builtin plugin wraps AMap Web Service APIs into MCP tools with cleaner input schemas, clearer parameter descriptions, and human-readable output formatting. It covers geocoding, reverse geocoding, POI search, place suggestions, district lookup, weather, IP geolocation, coordinate conversion, and routing.",
        "该插件把高德地图 Web 服务接口封装成 MCP 工具，提供更干净的输入定义、更清晰的参数说明和更可读的输出格式，覆盖地理编码、逆地理编码、POI 搜索、输入提示、行政区查询、天气、IP 定位、坐标转换和路径规划。",
      ),
      summaryI18n: i18n(
        "Mapping, geocoding, POI search, and routing powered by AMap.",
        "由高德地图提供的地图检索、地理编码和路径规划工具包。",
      ),
      defaultLocale: "zh-CN",
      transport: "builtin",
      entryPoint: "amap/openapi",
      defaultInstanceScope: "workspace",
      defaultReuseScope: "workspace",
      requiresHandshake: false,
      categorySlugs: ["search-and-retrieval"],
      tags: [
        "amap",
        "gaode",
        "maps",
        "geocoding",
        "poi",
        "weather",
        "routing",
        "builtin",
      ],
      toolsManifest: amapToolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      configSchema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            sensitive: true,
            description: "AMap Web Service API key.",
          },
          sig: {
            type: "string",
            sensitive: true,
            description: "Optional AMap digital signature if your account requires signed requests.",
          },
          timeoutMs: {
            type: "integer",
            description: "Optional request timeout in milliseconds.",
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
            "Your AMap Web Service API key.",
            "你的高德地图 Web 服务 API Key。",
          ),
          placeholderI18n: i18n(
            "Paste your AMap API key",
            "粘贴你的高德 API Key",
          ),
          secret: true,
        },
        {
          key: "sig",
          type: "secret",
          titleI18n: i18n("Signature", "数字签名"),
          descriptionI18n: i18n(
            "Optional AMap digital signature if your key enforces request signing.",
            "如果你的 key 开启了数字签名校验，可以在这里填写。",
          ),
          placeholderI18n: i18n(
            "Paste an optional request signature",
            "粘贴可选的请求签名",
          ),
          secret: true,
        },
        {
          key: "timeoutMs",
          type: "number",
          titleI18n: i18n("Timeout (ms)", "超时时间（毫秒）"),
          descriptionI18n: i18n(
            "Optional request timeout. Leave empty to use the 30 second default.",
            "可选请求超时时间。留空时默认 30 秒。",
          ),
          defaultValue: 30000,
        },
      ],
      defaultConfig: {
        timeoutMs: 30000,
      },
      validationRules: [
        { field: "apiKey", rule: "min_length", value: 8, message: "AMap API key looks too short" },
        { field: "sig", rule: "min_length", value: 8, message: "AMap signature looks too short" },
      ],
      setupSteps: [
        {
          id: "credentials",
          title: "Configure AMap Credentials",
          description: "Add your AMap Web Service API key. A digital signature is optional and only needed for accounts that require signed requests.",
          scope: "plugin",
          fields: ["apiKey", "sig"],
          helpUrl: "https://lbs.amap.com/api/webservice/summary/",
          helpText: "Use a Web Service API key from the AMap developer console.",
        },
      ],
      installFlow: {
        steps: [
          {
            id: "credentials",
            kind: "form",
            titleI18n: i18n("Connect AMap", "连接高德地图"),
            descriptionI18n: i18n(
              "Enter your AMap Web Service API key. Add a digital signature only if your account requires it.",
              "填写高德地图 Web 服务 API Key。只有在账号要求签名校验时才需要填写数字签名。",
            ),
            scope: "plugin",
            fields: ["apiKey", "sig", "timeoutMs"],
            helpUrl: "https://lbs.amap.com/api/webservice/summary/",
            helpTextI18n: i18n(
              "Create a Web Service API key in the AMap developer console.",
              "在高德开放平台控制台创建 Web 服务 API Key。",
            ),
          },
          {
            id: "review",
            kind: "confirm",
            titleI18n: i18n("Review and Install", "确认并安装"),
            descriptionI18n: i18n(
              "Review the configured key and install the plugin.",
              "确认 API Key 配置后安装插件。",
            ),
            scope: "plugin",
            fields: [],
          },
        ],
      },
      authorization: {
        requiredPermissions: ["network:outbound"],
        defaultGrantScope: "workspace",
        reason: "AMap Web Service APIs require outbound network access for geocoding, search, and routing requests.",
      },
    },
  ],
};
