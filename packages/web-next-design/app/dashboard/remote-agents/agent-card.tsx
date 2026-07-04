"use client"

// A status-first agent card. Identity + runtime badge + the binding SENTENCE
// (「在 <主机> 的 <目录>」, not raw fields) + ONE status line + a run-state pill,
// with a liveness dot and unread bubble on the avatar. No ids / raw counts /
// Invalid Date ever reach this surface. Reconciled: a down/untrusted host never
// shows a live-green agent.
import { MoreHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { RemoteAgentView, RemoteAgentMachineView } from "@synapse/shared"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  effectiveState,
  livenessDot,
  runtimeKindLabel,
  shortPath,
  statusLine,
  trustMeta,
} from "@/lib/remote-agent-status"

function MachineChip({
  machine,
  title,
}: {
  machine?: RemoteAgentMachineView
  title?: string
}) {
  const online = machine?.lifecycleState === "online"
  const trust = machine ? trustMeta(machine.trustStatus) : null
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <span className={cn("size-1.5 rounded-full", livenessDot(online))} />
      <span className="text-foreground/70">
        {machine?.title ?? title ?? "主机"}
      </span>
      {machine && machine.trustStatus === "pending" && (
        <span
          className={cn(
            "rounded border px-1 text-[9px] leading-4",
            trust!.className
          )}
        >
          {trust!.label}
        </span>
      )}
    </span>
  )
}

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
  const unread = agent.runtimeSummary?.unreadDeliveryCount ?? 0
  const online =
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
      {/* avatar + liveness + unread */}
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
            livenessDot(online)
          )}
        />
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {/* identity + binding sentence + status line */}
      <button
        type="button"
        onClick={() => onOpen(agent)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {agent.displayName}
          </span>
          <span className="shrink-0 rounded-md border bg-muted/40 px-1 py-0 text-[10px] leading-4 text-muted-foreground">
            {runtimeKindLabel(agent.runtimeKind)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {agent.binding ? (
            <>
              在{" "}
              <MachineChip
                machine={machine}
                title={agent.binding.machineTitle}
              />
              {agent.binding.localRootPath ? (
                <>
                  {" "}
                  的{" "}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">
                    {shortPath(agent.binding.localRootPath)}
                  </code>
                </>
              ) : (
                <>
                  {" "}
                  的{" "}
                  <span className="text-muted-foreground/70">
                    仓库根目录（默认）
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="text-amber-600">未绑定 · 去绑定</span>
          )}
        </div>
        <div
          className={cn(
            "mt-0.5 truncate text-xs",
            isError ? "text-red-600" : "text-muted-foreground/80"
          )}
        >
          {line}
        </div>
      </button>

      {/* run-state pill + kebab */}
      <div className="flex shrink-0 items-center gap-1.5">
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
              className="rounded-lg p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!agent.runtimeSummary?.activeConversationId}
              onClick={() => toast.success("打开会话")}
            >
              打开会话
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!agent.runtimeSummary?.activeTaskId}
              onClick={() => toast.success("查看任务")}
            >
              查看任务
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
