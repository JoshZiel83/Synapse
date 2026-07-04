// Curated Remote-Agents fixtures: a realistic fleet of Claude Code / Codex agents
// on paired machines, with varied runtime states (running / waiting / idle /
// error), bindings, and machine trust+liveness — replacing the random faker
// output (garbage ids, "Invalid Date", negative counts, English).
import type { RemoteAgentView, RemoteAgentMachineView } from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId, designWorkspaceMemberId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const WS = designWorkspaceId
// recent-ish timestamps relative to the fixtures' notion of "now" (2026-07-03)
const MIN_AGO = (m: number) =>
  ts(new Date(Date.parse("2026-07-03T12:00:00Z") - m * 60000).toISOString())

export const designMachines: RemoteAgentMachineView[] = [
  {
    id: "mch-mbp",
    workspaceId: WS,
    title: "MacBook Pro · 前端",
    description: "林墨的开发机",
    trustStatus: "active",
    lifecycleState: "online",
    bindingCount: 2,
    lastSeenAt: MIN_AGO(1),
  },
  {
    id: "mch-cloud",
    workspaceId: WS,
    title: "云端构建机",
    description: "常驻 CI 主机",
    trustStatus: "active",
    lifecycleState: "online",
    bindingCount: 2,
    lastSeenAt: MIN_AGO(3),
  },
  {
    id: "mch-peer",
    workspaceId: WS,
    title: "同事的笔记本",
    trustStatus: "pending",
    lifecycleState: "offline",
    bindingCount: 1,
    lastSeenAt: MIN_AGO(240),
  },
]

let seq = 0
function agent(o: {
  id: string
  displayName: string
  title: string
  runtimeKind: "claude_code" | "codex"
  avatarEmoji?: string
  isActive?: boolean
  state?: NonNullable<RemoteAgentView["runtimeSummary"]>["state"]
  statusText?: string
  lastError?: string
  unread?: number
  pending?: number
  activeConversationId?: string
  activeTaskId?: string
  machineId?: string
  machineTitle?: string
  machineOffline?: boolean
  localRootPath?: string
  lastActivityMin?: number
}): RemoteAgentView {
  seq += 1
  const bound = !!o.machineId
  return {
    id: o.id,
    workspaceId: WS,
    displayName: o.displayName,
    title: o.title,
    runtimeKind: o.runtimeKind,
    avatarEmoji: o.avatarEmoji,
    requiresContactApproval: true,
    isActive: o.isActive ?? true,
    isPublicShared: false,
    metadata: {},
    ownerWorkspaceMemberId: designWorkspaceMemberId,
    createdAt: ts("2026-06-20T08:00:00Z"),
    updatedAt: MIN_AGO(o.lastActivityMin ?? 30),
    runtimeSummary: bound
      ? {
          runtimeKind: o.runtimeKind,
          state: o.state ?? "idle",
          statusText: o.statusText,
          sessionId: `sess-${seq}`,
          activeConversationId: o.activeConversationId,
          activeTaskId: o.activeTaskId,
          pendingConversationCount: o.pending ?? 0,
          unreadDeliveryCount: o.unread ?? 0,
          lastActivityAt: MIN_AGO(o.lastActivityMin ?? 30),
          lastError: o.lastError,
          capabilities: {
            supportsPlanMode: o.runtimeKind === "codex",
            supportsRequestUserInput: true,
            supportsPersistentSession: true,
          },
        }
      : undefined,
    binding: bound
      ? {
          machineId: o.machineId!,
          machineTitle: o.machineTitle,
          status: o.state === "error" ? "error" : "active",
          runtimePath:
            o.runtimeKind === "claude_code"
              ? "/usr/local/bin/claude"
              : "/usr/local/bin/codex",
          localRootPath: o.localRootPath,
          machineLifecycleState: o.machineOffline ? "offline" : "online",
        }
      : undefined,
  }
}

export const designRemoteAgents: RemoteAgentView[] = [
  agent({
    id: "ra-fe",
    displayName: "前端修复 Bot",
    title: "自动修 UI bug",
    runtimeKind: "claude_code",
    avatarEmoji: "🐛",
    state: "running",
    statusText: "正在编辑 src/app.tsx",
    unread: 3,
    activeConversationId: "conv-1",
    activeTaskId: "task-1",
    machineId: "mch-mbp",
    machineTitle: "MacBook Pro · 前端",
    localRootPath: "/Users/lin/work/web",
    lastActivityMin: 1,
  }),
  agent({
    id: "ra-refactor",
    displayName: "重构助手",
    title: "大规模重构",
    runtimeKind: "codex",
    avatarEmoji: "🧹",
    state: "waiting_user_input",
    statusText: "等待你确认删除 12 个文件",
    pending: 1,
    activeConversationId: "conv-2",
    machineId: "mch-mbp",
    machineTitle: "MacBook Pro · 前端",
    localRootPath: "/Users/lin/work/api",
    lastActivityMin: 4,
  }),
  agent({
    id: "ra-deploy",
    displayName: "部署 Agent",
    title: "发布与回滚",
    runtimeKind: "claude_code",
    avatarEmoji: "🚀",
    state: "idle",
    machineId: "mch-cloud",
    machineTitle: "云端构建机",
    localRootPath: "/srv/infra",
    lastActivityMin: 45,
  }),
  agent({
    id: "ra-lab",
    displayName: "实验 Agent",
    title: "跑实验脚本",
    runtimeKind: "codex",
    avatarEmoji: "🧪",
    state: "error",
    statusText: "模型调用失败",
    lastError: "上游返回 402：额度不足",
    machineId: "mch-cloud",
    machineTitle: "云端构建机",
    localRootPath: "/srv/lab",
    lastActivityMin: 20,
  }),
  agent({
    id: "ra-docs",
    displayName: "文档助手",
    title: "维护文档",
    runtimeKind: "claude_code",
    avatarEmoji: "📚",
    lastActivityMin: 120,
  }),
  agent({
    id: "ra-legacy",
    displayName: "旧调试 Agent",
    title: "遗留服务",
    runtimeKind: "claude_code",
    avatarEmoji: "🔧",
    state: "idle",
    machineId: "mch-peer",
    machineTitle: "同事的笔记本",
    machineOffline: true,
    localRootPath: "/home/dev/legacy",
    lastActivityMin: 240,
  }),
]

export const findRemoteAgent = (id: string) =>
  designRemoteAgents.find((a) => a.id === id)
export const findMachine = (id: string) =>
  designMachines.find((m) => m.id === id)
