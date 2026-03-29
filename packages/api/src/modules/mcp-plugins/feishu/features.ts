import type {
  PluginConfigFieldOption,
} from "@synapse/shared";

const i18n = (en: string, zhCN: string) => ({ en, "zh-CN": zhCN });

type FeishuFeatureDefinition = {
  key: string;
  titleI18n: Record<string, string>;
  descriptionI18n: Record<string, string>;
  scopes: readonly string[];
  mayRequireAppReview?: boolean;
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
      "Search messages across chats. Some Feishu tenants may require additional app review before authorization succeeds.",
      "跨群聊搜索消息。部分飞书租户在授权前可能要求额外的应用审核。",
    ),
    scopes: [
      "search:message",
      "contact:user.basic_profile:readonly",
    ],
    mayRequireAppReview: true,
  },
  {
    key: "im_send",
    titleI18n: i18n("Send Messages", "发送消息"),
    descriptionI18n: i18n(
      "Send text messages as the connected user. Some Feishu tenants may require additional app review before authorization succeeds.",
      "以当前连接用户身份发送文本消息。部分飞书租户在授权前可能要求额外的应用审核。",
    ),
    scopes: [
      "im:message.send_as_user",
    ],
    mayRequireAppReview: true,
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
    key: "docs",
    titleI18n: i18n("Docs", "文档"),
    descriptionI18n: i18n(
      "Search docs and sheets, read plain-text document content, and create or update docx documents from Markdown.",
      "搜索文档和表格，读取文档纯文本内容，并基于 Markdown 创建或更新 docx 文档。",
    ),
    scopes: [
      "search:docs:read",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
    ],
  },
  {
    key: "docs_media",
    titleI18n: i18n("Docs Media", "文档素材"),
    descriptionI18n: i18n(
      "Insert Synapse files into docx documents as images or attachments, and download document media or whiteboard snapshots back into Synapse.",
      "把 Synapse 文件作为图片或附件插入 docx 文档，并把文档素材或画板快照下载回 Synapse。",
    ),
    scopes: [
      "docs:document.media:upload",
      "docs:document.media:download",
      "docx:document:readonly",
      "docx:document:write_only",
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

export function assertFeishuFeatureSelection(features: FeishuFeatureKey[]) {
  if (features.length === 0) {
    throw new Error("Select at least one Feishu feature before connecting the account.");
  }
}

export function getFeishuFeatureTitle(
  featureKey: FeishuFeatureKey,
  locale: "en" | "zh-CN" = "en",
) {
  const feature = featureMap.get(featureKey);
  if (!feature) {
    return featureKey;
  }

  return feature.titleI18n[locale] || feature.titleI18n.en || featureKey;
}

export function getFeishuFeatureScopeCoverage(
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

  return features.map((featureKey) => {
    const feature = featureMap.get(featureKey);
    const scopes = Array.from(feature?.scopes || []);
    return {
      key: featureKey,
      title: getFeishuFeatureTitle(featureKey),
      mayRequireAppReview:
        Boolean(feature && "mayRequireAppReview" in feature && feature.mayRequireAppReview === true),
      scopes,
      missingScopes: scopes.filter((scope) => !granted.has(scope)),
    };
  });
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
