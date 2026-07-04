"use client"

// A status-first agent card, kept QUIET: the run-state pill is the only strong
// color; the runtime is a monochrome brand mark (Claude Code / Codex), the
// binding is a muted sentence 「在 <主机> 的 <目录>」, and a conversation count makes
// clear an agent fields MANY conversations at once — not a single task. No ids /
// raw counts / Invalid Date. Reconciled: a down/untrusted host shows no live pill.
import { MessageSquare, MoreHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { RemoteAgentView, RemoteAgentMachineView } from "@synapse/shared"
import { cn } from "@/lib/utils"
import { RuntimeKindIcon } from "@/components/runtime-kind-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  effectiveState,
  livenessDot,
  runtimeKindLabel,
  shortPath,
  statusLine,
  trustMeta,
} from "@/lib/remote-agent-status"

export function AgentCard({
  agent,
  machine,
  onOpen,
}: {
  agent: RemoteAgentView
  machine?: RemoteAgentMachineView
  onOpen: (a: RemoteAgentView) => void
}) {
  const run = effectiveState(agent, machine)
  const line = statusLine(agent, machine)
  const isError = line.startsWith("出错")
  const rs = agent.runtimeSummary
  const unread = rs?.unreadDeliveryCount ?? 0
  const convo = rs?.pendingConversationCount ?? 0
  const live =
    !!agent.binding &&
    machine?.trustStatus === "active" &&
    agent.binding.machineLifecycleState !== "offline" &&
    machine?.lifecycleState !== "offline"

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-foreground/20",
        !agent.isActive && "opacity-60"
      )}
    >
      {/* avatar + liveness + unread bubble */}
      <button
        type="button"
        onClick={() => onOpen(agent)}
        className="relative shrink-0"
      >
        <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-xl">
          {agent.avatarEmoji ?? "🤖"}
        </span>
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background",
            livenessDot(live)
          )}
        />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* identity + binding + status */}
      <button
        type="button"
        onClick={() => onOpen(agent)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-1.5">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground/70">
                  <RuntimeKindIcon
                    kind={agent.runtimeKind}
                    className="size-3.5"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {runtimeKindLabel(agent.runtimeKind)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="truncate text-sm font-medium">
            {agent.displayName}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
          {agent.binding ? (
            <>
              <span
                className={cn(
                  "mr-1 inline-block size-1.5 rounded-full align-middle",
                  livenessDot(machine?.lifecycleState === "online")
                )}
              />
              {machine?.title ?? agent.binding.machineTitle ?? "主机"}
              {machine?.trustStatus === "pending" && (
                <span className="ml-1 text-amber-600">· 待批准</span>
              )}
              {agent.binding.localRootPath && (
                <>
                  {" "}
                  ·{" "}
                  <code className="font-mono text-muted-foreground/60">
                    {shortPath(agent.binding.localRootPath)}
                  </code>
                </>
              )}
            </>
          ) : (
            <span className="text-amber-600">未绑定 · 去绑定</span>
          )}
        </div>
        <div
          className={cn(
            "mt-0.5 flex items-center gap-2 truncate text-xs",
            isError ? "text-red-600" : "text-muted-foreground/70"
          )}
        >
          <span className="truncate">{line}</span>
          {convo > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground/60">
              <MessageSquare className="size-3" />
              {convo} 个会话
            </span>
          )}
        </div>
      </button>

      {/* run-state pill (the one color accent) + kebab */}
      <div className="flex shrink-0 items-center gap-1">
        <span
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
            run.className
          )}
        >
          {run.pulse && (
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
          )}
          {run.label}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="更多"
              className="rounded-lg p-1 text-muted-foreground/50 hover:bg-accent hover:text-foreground"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={convo === 0}
              onClick={() => toast.success("查看会话")}
            >
              查看会话{convo > 0 ? `（${convo}）` : ""}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!rs?.activeTaskId}
              onClick={() => toast.success("查看当前任务")}
            >
              查看当前任务
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast.success("分配任务")}>
              分配任务
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => toast.message("改绑定（Phase 2）")}
            >
              改绑定
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                toast.message(agent.isActive ? "已停用" : "已启用")
              }
            >
              {agent.isActive ? "停用" : "启用"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
