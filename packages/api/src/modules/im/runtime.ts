import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import { db } from "../../infrastructure/database/kysely.js";
import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
  TransportEndpointType,
} from "@synapse/shared/types";
import { emitEvent } from "../../infrastructure/events/index.js";
import { redis } from "../../infrastructure/redis/index.js";
import {
  createConversationItem,
  ensureConversationMember,
} from "../conversation/service.js";
import { createThread, wakeActor } from "../conversation/chat-service.js";
import { getWorkspaceChiefActorPreference } from "../workspace/service.js";
import {
  consumeTransportAccountAutoLink,
  ensureTransportAddress,
  findConversationTransportBindingByEndpoint,
  findTransportMessageLinkByExternalMessage,
  getPendingTransportAccountAutoLinkWorkspaceMemberId,
  getTransportAccountByKindAndId,
  listActiveTransportAccounts,
  queueConversationTransportProjection,
  syncTransportAddressConversationMember,
  updateTransportAddressMetadata,
  updateTransportEndpointMetadata,
  updateTransportMessageLinkStatus,
  upsertConversationTransportBinding,
} from "./service.js";

type RuntimeHandle = {
  accountId: string;
  fingerprint: string;
  leaseToken: string;
  stop: () => Promise<void>;
};

type FeishuMessageEvent = {
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id: string;
    create_time?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
    }>;
  };
};

type WeixinMessageItem = {
  type?: number;
  msg_id?: string;
  text_item?: {
    text?: string;
  };
  voice_item?: {
    text?: string;
  };
};

type WeixinMessage = {
  message_id?: number;
  from_user_id?: string;
  create_time_ms?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
};

type GenericInboundMessage = {
  account: TransportAccountSummary;
  endpointType: TransportEndpointType;
  endpointExternalId: string;
  endpointDisplayName?: string;
  externalMessageId: string;
  senderExternalId: string;
  senderDisplayName?: string;
  content: string;
  metadata?: Record<string, unknown>;
  senderMetadata?: Record<string, unknown>;
  endpointMetadata?: Record<string, unknown>;
};

const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_LONG_POLL_TIMEOUT_MS = 35_000;
const RUNTIME_RECONCILE_INTERVAL_MS = 15_000;
const RUNTIME_LEASE_TTL_MS = 30_000;
const RUNTIME_MANAGER_INSTANCE_ID = `${process.pid}:${crypto.randomUUID()}`;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();
const weixinSyncBufStore = new Map<string, string>();
const runtimeHandles = new Map<string, RuntimeHandle>();
let reconcileTimer: NodeJS.Timeout | null = null;
let reconcilePromise: Promise<void> | null = null;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized: string | undefined = nonEmptyString(entry);
      if (normalized) return normalized;
    }
    return undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function accountFingerprint(account: TransportAccountSummary) {
  return JSON.stringify({
    updatedAt: account.updatedAt,
    connectionMode: account.connectionMode,
    status: account.status,
    credentials: account.credentials || {},
    config: account.config || {},
    metadata: account.metadata || {},
  });
}

function transportRuntimeLeaseKey(accountId: string) {
  return `im:transport-runtime-lease:${accountId}`;
}

async function acquireTransportRuntimeLease(accountId: string) {
  const leaseToken = `${RUNTIME_MANAGER_INSTANCE_ID}:${accountId}:${crypto.randomUUID()}`;
  const result = await redis.set(
    transportRuntimeLeaseKey(accountId),
    leaseToken,
    "PX",
    RUNTIME_LEASE_TTL_MS,
    "NX",
  );
  return result === "OK" ? leaseToken : null;
}

async function renewTransportRuntimeLease(
  accountId: string,
  leaseToken: string,
) {
  const result = await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1]
       then
         return redis.call("PEXPIRE", KEYS[1], ARGV[2])
       else
         return 0
       end`,
    1,
    transportRuntimeLeaseKey(accountId),
    leaseToken,
    String(RUNTIME_LEASE_TTL_MS),
  );
  return Number(result) === 1;
}

async function releaseTransportRuntimeLease(
  accountId: string,
  leaseToken: string,
) {
  await redis.eval(
    `if redis.call("GET", KEYS[1]) == ARGV[1]
       then
         return redis.call("DEL", KEYS[1])
       else
         return 0
       end`,
    1,
    transportRuntimeLeaseKey(accountId),
    leaseToken,
  );
}

function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function getFeishuCredentials(account: TransportAccountSummary) {
  const credentials = account.credentials || {};
  const appId =
    nonEmptyString(credentials.appId) ||
    nonEmptyString(credentials.appID) ||
    nonEmptyString(credentials.cliAppId);
  const appSecret =
    nonEmptyString(credentials.appSecret) ||
    nonEmptyString(credentials.app_secret) ||
    nonEmptyString(credentials.cliAppSecret);
  const verificationToken =
    nonEmptyString(credentials.verificationToken) ||
    nonEmptyString(credentials.verification_token);
  const encryptKey =
    nonEmptyString(credentials.encryptKey) ||
    nonEmptyString(credentials.encrypt_key);

  if (!appId || !appSecret) {
    throw new Error(
      `Feishu transport account ${account.id} is missing appId/appSecret`,
    );
  }

  return { appId, appSecret, verificationToken, encryptKey };
}

function createFeishuClient(account: TransportAccountSummary) {
  const { appId, appSecret } = getFeishuCredentials(account);
  return new Lark.Client({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });
}

function createFeishuEventDispatcher(account: TransportAccountSummary) {
  const { verificationToken, encryptKey } = getFeishuCredentials(account);
  const dispatcher = new Lark.EventDispatcher({
    verificationToken,
    encryptKey,
    loggerLevel: Lark.LoggerLevel.info,
  });
  dispatcher.register({
    "im.message.receive_v1": async (data) => {
      await handleFeishuInboundEvent(account, data as FeishuMessageEvent);
    },
  });
  return dispatcher;
}

function parseFeishuMessageContent(messageType: string, content: string) {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return nonEmptyString(parsed?.text) || "";
    }
    if (messageType === "post") {
      return nonEmptyString(content) || "[富文本消息]";
    }
    if (messageType === "image") return "[图片]";
    if (messageType === "audio") return "[语音]";
    if (messageType === "video") return "[视频]";
    if (messageType === "file") {
      return nonEmptyString(parsed?.file_name) || "[文件]";
    }
  } catch {
    if (nonEmptyString(content)) return content;
  }
  return nonEmptyString(content) || `[${messageType || "message"}]`;
}

function normalizeFeishuMentions(
  text: string,
  mentions?: FeishuMessageEvent["message"]["mentions"],
) {
  if (!mentions?.length) return text;
  const escaped = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let normalized = text;
  for (const mention of mentions) {
    const mentionKey = nonEmptyString(mention.key);
    if (!mentionKey) continue;
    const mentionId =
      nonEmptyString(mention.id.open_id) || nonEmptyString(mention.id.user_id);
    const mentionName = nonEmptyString(mention.name) || "User";
    const replacement = mentionId
      ? `<at user_id="${mentionId}">${mentionName}</at>`
      : `@${mentionName}`;
    normalized = normalized.replace(
      new RegExp(escaped(mentionKey), "g"),
      replacement,
    );
  }
  return normalized.trim();
}

async function resolveFeishuSenderName(
  account: TransportAccountSummary,
  senderId: string,
) {
  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) return undefined;

  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  try {
    const client = createFeishuClient(account);
    const userIdType = normalizedSenderId.startsWith("ou_")
      ? "open_id"
      : normalizedSenderId.startsWith("on_")
        ? "union_id"
        : "user_id";
    const response: any = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });
    const name =
      nonEmptyString(response?.data?.user?.name) ||
      nonEmptyString(response?.data?.user?.display_name) ||
      nonEmptyString(response?.data?.user?.nickname) ||
      undefined;
    if (name) {
      senderNameCache.set(normalizedSenderId, {
        name,
        expireAt: now + 10 * 60 * 1000,
      });
    }
    return name;
  } catch (error) {
    console.error(
      `[im] Failed to resolve Feishu sender name for ${normalizedSenderId}:`,
      error,
    );
    return undefined;
  }
}

function isFeishuWebhookPayload(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function timingSafeEqualString(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isFeishuWebhookSignatureValid(params: {
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
  encryptKey?: string;
}) {
  const encryptKey = params.encryptKey?.trim();
  if (!encryptKey) {
    return true;
  }

  const timestamp = nonEmptyString(params.headers["x-lark-request-timestamp"]);
  const nonce = nonEmptyString(params.headers["x-lark-request-nonce"]);
  const signature = nonEmptyString(params.headers["x-lark-signature"]);
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const expected = Buffer.from(
    crypto
      .createHash("sha256")
      .update(timestamp + nonce + encryptKey + JSON.stringify(params.payload))
      .digest("hex"),
    "utf8",
  ).toString("utf8");
  return timingSafeEqualString(expected, signature);
}

function getWeixinBaseUrl(account: TransportAccountSummary) {
  return nonEmptyString(account.config.baseUrl) || DEFAULT_WEIXIN_BASE_URL;
}

function getWeixinToken(account: TransportAccountSummary) {
  return nonEmptyString(account.credentials?.token);
}

function buildWeixinBodyText(itemList?: WeixinMessageItem[]) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    const text = nonEmptyString(item.text_item?.text);
    if (text) return text;
    const voiceText = nonEmptyString(item.voice_item?.text);
    if (voiceText) return voiceText;
    if (item.type === 2) return "[图片]";
    if (item.type === 3) return "[语音]";
    if (item.type === 4) return "[文件]";
    if (item.type === 5) return "[视频]";
  }
  return "";
}

async function getWorkspaceOwnerId(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .select("owner_id")
    .where("id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst();
  const ownerId = row?.owner_id;
  if (!ownerId) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  return ownerId;
}

async function ensureTransportConversationBinding(params: {
  account: TransportAccountSummary;
  endpointType: TransportEndpointType;
  endpointExternalId: string;
  endpointDisplayName?: string;
}) {
  const existing = await findConversationTransportBindingByEndpoint({
    transportAccountId: params.account.id,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
  });
  if (existing) {
    return existing;
  }

  const ownerId = await getWorkspaceOwnerId(params.account.workspaceId);
  const created = await createThread({
    workspaceId: params.account.workspaceId,
    kind: "virtual",
    title:
      params.endpointDisplayName ||
      `${params.account.displayName} ${params.endpointType === "group" ? "群聊" : "私聊"}`,
    actorIds: [],
    includeCreatorMember: false,
  });

  try {
    return await upsertConversationTransportBinding({
      workspaceId: params.account.workspaceId,
      conversationId: created.conversation.id,
      transportAccountId: params.account.id,
      endpointType: params.endpointType,
      endpointExternalId: params.endpointExternalId,
      endpointDisplayName: params.endpointDisplayName,
      outboundEnabled: true,
      inboundActorMode: "inherit_account",
      metadata: {
        autoCreated: true,
      },
    });
  } catch (error: any) {
    if (error?.code === "23505") {
      return findConversationTransportBindingByEndpoint({
        transportAccountId: params.account.id,
        endpointType: params.endpointType,
        endpointExternalId: params.endpointExternalId,
      });
    }
    throw error;
  }
}

async function resolveDefaultWakeTarget(
  binding: ConversationTransportBindingSummary,
) {
  let actorId: string | null = null;

  if (binding.inboundActorMode === "specified_actor") {
    actorId = binding.inboundActorId || null;
  } else if (binding.inboundActorMode === "inherit_account") {
    if (binding.account.inboundActorMode === "specified_actor") {
      actorId = binding.account.inboundActorId || null;
    } else if (
      binding.account.inboundActorMode === "follow_owner_chief_actor" &&
      binding.account.ownerScope === "workspace_member" &&
      binding.account.ownerWorkspaceMemberId
    ) {
      const preference = await getWorkspaceChiefActorPreference(
        binding.workspaceId,
        binding.account.ownerWorkspaceMemberId,
      );
      actorId = preference.chiefActorId || null;
    }
  }

  if (!actorId) return null;

  const target = await ensureConversationMember({
    conversationId: binding.conversationId,
    memberType: "actor",
    actorId,
  });

  if (!target?.id) return null;
  return {
    participantId: target.id as string,
    actorId,
  };
}

async function ingestInboundTransportMessage(params: GenericInboundMessage) {
  const binding = await ensureTransportConversationBinding({
    account: params.account,
    endpointType: params.endpointType,
    endpointExternalId: params.endpointExternalId,
    endpointDisplayName: params.endpointDisplayName,
  });
  if (!binding) {
    throw new Error("Unable to resolve conversation binding for inbound message");
  }

  const existingLink = await findTransportMessageLinkByExternalMessage({
    transportAccountId: params.account.id,
    transportEndpointId: binding.endpoint.id,
    externalMessageId: params.externalMessageId,
    direction: "inbound",
  });
  if (existingLink) {
    return existingLink;
  }

  const senderAddress = await ensureTransportAddress({
    workspaceId: binding.workspaceId,
    transportAccountId: params.account.id,
    transportKind: params.account.transportKind,
    addressType: "user",
    externalId: params.senderExternalId,
    displayName: params.senderDisplayName,
    metadata: params.senderMetadata,
  });
  if (!senderAddress) {
    throw new Error("Failed to create sender transport address");
  }
  let linkedWorkspaceMemberId =
    typeof senderAddress.workspace_member_id === "string" &&
    senderAddress.workspace_member_id.trim()
      ? senderAddress.workspace_member_id
      : undefined;
  if (!linkedWorkspaceMemberId) {
    const pendingAutoLinkWorkspaceMemberId =
      getPendingTransportAccountAutoLinkWorkspaceMemberId(params.account);
    if (pendingAutoLinkWorkspaceMemberId) {
      await consumeTransportAccountAutoLink({
        account: params.account,
        transportAddressId: senderAddress.id,
        targetWorkspaceMemberId: pendingAutoLinkWorkspaceMemberId,
        matchedExternalId: params.senderExternalId,
      });
      if (params.account.metadata && typeof params.account.metadata === "object") {
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkWorkspaceMemberId;
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkMode;
        delete (params.account.metadata as Record<string, unknown>)
          .pendingAutoLinkConfiguredAt;
      }
      linkedWorkspaceMemberId = pendingAutoLinkWorkspaceMemberId;
    }
  }
  const senderMember = await syncTransportAddressConversationMember({
    conversationId: binding.conversationId,
    transportAddressId: senderAddress.id,
    workspaceMemberId: linkedWorkspaceMemberId,
    displayName:
      params.senderDisplayName || params.senderExternalId || "External user",
  });
  if (params.senderMetadata) {
    await updateTransportAddressMetadata({
      transportAddressId: senderAddress.id,
      metadata: params.senderMetadata,
    });
  }
  if (params.endpointMetadata) {
    await updateTransportEndpointMetadata({
      endpointId: binding.endpoint.id,
      metadata: params.endpointMetadata,
    });
  }

  const wakeTarget = await resolveDefaultWakeTarget(binding);
  const normalizedContent =
    nonEmptyString(params.content) || `[${params.account.transportKind} message]`;
  const item = await createConversationItem({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    scope: "shared",
    surface: "visible",
    itemType: "message",
    subtype: "chat",
    role: "user",
    authorMemberId: senderMember.id,
    metadata: {
      transport: {
        direction: "inbound",
        transportKind: params.account.transportKind,
        transportAccountId: params.account.id,
        endpointType: params.endpointType,
        endpointExternalId: params.endpointExternalId,
        externalMessageId: params.externalMessageId,
        transportAddressId: senderAddress.id,
        senderExternalId: params.senderExternalId,
      },
      ...(params.metadata || {}),
    },
    parts: [
      {
        type: "text",
        text: normalizedContent,
      },
    ],
    targetMemberIds: wakeTarget ? [wakeTarget.participantId] : [],
  });

  const link = await queueConversationTransportProjection({
    workspaceId: binding.workspaceId,
    conversationId: binding.conversationId,
    itemId: item.id,
    direction: "inbound",
    externalMessageId: params.externalMessageId,
    metadata: {
      transportKind: params.account.transportKind,
      senderExternalId: params.senderExternalId,
      endpointExternalId: params.endpointExternalId,
    },
  });
  if (link?.id) {
    await updateTransportMessageLinkStatus({
      linkId: link.id,
      status: "sent",
      externalMessageId: params.externalMessageId,
    });
  }

  if (wakeTarget) {
    await wakeActor({
      conversationId: binding.conversationId,
      actorId: wakeTarget.actorId,
      sourceType: "user_message",
      sourceItemId: item.id,
      sourceMemberType: linkedWorkspaceMemberId
        ? "workspace_member"
        : "external",
      sourceMemberId: linkedWorkspaceMemberId || senderMember.id,
      sourceName: params.senderDisplayName || params.senderExternalId,
      summary: normalizedContent.replace(/\s+/g, " ").trim().slice(0, 96),
      metadata: {
        transportKind: params.account.transportKind,
        transportAccountId: params.account.id,
        transportAddressId: senderAddress.id,
      },
    });
  }

  return link;
}

async function handleFeishuInboundEvent(
  account: TransportAccountSummary,
  event: FeishuMessageEvent,
) {
  const chatId = nonEmptyString(event.message?.chat_id);
  const messageId = nonEmptyString(event.message?.message_id);
  const senderExternalId =
    nonEmptyString(event.sender?.sender_id?.open_id) ||
    nonEmptyString(event.sender?.sender_id?.user_id) ||
    nonEmptyString(event.sender?.sender_id?.union_id);
  if (!chatId || !messageId || !senderExternalId) {
    return;
  }

  const endpointType: TransportEndpointType =
    event.message.chat_type === "group" ? "group" : "direct";
  const rawContent = parseFeishuMessageContent(
    event.message.message_type,
    event.message.content,
  );
  const content = normalizeFeishuMentions(rawContent, event.message.mentions);
  const senderDisplayName = await resolveFeishuSenderName(account, senderExternalId);

  await ingestInboundTransportMessage({
    account,
    endpointType,
    endpointExternalId: chatId,
    endpointDisplayName:
      endpointType === "group"
        ? `Feishu group ${chatId}`
        : senderDisplayName || senderExternalId,
    externalMessageId: messageId,
    senderExternalId,
    senderDisplayName: senderDisplayName || senderExternalId,
    content,
    metadata: {
      createTime: nonEmptyString(event.message.create_time),
      chatType: event.message.chat_type,
      messageType: event.message.message_type,
    },
    endpointMetadata:
      endpointType === "direct"
        ? {
            participantExternalId: senderExternalId,
          }
        : undefined,
  });
}

function buildWeixinHeaders(body: string, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "X-WECHAT-UIN": Buffer.from(
      String(crypto.randomBytes(4).readUInt32BE(0)),
      "utf8",
    ).toString("base64"),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function postWeixinJson(params: {
  baseUrl: string;
  endpoint: string;
  body: Record<string, unknown>;
  token?: string;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const body = JSON.stringify(params.body);
    const response = await fetch(
      `${params.baseUrl.replace(/\/+$/, "")}/${params.endpoint.replace(/^\/+/, "")}`,
      {
        method: "POST",
        headers: buildWeixinHeaders(body, params.token),
        body,
        signal: controller.signal,
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Weixin API ${params.endpoint} failed with ${response.status}: ${text}`,
      );
    }
    return text ? parseJsonObject(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function pollWeixinAccount(
  account: TransportAccountSummary,
  signal: AbortSignal,
) {
  const token = getWeixinToken(account);
  if (!token) {
    throw new Error(`Weixin transport account ${account.id} is missing token`);
  }

  while (!signal.aborted) {
    const currentBuf = weixinSyncBufStore.get(account.id) || "";
    try {
      const response = await postWeixinJson({
        baseUrl: getWeixinBaseUrl(account),
        endpoint: "ilink/bot/getupdates",
        token,
        timeoutMs: WEIXIN_LONG_POLL_TIMEOUT_MS,
        body: {
          get_updates_buf: currentBuf,
          base_info: {},
        },
      });
      if (signal.aborted) return;

      const ret = Number(response.ret || 0);
      const errcode = Number(response.errcode || 0);
      if (ret !== 0 || errcode !== 0) {
        throw new Error(
          `Weixin getupdates failed: ret=${ret} errcode=${errcode} errmsg=${nonEmptyString(response.errmsg) || ""}`,
        );
      }

      const nextBuf = nonEmptyString(response.get_updates_buf);
      if (nextBuf) {
        weixinSyncBufStore.set(account.id, nextBuf);
      }

      const messages = Array.isArray(response.msgs)
        ? (response.msgs as WeixinMessage[])
        : [];
      for (const message of messages) {
        await handleWeixinInboundMessage(account, message);
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error(`[im] Weixin poll failed for account ${account.id}:`, error);
      await sleep(2_000, signal).catch(() => undefined);
    }
  }
}

async function handleWeixinInboundMessage(
  account: TransportAccountSummary,
  message: WeixinMessage,
) {
  const senderExternalId = nonEmptyString(message.from_user_id);
  if (!senderExternalId) return;

  const itemMessageId =
    message.item_list
      ?.map((item) => nonEmptyString(item.msg_id))
      .find(Boolean) || String(message.message_id || "");
  const externalMessageId = nonEmptyString(itemMessageId);
  if (!externalMessageId) return;

  await ingestInboundTransportMessage({
    account,
    endpointType: "direct",
    endpointExternalId: senderExternalId,
    endpointDisplayName: senderExternalId,
    externalMessageId,
    senderExternalId,
    senderDisplayName: senderExternalId,
    content: buildWeixinBodyText(message.item_list) || "[微信消息]",
    metadata: {
      createTimeMs: message.create_time_ms,
    },
    senderMetadata: {
      contextToken: nonEmptyString(message.context_token),
    },
    endpointMetadata: {
      contextToken: nonEmptyString(message.context_token),
    },
  });
}

async function startRuntimeForAccount(
  account: TransportAccountSummary,
  leaseToken: string,
) {
  const abortController = new AbortController();
  const fingerprint = accountFingerprint(account);

  const run = async () => {
    if (account.transportKind === "feishu") {
      const { appId, appSecret } = getFeishuCredentials(account);
      const dispatcher = createFeishuEventDispatcher(account);
      const client = new Lark.WSClient({
        appId,
        appSecret,
        loggerLevel: Lark.LoggerLevel.info,
      });
      client.start({ eventDispatcher: dispatcher });
      try {
        await waitForAbort(abortController.signal);
      } finally {
        client.close({ force: true });
      }
      return;
    }

    if (account.transportKind === "weixin") {
      await pollWeixinAccount(account, abortController.signal);
    }
  };

  const promise = run()
    .catch((error) => {
      if (!abortController.signal.aborted) {
        console.error(
          `[im] Transport runtime crashed for account ${account.id}:`,
          error,
        );
      }
    })
    .finally(() => {
      const current = runtimeHandles.get(account.id);
      if (current?.fingerprint === fingerprint) {
        runtimeHandles.delete(account.id);
      }
    });

  runtimeHandles.set(account.id, {
    accountId: account.id,
    fingerprint,
    leaseToken,
    stop: async () => {
      abortController.abort();
      await promise;
      await releaseTransportRuntimeLease(account.id, leaseToken).catch(() => undefined);
    },
  });
}

async function reconcileTransportRuntimesOnce() {
  const desiredAccounts = await listActiveTransportAccounts({
    connectionMode: "long_connection",
  });
  const desiredById = new Map(
    desiredAccounts.map((account) => [account.id, account]),
  );

  for (const [accountId, handle] of runtimeHandles.entries()) {
    const desired = desiredById.get(accountId);
    const shouldStop =
      !desired ||
      handle.fingerprint !== accountFingerprint(desired) ||
      !(await renewTransportRuntimeLease(accountId, handle.leaseToken));
    if (shouldStop) {
      await handle.stop().catch((error) => {
        console.error(`[im] Failed to stop runtime for account ${accountId}:`, error);
      });
    }
  }

  for (const account of desiredAccounts) {
    if (runtimeHandles.has(account.id)) continue;
    const leaseToken = await acquireTransportRuntimeLease(account.id);
    if (!leaseToken) continue;
    await startRuntimeForAccount(account, leaseToken);
  }
}

async function reconcileTransportRuntimes() {
  if (reconcilePromise) {
    await reconcilePromise;
    return;
  }

  reconcilePromise = reconcileTransportRuntimesOnce().finally(() => {
    reconcilePromise = null;
  });
  await reconcilePromise;
}

export async function refreshTransportRuntimeManager() {
  await reconcileTransportRuntimes();
}

export async function startTransportRuntimeManager() {
  await reconcileTransportRuntimes();
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    void reconcileTransportRuntimes().catch((error) => {
      console.error("[im] Transport runtime reconcile failed:", error);
    });
  }, RUNTIME_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
}

export async function stopTransportRuntimeManager() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  const handles = Array.from(runtimeHandles.values());
  runtimeHandles.clear();
  await Promise.allSettled(handles.map((handle) => handle.stop()));
}

export async function handleFeishuWebhookRequest(params: {
  accountId: string;
  headers: Record<string, unknown>;
  body: unknown;
}) {
  const account = await getTransportAccountByKindAndId({
    accountId: params.accountId,
    transportKind: "feishu",
  });
  if (!account || account.status !== "active") {
    return {
      statusCode: 404,
      body: { error: "Transport account not found" },
    };
  }
  if (account.connectionMode !== "webhook") {
    return {
      statusCode: 409,
      body: { error: "Transport account is not configured for webhook mode" },
    };
  }
  if (!isFeishuWebhookPayload(params.body)) {
    return {
      statusCode: 400,
      body: { error: "Invalid webhook payload" },
    };
  }

  const { encryptKey } = getFeishuCredentials(account);
  if (
    !isFeishuWebhookSignatureValid({
      headers: params.headers,
      payload: params.body,
      encryptKey,
    })
  ) {
    return {
      statusCode: 401,
      body: { error: "Invalid signature" },
    };
  }

  const { isChallenge, challenge } = Lark.generateChallenge(params.body, {
    encryptKey: encryptKey || "",
  });
  if (isChallenge) {
    return {
      statusCode: 200,
      body: challenge,
    };
  }

  const dispatcher = createFeishuEventDispatcher(account);
  await dispatcher.invoke(params.body, { needCheck: false });
  return {
    statusCode: 200,
    body: { ok: true },
  };
}
