"use client"

// Agent detail — the home for everything demoted off the roster card: identity +
// the three status axes, an action bar, the binding (editable), full runtime
// status, group-task grants, sharing, and a collapsed debug block. Reuses the
// remote-agent status vocabulary so it reads identically to the roster.
import { useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowLeft,
  ChevronDown,
  Loader2,
  MessageSquare,
  Pencil,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { RuntimeKindIcon } from "@/components/runtime-kind-icon"
import {
  effectiveState,
  formatRelative,
  runtimeKindLabel,
  shortPath,
  statusLine,
  trustMeta,
} from "@/lib/remote-agent-status"
import { BindSheet } from "../../bind-sheet"

const CAP_LABELS: Record<string, string> = {
  supportsPlanMode: "计划模式",
  supportsRequestUserInput: "请求用户输入",
  supportsPersistentSession: "持久会话",
  supportsCodexAppServer: "Codex App Server",
  supportsStructuredIo: "结构化 IO",
}

export default function AgentDetailPage() {
  const { workspaceId } = useWorkspace()
  const params = useParams<{ remoteAgentId: string }>()
  const id = params.remoteAgentId
  const [bindOpen, setBindOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)

  const agentQuery = useQuery({
    queryKey: ["remote-agent", workspaceId, id],
    queryFn: () => api.getRemoteAgent(workspaceId!, id),
    enabled: !!workspaceId && !!id,
  })
  const machinesQuery = useQuery({
    queryKey: ["remote-agent-machines", workspaceId],
    queryFn: () => api.getRemoteAgentMachines(workspaceId!),
    enabled: !!workspaceId,
  })
  const grantsQuery = useQuery({
    queryKey: ["remote-agent-grants", workspaceId, id],
    queryFn: () => api.getRemoteAgentGroupTaskGrants(workspaceId!, id),
    enabled: !!workspaceId && !!id,
  })

  const agent = agentQuery.data?.remoteAgent
  const machines = machinesQuery.data?.machines ?? []
  const machine = useMemo(
    () =>
      agent?.binding
        ? machines.find((m) => m.id === agent.binding!.machineId)
        : undefined,
    [agent, machines]
  )
  const grants = grantsQuery.data?.grants ?? []

  if (agentQuery.isPending || !agent) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const run = effectiveState(agent, machine)
  const rs = agent.runtimeSummary

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <Link
        href="/dashboard/remote-agents"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 远程 Agent
      </Link>

      {/* header */}
      <div className="flex items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-muted text-2xl">
          {agent.avatarEmoji ?? "🤖"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <RuntimeKindIcon
              kind={agent.runtimeKind}
              className="size-4 text-muted-foreground/70"
            />
            <h1 className="truncate text-xl font-semibold">
              {agent.displayName}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">{agent.title}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  run.dot,
                  run.pulse && "animate-pulse"
                )}
              />
              <span className={run.danger ? "text-red-600" : ""}>
                {run.label}
              </span>
            </span>
            {machine && (
              <>
                <span>· {machine.title}</span>
                <span
                  className={cn(
                    "rounded border px-1 text-[10px]",
                    trustMeta(machine.trustStatus).className
                  )}
                >
                  {trustMeta(machine.trustStatus).label}
                </span>
              </>
            )}
            <span>· 活跃于 {formatRelative(rs?.lastActivityAt)}</span>
          </div>
        </div>
      </div>

      {/* actions */}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!rs?.activeConversationId}
          onClick={() => toast.success("打开会话")}
        >
          <MessageSquare className="mr-1.5 size-4" /> 打开会话
        </Button>
        <Button variant="outline" onClick={() => toast.success("分配任务")}>
          分配任务
        </Button>
        <Button variant="outline" onClick={() => setBindOpen(true)}>
          <Pencil className="mr-1.5 size-4" /> 改绑定
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.message(agent.isActive ? "已停用" : "已启用")}
        >
          {agent.isActive ? "停用" : "启用"}
        </Button>
      </div>

      <div className="mt-6 space-y-5">
        {/* binding */}
        <Section title="绑定">
          {agent.binding ? (
            <div className="space-y-1.5 text-sm">
              <Row label="主机">
                {machine?.title ?? agent.binding.machineTitle ?? "—"}
              </Row>
              <Row label="工作目录">
                <code className="font-mono text-xs">
                  {shortPath(agent.binding.localRootPath) ||
                    "仓库根目录（默认）"}
                </code>
              </Row>
              <Row label="运行时路径">
                <code className="font-mono text-xs">
                  {agent.binding.runtimePath ?? "自动检测"}
                </code>
              </Row>
              <Row label="绑定状态">
                {agent.binding.status === "active"
                  ? "已启用"
                  : agent.binding.status === "error"
                    ? "出错"
                    : "已停用"}
              </Row>
            </div>
          ) : (
            <button
              onClick={() => setBindOpen(true)}
              className="text-sm text-amber-600 hover:underline"
            >
              未绑定 · 去绑定一台主机
            </button>
          )}
        </Section>

        {/* runtime status */}
        <Section title="运行状态">
          <div className="space-y-1.5 text-sm">
            <Row label="状态">{statusLine(agent, machine)}</Row>
            {rs?.activeTaskId && (
              <Row label="当前任务">
                <code className="font-mono text-xs">{rs.activeTaskId}</code>
              </Row>
            )}
            <Row label="待处理会话">{rs?.pendingConversationCount ?? 0} 条</Row>
            {(rs?.lastRunStartedAt || rs?.lastRunFinishedAt) && (
              <Row label="上次运行">
                {formatRelative(rs?.lastRunStartedAt)} →{" "}
                {formatRelative(rs?.lastRunFinishedAt)}
              </Row>
            )}
            {rs?.lastError && (
              <div className="mt-1 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600">
                {rs.lastError}
              </div>
            )}
            {rs?.capabilities &&
              Object.entries(rs.capabilities).some(([, v]) => v) && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {Object.entries(rs.capabilities)
                    .filter(([, v]) => v)
                    .map(([k]) => (
                      <span
                        key={k}
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {CAP_LABELS[k] ?? k}
                      </span>
                    ))}
                </div>
              )}
          </div>
        </Section>

        {/* group task grants */}
        <Section
          title="群任务授权"
          action={
            <button
              onClick={() => toast.message("编辑授权成员")}
              className="text-xs text-primary hover:underline"
            >
              编辑
            </button>
          }
        >
          {grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无成员可分配群任务
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {grants.map((g) => (
                <span
                  key={g.workspaceMemberId}
                  className="flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1"
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px]">
                    {g.name[0]}
                  </span>
                  <span className="text-xs">{g.name}</span>
                </span>
              ))}
            </div>
          )}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/60">
            <Users className="size-3" /> 这些成员可以在群聊里给该 Agent 派活
          </p>
        </Section>

        {/* sharing */}
        <Section title="关系与分享">
          <div className="space-y-1.5 text-sm">
            <Row label="审批模式">
              {agent.requiresContactApproval ? "需验证" : "自动通过"}
            </Row>
            <Row label="公开分享">{agent.isPublicShared ? "开" : "关"}</Row>
          </div>
        </Section>

        {/* debug */}
        <div className="rounded-lg border">
          <button
            onClick={() => setDebugOpen((o) => !o)}
            className="flex w-full items-center gap-1 px-3 py-2.5 text-sm font-medium text-muted-foreground"
          >
            <ChevronDown
              className={cn("size-4 transition", debugOpen && "rotate-180")}
            />{" "}
            调试
          </button>
          {debugOpen && (
            <div className="space-y-1 border-t p-3 font-mono text-[11px] text-muted-foreground">
              <div>id: {agent.id}</div>
              {rs?.sessionId && <div>session: {rs.sessionId}</div>}
              <div>createdAt: {agent.createdAt ?? "—"}</div>
              <div>updatedAt: {agent.updatedAt ?? "—"}</div>
            </div>
          )}
        </div>
      </div>

      <BindSheet
        open={bindOpen}
        onOpenChange={setBindOpen}
        agent={agent}
        machines={machines}
        workspaceId={workspaceId!}
      />
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
