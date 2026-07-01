// Hand-authored, FIXED chat scenarios for design work.
//
// Unlike the schema-driven random mocks, these are curated so the chat screens
// show coherent, realistic situations: native DMs, group chats, IM-linked
// sessions (WeChat / Telegram / Feishu), and actors in different runtime states
// (idle / running-with-a-tool / error / waiting-for-input), plus in-conversation
// interactions (a plan-approval prompt and a user-input request).
//
// Every builder returns a sub-type derived by indexed access from the real
// @synapse/shared view schemas, so these stay type-checked against the contract
// (add/remove/retype a field upstream → this file fails to compile).
import type {
  ChatBootstrapViewSchemaType,
  ChatConversationMessagesViewSchemaType,
  TaskSummarySchemaType,
} from "@synapse/shared/schemas"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import {
  designWorkspaceId,
  designWorkspaceMemberId,
  designUserName,
} from "./identity"

// ── Types derived from the real contract ────────────────────────────────────
type Conversation = ChatBootstrapViewSchemaType["conversations"][number]
type Participant = Conversation["participants"][number]
type Presentation = Conversation["presentation"]
type LastItem = NonNullable<Conversation["lastItem"]>
type MessagesView = ChatConversationMessagesViewSchemaType
type Item = MessagesView["items"][number]
type MessageItem = Extract<Item, { itemType: "message" }>
type EventItem = Extract<Item, { itemType: "event" }>
type EntityRef = NonNullable<MessageItem["author"]>
type ActorRuntime = MessagesView["runtimeByActor"][string]
type TransportCtx = NonNullable<MessageItem["transport"]>

const ts = (iso: string) => dateToIsoInstant(new Date(iso))

export const designViewerMemberId = designWorkspaceMemberId
const WS = designWorkspaceId

// ── Cast of characters (stable ids, realistic names/avatars) ────────────────
const people = {
  self: {
    ref: {
      participantType: "workspace_member",
      workspaceMemberId: designWorkspaceMemberId,
      name: designUserName,
      avatarEmoji: "🧑🏻‍💻",
    } as EntityRef,
    pid: "pp-self",
  },
  chen: {
    ref: {
      participantType: "workspace_member",
      workspaceMemberId: "wm-chen",
      name: "陈晓",
      avatarEmoji: "👩🏻",
    } as EntityRef,
    pid: "pp-chen",
  },
  zhao: {
    ref: {
      participantType: "workspace_member",
      workspaceMemberId: "wm-zhao",
      name: "赵磊",
      avatarEmoji: "🧑🏻",
    } as EntityRef,
    pid: "pp-zhao",
  },
  aria: {
    ref: {
      participantType: "actor",
      actorId: "act-aria",
      name: "研究助理 Aria",
      avatarEmoji: "🔬",
    } as EntityRef,
    pid: "pp-aria",
  },
  atlas: {
    ref: {
      participantType: "actor",
      actorId: "act-atlas",
      name: "运维 Atlas",
      avatarEmoji: "🛠️",
    } as EntityRef,
    pid: "pp-atlas",
  },
  nova: {
    ref: {
      participantType: "actor",
      actorId: "act-nova",
      name: "数据 Nova",
      avatarEmoji: "📊",
    } as EntityRef,
    pid: "pp-nova",
  },
  wang: {
    ref: {
      participantType: "external",
      externalUserKey: "wx-wanglei",
      name: "王磊",
      transportKind: "weixin",
      avatarEmoji: "💬",
    } as EntityRef,
    pid: "pp-wang",
  },
  dmitry: {
    ref: {
      participantType: "external",
      externalUserKey: "tg-dmitry",
      name: "Dmitry",
      transportKind: "telegram",
      avatarEmoji: "✈️",
    } as EntityRef,
    pid: "pp-dmitry",
  },
  li: {
    ref: {
      participantType: "external",
      externalUserKey: "fs-li",
      name: "李经理",
      transportKind: "feishu",
      avatarEmoji: "🟦",
    } as EntityRef,
    pid: "pp-li",
  },
} as const

type Person = (typeof people)[keyof typeof people]

// ── Builders ────────────────────────────────────────────────────────────────
function participant(
  conv: string,
  p: Person,
  extra: Partial<Participant> = {}
): Participant {
  const r = p.ref
  return {
    participantId: p.pid,
    conversationId: conv,
    participantType: r.participantType,
    name: r.name ?? "",
    roleKey: r.participantType === "actor" ? "assistant" : "member",
    state: "active",
    metadata: {},
    joinedAt: ts("2026-06-20T09:00:00Z"),
    workspaceMemberId: r.workspaceMemberId,
    actorId: r.actorId,
    externalUserKey: r.externalUserKey,
    transportKind: r.transportKind,
    avatarEmoji: r.avatarEmoji,
    ...extra,
  }
}

type ContentBlock = MessageItem["contentBlocks"][number]
let blk = 0
const nextBlkId = () => `blk-${(blk += 1)}`
function textBlock(text: string): ContentBlock {
  return { id: nextBlkId(), type: "text", text }
}
// A real @mention — renders as an interactive mention chip (message-bubble
// resolves it against the conversation members by actorId / participantId),
// unlike a plain "@name" string.
function mentionBlock(target: Person): ContentBlock {
  return {
    id: nextBlkId(),
    type: "mention",
    mention: { ...target.ref, participantId: target.pid },
  }
}
function textBlocks(text: string): ContentBlock[] {
  return [textBlock(text)]
}

function msg(o: {
  id: string
  conv: string
  seq: number
  by: Person
  text: string
  at: string
  subtype?: MessageItem["subtype"]
  transport?: TransportCtx
  blocks?: ContentBlock[]
}): MessageItem {
  const role: MessageItem["role"] =
    o.by.ref.participantType === "actor" ? "assistant" : "user"
  return {
    id: o.id,
    conversationId: o.conv,
    sequence: o.seq,
    role,
    scope: "shared",
    surface: "visible",
    authorParticipantId: o.by.pid,
    author: o.by.ref,
    content: o.text,
    contentBlocks: o.blocks ?? textBlocks(o.text),
    metadata: {},
    createdAt: ts(o.at),
    itemType: "message",
    subtype: o.subtype ?? (role === "assistant" ? "assistant" : "user"),
    ...(o.transport ? { transport: o.transport } : {}),
  }
}

function toolResult(o: {
  id: string
  conv: string
  seq: number
  by: Person
  text: string
  at: string
}): MessageItem {
  return {
    id: o.id,
    conversationId: o.conv,
    sequence: o.seq,
    role: "tool",
    scope: "shared",
    surface: "visible",
    authorParticipantId: o.by.pid,
    author: o.by.ref,
    content: o.text,
    contentBlocks: textBlocks(o.text),
    metadata: {},
    createdAt: ts(o.at),
    itemType: "message",
    subtype: "tool_result",
  }
}

function errorNotice(o: {
  id: string
  conv: string
  seq: number
  by: Person
  text: string
  at: string
}): MessageItem {
  return {
    id: o.id,
    conversationId: o.conv,
    sequence: o.seq,
    role: "assistant",
    scope: "shared",
    surface: "visible",
    authorParticipantId: o.by.pid,
    author: o.by.ref,
    content: o.text,
    contentBlocks: textBlocks(o.text),
    metadata: {},
    createdAt: ts(o.at),
    itemType: "message",
    subtype: "model_error_notice",
  }
}

function planApprovalTask(o: {
  id: string
  conv: string
  requester: Person
  title: string
  planMarkdown: string
  summary?: string
}): TaskSummarySchemaType {
  return {
    kind: "plan_approval",
    id: o.id,
    workspaceId: WS,
    conversationId: o.conv,
    lifecycleStatus: "auth_required",
    revision: 1,
    requester: o.requester.ref,
    viewerCanResolve: true,
    createdAt: ts("2026-06-30T10:00:00Z"),
    updatedAt: ts("2026-06-30T10:00:00Z"),
    planApproval: {
      title: o.title,
      summary: o.summary,
      planMarkdown: o.planMarkdown,
    },
  }
}

type UserInputTask = Extract<TaskSummarySchemaType, { kind: "user_input" }>
type InputQuestion = UserInputTask["userInput"]["questions"][number]
type InputOption = NonNullable<InputQuestion["options"]>[number]

// A single- or multi-select question — renders as radio / checkbox options in
// the input-request card.
function selectQuestion(o: {
  id: string
  type: "single_select" | "multi_select"
  header: string
  prompt: string
  description?: string
  options: InputOption[]
  required?: boolean
  minSelections?: number
  maxSelections?: number
  allowOther?: boolean
}): InputQuestion {
  return {
    id: o.id,
    header: o.header,
    type: o.type,
    prompt: o.prompt,
    description: o.description,
    required: o.required ?? true,
    options: o.options,
    allowOther: o.allowOther,
    ...(o.minSelections != null ? { minSelections: o.minSelections } : {}),
    ...(o.maxSelections != null ? { maxSelections: o.maxSelections } : {}),
  }
}

function userInputTask(o: {
  id: string
  conv: string
  requester: Person
  title: string
  instructions?: string
  questions?: InputQuestion[]
}): TaskSummarySchemaType {
  return {
    kind: "user_input",
    id: o.id,
    workspaceId: WS,
    conversationId: o.conv,
    lifecycleStatus: "input_required",
    revision: 1,
    requester: o.requester.ref,
    viewerCanResolve: true,
    createdAt: ts("2026-06-30T10:05:00Z"),
    updatedAt: ts("2026-06-30T10:05:00Z"),
    userInput: {
      title: o.title,
      instructions: o.instructions,
      questions: o.questions ?? [],
    },
  }
}

function taskEvent(o: {
  id: string
  conv: string
  seq: number
  by: Person
  at: string
  task: TaskSummarySchemaType
}): EventItem {
  return {
    id: o.id,
    conversationId: o.conv,
    sequence: o.seq,
    role: "assistant",
    scope: "shared",
    surface: "visible",
    authorParticipantId: o.by.pid,
    author: o.by.ref,
    content: "",
    contentBlocks: [],
    metadata: {},
    createdAt: ts(o.at),
    itemType: "event",
    subtype: "task_requested",
    eventPayload: { task: o.task },
  }
}

function lastOf(items: Item[]): LastItem {
  const it = items[items.length - 1]
  return {
    itemId: it.id,
    sequence: it.sequence,
    itemType: it.itemType,
    subtype: it.itemType === "event" ? "task_requested" : "chat.message",
    previewText: it.content || "[任务请求]",
    authorParticipantId: it.authorParticipantId,
    author: it.author,
    createdAt: it.createdAt,
  }
}

function conv(o: {
  id: string
  title: string
  kind: Conversation["kind"]
  isIm: boolean
  members: Person[]
  items: Item[]
  unread?: number
  transportKind?: EntityRef["transportKind"]
  emoji?: string
  updatedAt: string
}): Conversation {
  const peer = o.members.find((m) => m.pid !== people.self.pid) ?? o.members[0]
  const presentation: Presentation = {
    chatType: o.kind,
    avatarParticipantIds: o.members.map((m) => m.pid),
    peerParticipantId: o.kind === "direct" ? peer.pid : undefined,
    avatarEmoji: o.emoji ?? peer.ref.avatarEmoji,
    subtitle: o.transportKind ? imLabel(o.transportKind) : undefined,
  }
  return {
    conversationId: o.id,
    workspaceId: WS,
    title: o.title,
    kind: o.kind,
    isIm: o.isIm,
    status: "active",
    unreadCount: o.unread ?? 0,
    muted: false,
    archived: false,
    updatedAt: ts(o.updatedAt),
    createdAt: ts("2026-06-20T09:00:00Z"),
    participants: o.members.map((m) => participant(o.id, m)),
    presentation,
    permissions: {
      canManageConversation: true,
      canManageParticipants: o.kind === "group",
      canRename: o.kind === "group",
    },
    viewerParticipantId: people.self.pid,
    lastItem: o.items.length > 0 ? lastOf(o.items) : undefined,
  }
}

function imLabel(k: NonNullable<EntityRef["transportKind"]>): string {
  const map: Record<string, string> = {
    weixin: "微信",
    feishu: "飞书",
    telegram: "Telegram",
    wecom: "企业微信",
    dingtalk: "钉钉",
    qq: "QQ",
    whatsapp: "WhatsApp",
    whatsapp_unofficial: "WhatsApp",
  }
  return map[k] ?? k
}

function actorRuntime(o: {
  conv: string
  actor: Person
  laneState: ActorRuntime["laneState"]
  health: ActorRuntime["health"]
  phase: ActorRuntime["phase"]
  statusText?: string
  activeTool?: string
  toolsTotal?: number
  toolsDone?: number
  lastError?: string
}): ActorRuntime {
  return {
    conversationId: o.conv,
    sessionId: `sess-${o.actor.ref.actorId}`,
    actorId: o.actor.ref.actorId ?? "",
    actorDisplayName: o.actor.ref.name ?? "",
    laneState: o.laneState,
    health: o.health,
    phase: o.phase,
    statusText: o.statusText,
    pendingWakeupCount: 0,
    updatedAt: ts("2026-06-30T10:10:00Z"),
    currentTurnPreview: o.activeTool
      ? {
          turnId: `turn-${o.actor.ref.actorId}`,
          startedAt: ts("2026-06-30T10:09:00Z"),
          updatedAt: ts("2026-06-30T10:10:00Z"),
          processingTargets: [],
          activeTool: {
            toolCallId: `tc-${o.actor.ref.actorId}`,
            toolKind: "device",
            toolName: "shell",
            state: "running",
            displayTitle: o.activeTool,
            startedAt: ts("2026-06-30T10:09:30Z"),
            updatedAt: ts("2026-06-30T10:10:00Z"),
          },
          totalToolCallCount: o.toolsTotal ?? 1,
          completedToolCallCount: o.toolsDone ?? 0,
          failedToolCallCount: 0,
        }
      : undefined,
    lastError: o.lastError
      ? { message: o.lastError, at: ts("2026-06-30T10:08:00Z") }
      : undefined,
  }
}

function messagesView(o: {
  conversation: Conversation
  items: Item[]
  runtimeByActor?: Record<string, ActorRuntime>
}): MessagesView {
  return {
    conversation: o.conversation,
    items: o.items,
    runtimeByActor: o.runtimeByActor ?? {},
    runtimeByRemoteAgent: {},
    participantReadWatermarkSequence: o.items.length,
    hasMoreBefore: false,
    hasMoreAfter: false,
  }
}

const wechatIn: TransportCtx = {
  direction: "inbound",
  transportKind: "weixin",
  endpointType: "direct",
}
const wechatOut: TransportCtx = {
  direction: "outbound",
  transportKind: "weixin",
  endpointType: "direct",
}
const tgIn: TransportCtx = {
  direction: "inbound",
  transportKind: "telegram",
  endpointType: "group",
}
const tgOut: TransportCtx = {
  direction: "outbound",
  transportKind: "telegram",
  endpointType: "group",
}
const fsIn: TransportCtx = {
  direction: "inbound",
  transportKind: "feishu",
  endpointType: "direct",
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const P = people

// 1) Native DM with a human colleague
const c1Items: Item[] = [
  msg({
    id: "c1-1",
    conv: "cv-colleague",
    seq: 1,
    by: P.self,
    text: "陈晓，落地页的第二版设计稿我发你了，有空看一下？",
    at: "2026-06-30T09:40:00Z",
  }),
  msg({
    id: "c1-2",
    conv: "cv-colleague",
    seq: 2,
    by: P.chen,
    text: "收到，我看看。整体方向不错，hero 区的留白再大一点会更透气。",
    at: "2026-06-30T09:52:00Z",
  }),
  msg({
    id: "c1-3",
    conv: "cv-colleague",
    seq: 3,
    by: P.chen,
    text: "对了，下午 3 点的评审会还开吗？",
    at: "2026-06-30T11:59:00Z",
  }),
]
const cv1 = conv({
  id: "cv-colleague",
  title: "陈晓",
  kind: "direct",
  isIm: false,
  members: [P.self, P.chen],
  items: c1Items,
  unread: 2,
  updatedAt: "2026-06-30T11:59:00Z",
})

// 2) Native DM with an actor — idle, a completed tool call
const c2Items: Item[] = [
  msg({
    id: "c2-1",
    conv: "cv-aria",
    seq: 1,
    by: P.self,
    text: "帮我调研一下 2026 上半年国内 AI Agent 产品的融资情况。",
    at: "2026-06-30T08:10:00Z",
  }),
  toolResult({
    id: "c2-2",
    conv: "cv-aria",
    seq: 2,
    by: P.aria,
    text: 'web_search("2026 AI Agent 融资 中国") → 命中 14 条结果',
    at: "2026-06-30T08:10:20Z",
  }),
  msg({
    id: "c2-3",
    conv: "cv-aria",
    seq: 3,
    by: P.aria,
    text: "已整理好：上半年国内 Agent 赛道共 23 起融资，总额约 48 亿元，头部集中在通用 Agent 与垂直办公场景。要我导出成表格吗？",
    at: "2026-06-30T08:11:00Z",
  }),
]
const cv2 = conv({
  id: "cv-aria",
  title: "研究助理 Aria",
  kind: "direct",
  isIm: false,
  members: [P.self, P.aria],
  items: c2Items,
  updatedAt: "2026-06-30T08:11:00Z",
})

// 3) Native DM with an actor — RUNNING a tool + a plan-approval interaction
const c3Items: Item[] = [
  msg({
    id: "c3-1",
    conv: "cv-atlas",
    seq: 1,
    by: P.self,
    text: "把 staging 上的服务部署到生产。",
    at: "2026-06-30T10:00:00Z",
  }),
  msg({
    id: "c3-2",
    conv: "cv-atlas",
    seq: 2,
    by: P.atlas,
    text: "好的，我先拟了一份部署计划，请你确认后再执行。",
    at: "2026-06-30T10:00:30Z",
  }),
  taskEvent({
    id: "c3-3",
    conv: "cv-atlas",
    seq: 3,
    by: P.atlas,
    at: "2026-06-30T10:01:00Z",
    task: planApprovalTask({
      id: "task-deploy",
      conv: "cv-atlas",
      requester: P.atlas,
      title: "生产部署计划",
      summary: "灰度发布 web-api v2.4.0，预计影响 3 个实例。",
      planMarkdown:
        "1. 拉取 `web-api:v2.4.0` 镜像\n2. 灰度 1 个实例，观察 5 分钟\n3. 全量滚动更新剩余实例\n4. 健康检查 + 冒烟测试",
    }),
  }),
]
const cv3 = conv({
  id: "cv-atlas",
  title: "运维 Atlas",
  kind: "direct",
  isIm: false,
  members: [P.self, P.atlas],
  items: c3Items,
  unread: 1,
  updatedAt: "2026-06-30T10:10:00Z",
})
const cv3Runtime = {
  "act-atlas": actorRuntime({
    conv: "cv-atlas",
    actor: P.atlas,
    laneState: "running",
    health: "ok",
    phase: "tool",
    statusText: "执行部署脚本…",
    activeTool: "运行 deploy.sh",
    toolsTotal: 4,
    toolsDone: 1,
  }),
}

// 4) Native DM with an actor — ERROR state
const c4Items: Item[] = [
  msg({
    id: "c4-1",
    conv: "cv-nova",
    seq: 1,
    by: P.self,
    text: "跑一下上季度的销售漏斗分析。",
    at: "2026-06-30T07:30:00Z",
  }),
  msg({
    id: "c4-2",
    conv: "cv-nova",
    seq: 2,
    by: P.nova,
    text: "正在连接数仓…",
    at: "2026-06-30T07:30:20Z",
  }),
  errorNotice({
    id: "c4-3",
    conv: "cv-nova",
    seq: 3,
    by: P.nova,
    text: "⚠️ 模型调用失败：上游 402（额度不足）。请检查模型组配额后重试。",
    at: "2026-06-30T07:31:00Z",
  }),
]
const cv4 = conv({
  id: "cv-nova",
  title: "数据 Nova",
  kind: "direct",
  isIm: false,
  members: [P.self, P.nova],
  items: c4Items,
  updatedAt: "2026-06-30T07:31:00Z",
})
const cv4Runtime = {
  "act-nova": actorRuntime({
    conv: "cv-nova",
    actor: P.nova,
    laneState: "blocked",
    health: "error",
    phase: "error",
    statusText: "模型调用失败",
    lastError: "Upstream 402: insufficient quota",
  }),
}

// 5) Native GROUP chat — mixed members + an actor
const c5Items: Item[] = [
  msg({
    id: "c5-1",
    conv: "cv-group",
    seq: 1,
    by: P.zhao,
    text: "各位，新版信息架构我更新到 Figma 了。",
    at: "2026-06-29T14:00:00Z",
  }),
  msg({
    id: "c5-2",
    conv: "cv-group",
    seq: 2,
    by: P.chen,
    text: "看到了，导航层级清晰多了 👍",
    at: "2026-06-29T14:05:00Z",
  }),
  msg({
    id: "c5-3",
    conv: "cv-group",
    seq: 3,
    by: P.self,
    text: "@研究助理 Aria 帮我们总结一下竞品的导航模式。",
    at: "2026-06-29T14:06:00Z",
    blocks: [
      mentionBlock(P.aria),
      textBlock(" 帮我们总结一下竞品的导航模式。"),
    ],
  }),
  msg({
    id: "c5-4",
    conv: "cv-group",
    seq: 4,
    by: P.aria,
    text: "主流做法是「侧边主导航 + 顶部工作区切换」，详见我刚发的对比表。",
    at: "2026-06-29T14:07:00Z",
  }),
]
const cv5 = conv({
  id: "cv-group",
  title: "产品设计组",
  kind: "group",
  isIm: false,
  members: [P.self, P.chen, P.zhao, P.aria],
  items: c5Items,
  unread: 4,
  emoji: "🎨",
  updatedAt: "2026-06-29T14:07:00Z",
})

// 6) IM-linked DM — WeChat (个人微信)
const c6Items: Item[] = [
  msg({
    id: "c6-1",
    conv: "cv-wechat",
    seq: 1,
    by: P.wang,
    text: "林工，合同附件收到了，我们这边周五前给到反馈。",
    at: "2026-06-30T09:20:00Z",
    subtype: "chat.message",
    transport: wechatIn,
  }),
  msg({
    id: "c6-2",
    conv: "cv-wechat",
    seq: 2,
    by: P.self,
    text: "好的王总，辛苦！有问题随时微信我。",
    at: "2026-06-30T09:25:00Z",
    subtype: "chat.message",
    transport: wechatOut,
  }),
  msg({
    id: "c6-3",
    conv: "cv-wechat",
    seq: 3,
    by: P.wang,
    text: "👌",
    at: "2026-06-30T09:26:00Z",
    subtype: "chat.message",
    transport: wechatIn,
  }),
]
const cv6 = conv({
  id: "cv-wechat",
  title: "王磊",
  kind: "direct",
  isIm: true,
  members: [P.self, P.wang],
  items: c6Items,
  unread: 1,
  transportKind: "weixin",
  updatedAt: "2026-06-30T09:26:00Z",
})

// 7) IM-linked GROUP — Telegram, with an actor bridging
const c7Items: Item[] = [
  msg({
    id: "c7-1",
    conv: "cv-tg",
    seq: 1,
    by: P.dmitry,
    text: "Any update on the API rate limits for the EU region?",
    at: "2026-06-30T06:10:00Z",
    subtype: "chat.message",
    transport: tgIn,
  }),
  msg({
    id: "c7-2",
    conv: "cv-tg",
    seq: 2,
    by: P.atlas,
    text: "EU 区限流已从 60→120 rpm，昨晚已生效。",
    at: "2026-06-30T06:12:00Z",
    subtype: "assistant",
    transport: tgOut,
  }),
  msg({
    id: "c7-3",
    conv: "cv-tg",
    seq: 3,
    by: P.dmitry,
    text: "Perfect, thanks 🙏",
    at: "2026-06-30T06:13:00Z",
    subtype: "chat.message",
    transport: tgIn,
  }),
  msg({
    id: "c7-4",
    conv: "cv-tg",
    seq: 4,
    by: P.self,
    text: "收到，我同步给国内团队，有问题群里 @我。",
    at: "2026-06-30T06:15:00Z",
    subtype: "chat.message",
    transport: tgOut,
  }),
]
const cv7 = conv({
  id: "cv-tg",
  title: "TG · 出海项目群",
  kind: "group",
  isIm: true,
  members: [P.self, P.dmitry, P.atlas],
  items: c7Items,
  unread: 2,
  transportKind: "telegram",
  emoji: "✈️",
  updatedAt: "2026-06-30T06:13:00Z",
})

// 8) IM-linked DM — Feishu, with a user-input interaction
const c8Items: Item[] = [
  msg({
    id: "c8-1",
    conv: "cv-feishu",
    seq: 1,
    by: P.li,
    text: "帮我把本周的项目周报整理一下发群里。",
    at: "2026-06-30T05:00:00Z",
    subtype: "chat.message",
    transport: fsIn,
  }),
  msg({
    id: "c8-2",
    conv: "cv-feishu",
    seq: 2,
    by: P.aria,
    text: "好的，我需要先确认两个信息。",
    at: "2026-06-30T05:00:40Z",
    subtype: "assistant",
  }),
  taskEvent({
    id: "c8-3",
    conv: "cv-feishu",
    seq: 3,
    by: P.aria,
    at: "2026-06-30T05:01:00Z",
    task: userInputTask({
      id: "task-weekly",
      conv: "cv-feishu",
      requester: P.aria,
      title: "补充周报信息",
      instructions: "确认这两项后我就整理并发出周报。",
      questions: [
        selectQuestion({
          id: "q-plan",
          type: "single_select",
          header: "下周计划",
          prompt: "本周报是否包含下周计划？",
          options: [
            { id: "yes", label: "包含下周计划" },
            { id: "no", label: "只写本周进展" },
          ],
        }),
        selectQuestion({
          id: "q-recipients",
          type: "multi_select",
          header: "收件范围",
          prompt: "发到哪些群？（可多选）",
          description: "至少选择一个群。",
          minSelections: 1,
          options: [
            { id: "proj", label: "项目 A 群", description: "核心项目成员" },
            { id: "mgmt", label: "管理层群", description: "周报汇报对象" },
            { id: "all", label: "全员群", description: "全公司可见" },
          ],
          allowOther: true,
        }),
      ],
    }),
  }),
  msg({
    id: "c8-4",
    conv: "cv-feishu",
    seq: 4,
    by: P.self,
    text: "包含下周计划；发到「项目 A + 管理层」群就好。",
    at: "2026-06-30T05:03:00Z",
    subtype: "chat.message",
  }),
]
const cv8 = conv({
  id: "cv-feishu",
  title: "李经理",
  kind: "direct",
  isIm: true,
  members: [P.self, P.li, P.aria],
  items: c8Items,
  unread: 1,
  transportKind: "feishu",
  updatedAt: "2026-06-30T05:01:00Z",
})

// 9) A brand-new conversation with NO messages — for designing the empty-thread
// state (no lastItem in the list, empty timeline in the pane).
const cvEmpty = conv({
  id: "cv-empty",
  title: "赵磊",
  kind: "direct",
  isIm: false,
  members: [P.self, P.zhao],
  items: [],
  updatedAt: "2026-06-30T12:30:00Z",
})

// ── Assembled exports ────────────────────────────────────────────────────────
// Order = most-recently-updated first (matches the inbox sort).
export const designChatBootstrap: ChatBootstrapViewSchemaType = {
  workspaceMemberId: designViewerMemberId,
  clientInstanceRequired: true,
  conversations: [cvEmpty, cv3, cv1, cv6, cv2, cv4, cv7, cv5, cv8],
  nextInboxCursor: 100,
}

const byId: Record<string, MessagesView> = {
  "cv-empty": messagesView({ conversation: cvEmpty, items: [] }),
  "cv-colleague": messagesView({ conversation: cv1, items: c1Items }),
  "cv-aria": messagesView({ conversation: cv2, items: c2Items }),
  "cv-atlas": messagesView({
    conversation: cv3,
    items: c3Items,
    runtimeByActor: cv3Runtime,
  }),
  "cv-nova": messagesView({
    conversation: cv4,
    items: c4Items,
    runtimeByActor: cv4Runtime,
  }),
  "cv-group": messagesView({ conversation: cv5, items: c5Items }),
  "cv-wechat": messagesView({ conversation: cv6, items: c6Items }),
  "cv-tg": messagesView({ conversation: cv7, items: c7Items }),
  "cv-feishu": messagesView({ conversation: cv8, items: c8Items }),
}

export function designMessagesFor(conversationId: string): MessagesView {
  return byId[conversationId] ?? messagesView({ conversation: cv1, items: [] })
}
