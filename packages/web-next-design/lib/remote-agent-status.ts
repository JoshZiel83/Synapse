// Remote-agent status vocabulary. THREE orthogonal axes kept separate — never
// merged into one "Status": TRUST (machine auth) · LIVENESS (machine online) ·
// RUN-STATE (agent activity). Plus reconciliation (a down/untrusted host
// suppresses a live-green agent), an attention bucket for roster grouping, and a
// hardened relative-time formatter that roots out the "Invalid Date" bug. zh-CN.
import type { RemoteAgentView, RemoteAgentMachineView } from "@synapse/shared"

type RuntimeState = NonNullable<RemoteAgentView["runtimeSummary"]>["state"]
type TrustStatus = RemoteAgentMachineView["trustStatus"]

export const runtimeKindLabel = (kind: string): string =>
  kind === "claude_code" ? "Claude Code" : kind === "codex" ? "Codex" : kind

// collapse a path to ".../parent/leaf"
export function shortPath(p?: string): string {
  if (!p) return ""
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean)
  if (parts.length <= 2) return p
  return `…/${parts.slice(-2).join("/")}`
}

// ── relative time (kills Invalid Date at the root) ───────────────────────────
const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })
export function formatRelative(iso?: string): string {
  if (!iso) return "从未连接"
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return "—"
  const diff = t - Date.now()
  const abs = Math.abs(diff)
  const min = 60_000
  if (abs < min) return "刚刚"
  if (abs < 60 * min) return rtf.format(Math.round(diff / min), "minute")
  if (abs < 24 * 60 * min)
    return rtf.format(Math.round(diff / (60 * min)), "hour")
  if (abs < 30 * 24 * 60 * min)
    return rtf.format(Math.round(diff / (24 * 60 * min)), "day")
  return new Date(iso).toLocaleDateString("zh-CN")
}

// ── AXIS 1: trust (machine authorization) ────────────────────────────────────
export function trustMeta(s: TrustStatus): {
  label: string
  className: string
} {
  switch (s) {
    case "pending":
      return {
        label: "待批准",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600",
      }
    case "revoked":
      return {
        label: "已撤销",
        className: "border-muted-foreground/30 bg-muted text-muted-foreground",
      }
    case "blocked":
      return {
        label: "已封禁",
        className: "border-red-500/30 bg-red-500/10 text-red-600",
      }
    default:
      return {
        label: "已信任",
        className: "border-transparent bg-muted text-muted-foreground",
      }
  }
}

// ── AXIS 2: liveness (machine connectivity) ──────────────────────────────────
export const livenessDot = (online?: boolean) =>
  online ? "bg-emerald-500" : "bg-muted-foreground/40"

// ── AXIS 3: run-state (agent activity) ───────────────────────────────────────
export interface RunMeta {
  label: string
  className: string
  pulse: boolean
}
export function runStateMeta(
  state: RuntimeState | "host_offline" | "host_untrusted" | "unbound"
): RunMeta {
  switch (state) {
    case "running":
      return {
        label: "运行中",
        className: "border-blue-500/30 bg-blue-500/10 text-blue-600",
        pulse: true,
      }
    case "plan_drafting":
      return {
        label: "拟定计划中",
        className: "border-blue-500/30 bg-blue-500/10 text-blue-600",
        pulse: true,
      }
    case "waiting_user_input":
      return {
        label: "等待输入",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600",
        pulse: true,
      }
    case "waiting_plan_approval":
      return {
        label: "待批准计划",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-600",
        pulse: true,
      }
    case "idle":
      return {
        label: "空闲",
        className: "border-transparent bg-muted text-muted-foreground",
        pulse: false,
      }
    case "error":
      return {
        label: "出错",
        className: "border-red-500/30 bg-red-500/10 text-red-600",
        pulse: false,
      }
    case "host_offline":
      return {
        label: "主机离线",
        className: "border-muted-foreground/25 bg-muted text-muted-foreground",
        pulse: false,
      }
    case "host_untrusted":
      return {
        label: "主机未信任",
        className: "border-amber-500/25 bg-amber-500/10 text-amber-600",
        pulse: false,
      }
    case "unbound":
      return {
        label: "未绑定",
        className: "border-muted-foreground/25 bg-muted text-muted-foreground",
        pulse: false,
      }
    default:
      return {
        label: "离线",
        className: "border-muted-foreground/25 bg-muted text-muted-foreground",
        pulse: false,
      }
  }
}

export type Attention = "needs" | "working" | "idle" | "offline"

// Reconcile the agent's own run-state against its host's trust + liveness.
// Returns the EFFECTIVE state to render (never a live pill under a down host).
export function effectiveState(
  agent: RemoteAgentView,
  machine?: RemoteAgentMachineView
): RunMeta {
  if (!agent.binding) return runStateMeta("unbound")
  if (machine && machine.trustStatus !== "active")
    return runStateMeta("host_untrusted")
  const hostOffline =
    agent.binding.machineLifecycleState === "offline" ||
    machine?.lifecycleState === "offline"
  if (hostOffline) return runStateMeta("host_offline")
  return runStateMeta(agent.runtimeSummary?.state ?? "offline")
}

export function attentionBucket(
  agent: RemoteAgentView,
  machine?: RemoteAgentMachineView
): Attention {
  if (!agent.isActive) return "offline"
  if (!agent.binding) return "offline"
  if (machine && machine.trustStatus !== "active") return "offline"
  if (
    agent.binding.machineLifecycleState === "offline" ||
    machine?.lifecycleState === "offline"
  )
    return "offline"
  const s = agent.runtimeSummary?.state
  const err = agent.runtimeSummary?.lastError
  if (err || s === "waiting_user_input" || s === "waiting_plan_approval")
    return "needs"
  if (s === "running" || s === "plan_drafting") return "working"
  if (s === "idle") return "idle"
  return "offline"
}

export const ATTENTION_ORDER: { key: Attention; label: string }[] = [
  { key: "needs", label: "需要处理" },
  { key: "working", label: "运行中" },
  { key: "idle", label: "空闲" },
  { key: "offline", label: "离线 / 未就绪" },
]

// One friendly status line for the card (statusText wins; else derive).
export function statusLine(
  agent: RemoteAgentView,
  machine?: RemoteAgentMachineView
): string {
  if (!agent.isActive) return "已停用"
  if (!agent.binding) return "未绑定 · 去绑定"
  if (machine && machine.trustStatus !== "active") return "主机未信任"
  if (
    agent.binding.machineLifecycleState === "offline" ||
    machine?.lifecycleState === "offline"
  )
    return "主机离线"
  const rs = agent.runtimeSummary
  if (rs?.lastError) return `出错 · ${rs.lastError}`
  if (rs?.statusText) return rs.statusText
  switch (rs?.state) {
    case "idle":
      return "空闲 · 可分配任务"
    case "running":
      return "运行中"
    case "waiting_user_input":
      return "等待你的输入"
    default:
      return `活跃于 ${formatRelative(rs?.lastActivityAt)}`
  }
}
