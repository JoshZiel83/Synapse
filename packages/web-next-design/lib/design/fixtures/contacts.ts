// Curated Contacts-hub fixtures: a realistic mixed roster (workspace members +
// actors + remote agents + cross-workspace friends) with varied reachability
// states, replacing the random faker output ("Unknown user/actor", garbage
// counts). Drives the redesigned unified Contacts hub.
import type {
  ContactHubResponseSchemaType,
  ContactHubEntryView,
  FriendRequestView,
  ActorAccessRequestView,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const HOME = { id: designWorkspaceId, name: "设计工作区", slug: "design" }
const RESEARCH = { id: "ws-research", name: "研究工作区", slug: "research" }

type Kind = ContactHubEntryView["kind"]
type Target = ContactHubEntryView["targetType"]
type DirectStatus = ContactHubEntryView["directState"]["status"]

function entry(o: {
  kind: Kind
  target: Target
  id: string
  title: string
  subtitle?: string
  avatarEmoji?: string
  relationLabel: string
  status: DirectStatus
  workspace?: { id: string; name: string; slug: string }
  actorId?: string
  remoteAgentId?: string
  workspaceMemberId?: string
}): ContactHubEntryView {
  return {
    kind: o.kind,
    id: o.id,
    targetType: o.target,
    title: o.title,
    subtitle: o.subtitle,
    avatarEmoji: o.avatarEmoji,
    workspace: o.workspace ?? HOME,
    workspaceMemberId: o.workspaceMemberId,
    userId: o.target === "workspace_member" ? `user-${o.id}` : undefined,
    actorId: o.actorId,
    remoteAgentId: o.remoteAgentId,
    relationLabel: o.relationLabel,
    directState: {
      status: o.status,
      conversationId: o.status === "existing" ? `conv-${o.id}` : undefined,
    },
  }
}

const workspaceMembers: ContactHubEntryView[] = [
  entry({
    kind: "workspace-member",
    target: "workspace_member",
    id: "m-chenxi",
    title: "陈曦",
    subtitle: "产品经理",
    relationLabel: "工作区成员",
    status: "existing",
    workspaceMemberId: "wm-chenxi",
  }),
  entry({
    kind: "workspace-member",
    target: "workspace_member",
    id: "m-wanglei",
    title: "王磊",
    subtitle: "后端工程",
    relationLabel: "工作区成员",
    status: "available",
    workspaceMemberId: "wm-wanglei",
  }),
  entry({
    kind: "workspace-member",
    target: "workspace_member",
    id: "m-zhoumin",
    title: "周敏",
    subtitle: "设计",
    relationLabel: "工作区成员",
    status: "existing",
    workspaceMemberId: "wm-zhoumin",
  }),
  entry({
    kind: "workspace-member",
    target: "workspace_member",
    id: "m-akira",
    title: "Akira Tanaka",
    subtitle: "数据分析",
    relationLabel: "工作区成员",
    status: "available",
    workspaceMemberId: "wm-akira",
  }),
]

const workspaceActors: ContactHubEntryView[] = [
  entry({
    kind: "workspace-actor",
    target: "actor",
    id: "act-aria",
    title: "研究助理 Aria",
    subtitle: "文献检索 · 综述",
    avatarEmoji: "🔬",
    relationLabel: "工作区 Actor",
    status: "existing",
    actorId: "act-aria",
  }),
  entry({
    kind: "workspace-actor",
    target: "actor",
    id: "act-atlas",
    title: "运维 Atlas",
    subtitle: "部署 · 监控",
    avatarEmoji: "🛠️",
    relationLabel: "工作区 Actor",
    status: "available",
    actorId: "act-atlas",
  }),
  entry({
    kind: "workspace-actor",
    target: "actor",
    id: "act-nova",
    title: "数据 Nova",
    subtitle: "报表 · 分流",
    avatarEmoji: "📊",
    relationLabel: "工作区 Actor",
    status: "existing",
    actorId: "act-nova",
  }),
]

const workspaceRemoteAgents: ContactHubEntryView[] = [
  entry({
    kind: "workspace-remote-agent",
    target: "remote_agent",
    id: "ra-claude",
    title: "Claude Code",
    subtitle: "claude_code 运行时",
    avatarEmoji: "🤖",
    relationLabel: "工作区远程 Agent",
    status: "existing",
    remoteAgentId: "ra-claude",
  }),
  entry({
    kind: "workspace-remote-agent",
    target: "remote_agent",
    id: "ra-codex",
    title: "Codex",
    subtitle: "codex 运行时",
    avatarEmoji: "🧠",
    relationLabel: "工作区远程 Agent",
    status: "approval_required",
    remoteAgentId: "ra-codex",
  }),
]

const friends: ContactHubEntryView[] = [
  entry({
    kind: "friend-member",
    target: "workspace_member",
    id: "f-linran",
    title: "林然",
    subtitle: "研究工作区",
    avatarEmoji: undefined,
    relationLabel: "好友",
    status: "existing",
    workspace: RESEARCH,
    workspaceMemberId: "wm-linran",
  }),
  entry({
    kind: "friend-actor",
    target: "actor",
    id: "f-sage",
    title: "顾问 Sage",
    subtitle: "策略咨询",
    avatarEmoji: "🦉",
    relationLabel: "好友",
    status: "pending_approval",
    workspace: RESEARCH,
    actorId: "act-sage",
  }),
  entry({
    kind: "friend-remote-agent",
    target: "remote_agent",
    id: "f-scout",
    title: "Scout",
    subtitle: "外部 codex Agent",
    avatarEmoji: "🛰️",
    relationLabel: "好友",
    status: "available",
    workspace: RESEARCH,
    remoteAgentId: "ra-scout",
  }),
]

export const designContactHub: ContactHubResponseSchemaType = {
  requestSummary: {
    friendPendingCount: 2,
    actorAccessPendingCount: 1,
    remoteAgentAccessPendingCount: 0,
    totalPendingCount: 3,
  },
  workspaceActors,
  workspaceRemoteAgents,
  workspaceMembers,
  friends,
  groups: [],
}

export const designContactEntries: ContactHubEntryView[] = [
  ...workspaceMembers,
  ...workspaceActors,
  ...workspaceRemoteAgents,
  ...friends,
]

export function findContactEntry(
  kind: string,
  id: string
): ContactHubEntryView | undefined {
  return designContactEntries.find((e) => e.kind === kind && e.id === id)
}

// ── Basic request inbox (curated so the Requests row is not a dead end) ───────
const memberSummary = (o: {
  name: string
  email: string
  workspace?: typeof HOME
}) => ({
  workspace: o.workspace ?? RESEARCH,
  workspaceMemberId: `wm-${o.name}`,
  userId: `user-${o.name}`,
  name: o.name,
  email: o.email,
})

export const designFriendRequests: {
  incoming: FriendRequestView[]
  outgoing: FriendRequestView[]
} = {
  incoming: [
    {
      id: "fr-1",
      status: "pending",
      createdAt: ts("2026-06-30T09:00:00Z"),
      requester: memberSummary({ name: "赵越", email: "zhao@research.io" }),
      targetType: "workspace_member",
      targetMember: memberSummary({
        name: "林墨",
        email: "me@design.io",
        workspace: HOME,
      }),
    },
    {
      id: "fr-2",
      status: "pending",
      createdAt: ts("2026-06-29T14:30:00Z"),
      requester: memberSummary({
        name: "Diego Ruiz",
        email: "diego@research.io",
      }),
      targetType: "workspace_member",
      targetMember: memberSummary({
        name: "林墨",
        email: "me@design.io",
        workspace: HOME,
      }),
    },
  ],
  outgoing: [],
}

export const designActorAccessRequests: {
  incoming: ActorAccessRequestView[]
  outgoing: ActorAccessRequestView[]
} = {
  incoming: [
    {
      id: "aar-1",
      status: "pending",
      createdAt: ts("2026-06-30T11:00:00Z"),
      requester: memberSummary({ name: "赵越", email: "zhao@research.io" }),
      actor: {
        workspace: HOME,
        actorId: "act-aria",
        displayName: "研究助理 Aria",
        title: "文献检索",
        role: "specialist",
        avatarEmoji: "🔬",
        requiresContactApproval: true,
        isPublicShared: false,
      },
    },
  ],
  outgoing: [],
}

// ── Actor relationship profile (for the actor QR share) ──────────────────────
export function designActorProfile(actorId: string) {
  const slug = actorId.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "actor"
  return {
    subjectType: "actor" as const,
    approvalMode: "manual" as const,
    qrToken: `qr-${slug}`,
    qrUrl: `https://app.synapse/scan/relationship/qr-${slug}`,
    identityId: `actor-${slug}`,
    identitySearchEnabled: true,
    requiresContactApproval: true,
    isPublicShared: false,
  }
}

// ── My identity profile + identity search (header "+" add/identity sheet) ─────
export const designMyProfile = {
  subjectType: "workspace_member" as const,
  approvalMode: "manual" as const,
  qrToken: "qr-me-linmo",
  qrUrl: "https://app.synapse/scan/relationship/qr-me-linmo",
  identityId: "linmo-design",
  identitySearchEnabled: true,
  requiresContactApproval: true,
  isPublicShared: false,
}

export function designIdentitySearch(query: string) {
  const q = query.trim()
  if (q.length < 2) {
    return { query: q, outcome: "empty" as const, matches: [] }
  }
  return {
    query: q,
    outcome: "found" as const,
    matches: [
      {
        profileId: "prof-mochen",
        targetType: "workspace_member" as const,
        title: "墨尘",
        subtitle: "研究工作区 · 产品",
        workspace: RESEARCH,
        userId: "user-mochen",
        state: "requestable" as const,
      },
      {
        profileId: "prof-sage",
        targetType: "actor" as const,
        title: "顾问 Sage",
        subtitle: "策略咨询 Actor",
        avatarEmoji: "🦉",
        workspace: RESEARCH,
        actorId: "act-sage",
        state: "pending_request" as const,
        requestId: "aar-sage",
      },
    ],
  }
}
