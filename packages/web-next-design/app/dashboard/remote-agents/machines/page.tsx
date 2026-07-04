"use client"

// Secondary 主机 (machines) management view — the daemons/hosts that run the
// agents. A flat list: trust badge + liveness dot + relative last-seen + hosted-
// agent count, pending machines pinned on top. Trust lifecycle
// (approve/block/revoke) has NO API in this surface, so it is shown honestly, not
// faked; pairing a new host is the one action here.
import { useMemo, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, ChevronRight, Link2, Loader2 } from "lucide-react"
import type { RemoteAgentMachineView } from "@synapse/shared"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  formatRelative,
  livenessDot,
  trustMeta,
} from "@/lib/remote-agent-status"
import { PairingDialog } from "../pairing-dialog"

function MachineRow({ m }: { m: RemoteAgentMachineView }) {
  const trust = trustMeta(m.trustStatus)
  return (
    <Link
      href={`/dashboard/remote-agents/machines/${m.id}`}
      className="flex items-center gap-3 rounded-xl border p-3 transition-colors hover:border-foreground/20"
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          livenessDot(m.lifecycleState === "online")
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{m.title}</span>
          <span
            className={cn(
              "shrink-0 rounded border px-1 text-[10px] leading-4",
              trust.className
            )}
          >
            {trust.label}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {m.lifecycleState === "online" ? "在线" : "离线"} · 活跃于{" "}
          {formatRelative(m.lastSeenAt)}
          {m.description && <> · {m.description}</>}
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {m.bindingCount ?? 0} 个 Agent
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
    </Link>
  )
}

export default function MachinesPage() {
  const { workspaceId } = useWorkspace()
  const [pairingOpen, setPairingOpen] = useState(false)
  const machinesQuery = useQuery({
    queryKey: ["remote-agent-machines", workspaceId],
    queryFn: () => api.getRemoteAgentMachines(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: 15000,
  })
  const machines = machinesQuery.data?.machines ?? []
  const { pending, rest } = useMemo(() => {
    const pending = machines.filter((m) => m.trustStatus === "pending")
    const rest = machines.filter((m) => m.trustStatus !== "pending")
    return { pending, rest }
  }, [machines])

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <Link
        href="/dashboard/remote-agents"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 远程 Agent
      </Link>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">主机</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            运行 Agent 的守护进程主机。一台主机可托管多个 Agent。
          </p>
        </div>
        {workspaceId && (
          <Button variant="outline" onClick={() => setPairingOpen(true)}>
            <Link2 className="mr-1 size-4" /> 配对主机
          </Button>
        )}
      </div>

      {machinesQuery.isPending ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : machines.length === 0 ? (
        <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          还没有配对任何主机
        </div>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                待批准
                <span className="rounded-full bg-amber-500/10 px-1.5 text-xs text-amber-600">
                  {pending.length}
                </span>
              </div>
              <div className="space-y-2">
                {pending.map((m) => (
                  <MachineRow key={m.id} m={m} />
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                刚配对的主机为待批准状态。批准 / 封禁在设备管理中进行。
              </p>
            </section>
          )}
          <div className="space-y-2">
            {rest.map((m) => (
              <MachineRow key={m.id} m={m} />
            ))}
          </div>
        </div>
      )}

      {workspaceId && (
        <PairingDialog
          open={pairingOpen}
          onOpenChange={setPairingOpen}
          workspaceId={workspaceId}
        />
      )}
    </div>
  )
}
