import type {
  PluginConfigFieldOption,
} from "@synapse/shared";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });

type FeishuFeatureDefinition = {
  key: string;
  titleI18n: Record<string, string>;
  descriptionI18n: Record<string, string>;
  scopes: readonly string[];
  requiresAppApproval?: boolean;
};

export const FEISHU_FEATURES = [
  {
    key: "contacts",
    titleI18n: i18n("Contacts", "联系人"),
    descriptionI18n: i18n(
      "Search users and read basic user profiles.",
      "搜索用户并读取基础资料。",
    ),
    scopes: [
      "contact:user:search",
      "contact:user.basic_profile:readonly",
    ],
  },
  {
    key: "im_read",
    titleI18n: i18n("Messaging", "即时消息"),
    descriptionI18n: i18n(
      "Search chats and read chat history.",
      "搜索群聊并读取聊天记录。",
    ),
    scopes: [
      "im:chat:read",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "contact:user.base:readonly",
    ],
  },
  {
    key: "im_search",
    titleI18n: i18n("Message Search", "消息搜索"),
    descriptionI18n: i18n(
      "Search messages across chats. This requires Feishu app approval before authorization succeeds.",
      "跨群聊搜索消息。这个能力需要飞书应用先完成审核，之后才能授权成功。",
    ),
    scopes: [
      "search:message",
      "contact:user.basic_profile:readonly",
    ],
    requiresAppApproval: true,
  },
  {
    key: "im_send",
    titleI18n: i18n("Send Messages", "发送消息"),
    descriptionI18n: i18n(
      "Send text messages as the connected user. This requires Feishu app approval before authorization succeeds.",
      "以当前连接用户身份发送文本消息。这个能力需要飞书应用先完成审核，之后才能授权成功。",
    ),
    scopes: [
      "im:message.send_as_user",
    ],
    requiresAppApproval: true,
  },
  {
    key: "calendar",
    titleI18n: i18n("Calendar", "日历"),
    descriptionI18n: i18n(
      "List calendar events and create new events.",
      "读取日程并创建新日程。",
    ),
    scopes: [
      "calendar:calendar.event:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:update",
    ],
  },
  {
    key: "sheets",
    titleI18n: i18n("Sheets", "电子表格"),
    descriptionI18n: i18n(
      "Read and write spreadsheet cell values.",
      "读取和写入电子表格单元格。",
    ),
    scopes: [
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:write_only",
    ],
  },
  {
    key: "base",
    titleI18n: i18n("Bitable", "多维表格"),
    descriptionI18n: i18n(
      "List and create Bitable records.",
      "读取并创建多维表格记录。",
    ),
    scopes: [
      "bitable:app",
      "bitable:app:readonly",
    ],
  },
  {
    key: "task",
    titleI18n: i18n("Tasks", "任务"),
    descriptionI18n: i18n(
      "Create tasks in Feishu Task.",
      "在飞书任务中创建任务。",
    ),
    scopes: [
      "task:task:write",
    ],
  },
  {
    key: "drive",
    titleI18n: i18n("Drive", "云盘"),
    descriptionI18n: i18n(
      "Upload files from Synapse FileRef and download Drive files back into Synapse.",
      "把 Synapse FileRef 上传到云盘，并把云盘文件下载回 Synapse。",
    ),
    scopes: [
      "drive:file:upload",
      "drive:file:download",
    ],
  },
] as const satisfies readonly FeishuFeatureDefinition[];

export type FeishuFeatureKey = (typeof FEISHU_FEATURES)[number]["key"];

const featureSet = new Set<string>(FEISHU_FEATURES.map((feature) => feature.key));
const featureMap = new Map<string, (typeof FEISHU_FEATURES)[number]>(
  FEISHU_FEATURES.map((feature) => [feature.key, feature]),
);

export const DEFAULT_FEISHU_FEATURES: FeishuFeatureKey[] = [
  "contacts",
  "im_read",
  "calendar",
];

export function isFeishuFeatureKey(value: unknown): value is FeishuFeatureKey {
  return typeof value === "string" && featureSet.has(value);
}

export function normalizeFeishuFeatureKeys(value: unknown): FeishuFeatureKey[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.filter(isFeishuFeatureKey)),
    );
  }

  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(/[\s,]+/)
          .map((item) => item.trim())
          .filter(isFeishuFeatureKey),
      ),
    );
  }

  return [];
}

export function getFeishuFeatureConfigOptions(): PluginConfigFieldOption[] {
  return FEISHU_FEATURES.map((feature) => ({
    value: feature.key,
    labelI18n: feature.titleI18n,
    descriptionI18n: feature.descriptionI18n,
  }));
}

export function resolveFeishuFeatureScopes(features: FeishuFeatureKey[]) {
  const scopes = new Set<string>(["offline_access"]);
  for (const feature of features) {
    for (const scope of featureMap.get(feature)?.scopes || []) {
      scopes.add(scope);
    }
  }
  return Array.from(scopes);
}

export function getFeishuFeaturesRequiringApproval(features: FeishuFeatureKey[]) {
  return FEISHU_FEATURES.filter(
    (feature) =>
      features.includes(feature.key) &&
      ("requiresAppApproval" in feature && feature.requiresAppApproval === true),
  );
}

export function assertFeishuFeatureSelection(features: FeishuFeatureKey[]) {
  if (features.length === 0) {
    throw new Error("Select at least one Feishu feature before connecting the account.");
  }
}

export function assertFeishuInitialSetupFeatures(features: FeishuFeatureKey[]) {
  const blocked = getFeishuFeaturesRequiringApproval(features);
  if (blocked.length === 0) {
    return;
  }

  const names = blocked.map((feature) => feature.titleI18n.en).join(", ");
  throw new Error(
    `These Feishu features require app approval before authorization can succeed: ${names}. For initial setup, deselect them first. After the app is approved, reconnect to add them.`,
  );
}

export function hasFeishuScopesForFeatures(
  features: FeishuFeatureKey[],
  grantedScopes: unknown,
) {
  const granted = new Set(
    typeof grantedScopes === "string"
      ? grantedScopes.split(/\s+/).filter(Boolean)
      : Array.isArray(grantedScopes)
        ? grantedScopes.filter((item): item is string => typeof item === "string")
        : [],
  );

  return resolveFeishuFeatureScopes(features).every((scope) => granted.has(scope));
}

export function assertFeishuScopesForFeatures(
  features: FeishuFeatureKey[],
  grantedScopes: unknown,
) {
  const granted = new Set(
    typeof grantedScopes === "string"
      ? grantedScopes.split(/\s+/).filter(Boolean)
      : Array.isArray(grantedScopes)
        ? grantedScopes.filter((item): item is string => typeof item === "string")
        : [],
  );
  const missing = resolveFeishuFeatureScopes(features).filter((scope) => !granted.has(scope));

  if (missing.length > 0) {
    throw new Error(
      `The connected Feishu account is missing required scopes for the selected features: ${missing.join(", ")}. Reconnect the account after updating the feature selection.`,
    );
  }
}
