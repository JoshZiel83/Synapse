import type { BuiltinOrgSeed } from "../types.js";
import {
  DEFAULT_FEISHU_FEATURES,
  FEISHU_FEATURES,
  getFeishuFeatureConfigOptions,
} from "../../feishu/features.js";
import { getFeishuToolDefinitions } from "../../feishu/tools.js";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });

const allFeatureKeys = FEISHU_FEATURES.map((feature) => feature.key);
const defaultConfig = {
  features: DEFAULT_FEISHU_FEATURES,
};

export const feishuSeed: BuiltinOrgSeed = {
  slug: "feishu",
  displayName: "Feishu",
  description: "Feishu plugin with QR setup, feature-scoped permissions, and Synapse-native tools.",
  plugins: [
    {
      slug: "app",
      displayName: "Feishu",
      description:
        "Connect Feishu with QR setup, then expose only the Feishu capabilities you enable.",
      longDescription:
        "Connect Synapse to Feishu with a guided QR setup flow. Synapse provisions a personal Feishu app during setup, asks the user to authorize only the selected feature groups, and then exposes Synapse-native Feishu tools over our own file system abstraction.",
      displayNameI18n: i18n("Feishu", "飞书"),
      descriptionI18n: i18n(
        "Connect Feishu with QR setup, then expose only the Feishu capabilities you enable.",
        "通过扫码完成飞书接入，并只启用你选择的飞书能力。",
      ),
      longDescriptionI18n: i18n(
        "Connect Synapse to Feishu with a guided QR setup flow. Synapse provisions a personal Feishu app during setup, asks the user to authorize only the selected feature groups, and then exposes Synapse-native Feishu tools over our own file system abstraction.",
        "通过引导式扫码流程把 Synapse 连接到飞书。安装时会先为当前连接创建个人应用，再根据你选择的功能包申请对应权限，最后以 Synapse 自己抽象过的飞书工具提供能力，并接入我们的文件系统。",
      ),
      summaryI18n: i18n(
        "Feature-scoped Feishu plugin with QR-based setup and Synapse-native tools.",
        "按功能包授权、通过扫码接入的飞书原生插件。",
      ),
      defaultLocale: "zh-CN",
      transport: "builtin",
      entryPoint: "feishu/app",
      defaultInstanceScope: "workspace",
      defaultReuseScope: "conversation",
      requiresHandshake: false,
      iconAssetPath: "assets/icons/feishu.svg",
      categorySlugs: [
        "integrations-and-automation",
        "documents-and-reading",
      ],
      tags: [
        "feishu",
        "lark",
        "builtin",
        "qr-login",
        "contacts",
        "im",
        "calendar",
        "docs",
        "drive",
        "bitable",
      ],
      toolsManifest: getFeishuToolDefinitions({
        features: allFeatureKeys,
      }),
      configSchema: {
        type: "object",
        properties: {
          features: {
            type: "array",
            items: {
              type: "string",
              enum: allFeatureKeys,
            },
          },
          feishuAccount: {
            type: "object",
          },
        },
        required: ["features", "feishuAccount"],
      },
      configFields: [
        {
          key: "features",
          type: "multiselect",
          titleI18n: i18n("Enabled Features", "启用功能"),
          descriptionI18n: i18n(
            "Choose which Feishu feature groups this installation should expose. The QR authorization step will request only the scopes required by these features.",
            "选择这个安装实例要暴露的飞书功能包。后续扫码授权时，只会申请这些功能所需的权限。",
          ),
          required: true,
          defaultValue: defaultConfig.features,
          options: getFeishuFeatureConfigOptions(),
        },
        {
          key: "feishuAccount",
          type: "auth_connection",
          titleI18n: i18n("Feishu Account", "飞书账号"),
          descriptionI18n: i18n(
            "Scan the QR code to create the Feishu app and authorize the selected features for the connected account.",
            "扫码创建飞书应用，并为当前账号授权所选功能包对应的权限。",
          ),
          required: true,
          authBindingKey: "feishu_account",
        },
      ],
      defaultConfig,
      installFlow: {
        steps: [
          {
            id: "features",
            kind: "form",
            titleI18n: i18n("Choose Features", "选择功能"),
            descriptionI18n: i18n(
              "Choose the Feishu capabilities you want this installation to expose.",
              "选择这个飞书插件实例要暴露的功能包。",
            ),
            scope: "plugin",
            fields: ["features"],
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
              "Scan the QR code to create the Feishu app and authorize the selected features.",
              "扫码创建飞书应用，并授权你在上一步选择的功能包。",
            ),
            scope: "plugin",
            fields: ["feishuAccount"],
            helpUrl: "https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/mcp_integration/mcp_introduction",
            helpTextI18n: i18n(
              "Open the Feishu CLI integration guide.",
              "查看飞书 CLI 接入文档。",
            ),
          },
        ],
      },
      authBindings: [
        {
          key: "feishu_account",
          driver: "feishu_cli_setup",
          fieldKey: "feishuAccount",
          displayNameI18n: i18n("Feishu", "飞书"),
          descriptionI18n: i18n(
            "Create a Feishu app and authorize the selected feature scopes with QR sign-in.",
            "通过扫码创建飞书应用，并授权所选功能包对应的权限。",
          ),
          prerequisiteFields: ["features"],
          ownerScope: "installation",
        },
      ],
      validationRules: [
        {
          field: "features",
          rule: "required",
          message: "Select at least one Feishu feature.",
        },
      ],
      authorization: {
        requiredPermissions: ["network:outbound"],
        defaultAccessTargetType: "workspace",
        reason: "Feishu integration needs outbound network access to call Feishu OpenAPI endpoints on behalf of the connected account.",
      },
    },
  ],
};
