"use client"

// Remote Agents — a status-first ROSTER of AI coding teammates (not a two-column
// infra inventory). Rows = agents, grouped by an attention bucket (需要处理 /
// 运行中 / 空闲 / 离线未就绪); machines are context (a chip per agent) with trust +
// pairing living in a secondary view (Phase 2). Silent background refetch.
import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { Loader2, Plus, Search, Link2 } from "lucide-react"
import type { RemoteAgentView, RemoteAgentMachineView } from "@synapse/shared"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  attentionBucket,
  ATTENTION_ORDER,
  type Attention,
} from "@/lib/remote-agent-status"
import { AgentCard } from "./agent-card"
import { PairingDialog } from "./pairing-dialog"
import { CreateAgentDialog } from "./create-agent-dialog"
import { BindSheet } from "./bind-sheet"

type RuntimeFilter = "all" | "claude_code" | "codex"

export default function RemoteAgentsRoster() {
  const { workspaceId } = useWorkspace()
  const router = useRouter()
  const [q, setQ] = useState("")
  const [runtime, setRuntime] = useState<RuntimeFilter>("all")
  const [statusFilter, setStatusFilter] = useState<Attention | "all">("all")
  const [byMachine, setByMachine] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [bindAgent, setBindAgent] = useState<RemoteAgentView | null>(null)

  const agentsQuery = useQuery({
    queryKey: ["remote-agents", workspaceId],
    queryFn: () => api.getRemoteAgents(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: 15000,
  })
  const machinesQuery = useQuery({
    queryKey: ["remote-agent-machines", workspaceId],
    queryFn: () => api.getRemoteAgentMachines(workspaceId!),
    enabled: !!workspaceId,
    refetchInterval: 15000,
  })

  const agents = agentsQuery.data?.remoteAgents ?? []
  const machineMap = useMemo(() => {
    const m = new Map(
      (machinesQuery.data?.machines ?? []).map((x) => [x.id, x])
    )
    return m
  }, [machinesQuery.data])
  const machineOf = (a: RemoteAgentView) =>
    a.binding ? machineMap.get(a.binding.machineId) : undefined

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return agents.filter((a) => {
      if (runtime !== "all" && a.runtimeKind !== runtime) return false
      if (
        statusFilter !== "all" &&
        attentionBucket(a, machineOf(a)) !== statusFilter
      )
        return false
      if (n) {
        const hay =
          `${a.displayName} ${a.title} ${a.binding?.localRootPath ?? ""} ${a.binding?.machineTitle ?? ""}`.toLowerCase()
        if (!hay.includes(n)) return false
      }
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, q, runtime, statusFilter, machineMap])

  const isEmpty = agents.length === 0
  const noMatch = !isEmpty && filtered.length === 0

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      {/* header */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">远程 Agent</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            让 Claude Code / Codex 作为团队成员在你的机器上干活
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => setPairingOpen(true)}>
            <Link2 className="mr-1 size-4" />
            配对主机
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 size-4" />
            新建 Agent
          </Button>
        </div>
      </div>

      {/* toolbar */}
      <div className="mb-4 space-y-2">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索 Agent、目录、主机…"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip active={runtime === "all"} onClick={() => setRuntime("all")}>
            全部运行时
          </Chip>
          <Chip
            active={runtime === "claude_code"}
            onClick={() => setRuntime("claude_code")}
          >
            Claude Code
          </Chip>
          <Chip
            active={runtime === "codex"}
            onClick={() => setRuntime("codex")}
          >
            Codex
          </Chip>
          <span className="mx-1 h-4 w-px bg-border" />
          {ATTENTION_ORDER.map((a) => (
            <Chip
              key={a.key}
              active={statusFilter === a.key}
              onClick={() =>
                setStatusFilter(statusFilter === a.key ? "all" : a.key)
              }
            >
              {a.label}
            </Chip>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            按主机分组
            <Switch checked={byMachine} onCheckedChange={setByMachine} />
          </label>
        </div>
      </div>

      {/* body */}
      {agentsQuery.isPending || machinesQuery.isPending ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isEmpty ? (
        <EmptyState onPair={() => setPairingOpen(true)} />
      ) : noMatch ? (
        <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          没有符合条件的 Agent ·{" "}
          <button
            className="text-primary hover:underline"
            onClick={() => {
              setQ("")
              setRuntime("all")
              setStatusFilter("all")
            }}
          >
            清除筛选
          </button>
        </div>
      ) : byMachine ? (
        <MachineGroups
          agents={filtered}
          machineOf={machineOf}
          machines={machineMap}
          onOpen={openAgent}
          onBind={setBindAgent}
        />
      ) : (
        <AttentionGroups
          agents={filtered}
          machineOf={machineOf}
          onOpen={openAgent}
          onBind={setBindAgent}
        />
      )}

      {workspaceId && (
        <>
          <PairingDialog
            open={pairingOpen}
            onOpenChange={setPairingOpen}
            workspaceId={workspaceId}
          />
          <CreateAgentDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            workspaceId={workspaceId}
          />
          {bindAgent && (
            <BindSheet
              open={!!bindAgent}
              onOpenChange={(o) => !o && setBindAgent(null)}
              agent={bindAgent}
              machines={machinesQuery.data?.machines ?? []}
              workspaceId={workspaceId}
            />
          )}
        </>
      )}
    </div>
  )

  function openAgent(a: RemoteAgentView) {
    router.push(`/dashboard/remote-agents/agents/${a.id}`)
  }
}

function AttentionGroups({
  agents,
  machineOf,
  onOpen,
  onBind,
}: {
  agents: RemoteAgentView[]
  machineOf: (a: RemoteAgentView) => RemoteAgentMachineView | undefined
  onOpen: (a: RemoteAgentView) => void
  onBind: (a: RemoteAgentView) => void
}) {
  const grouped = useMemo(() => {
    const m = new Map<Attention, RemoteAgentView[]>()
    for (const a of agents) {
      const k = attentionBucket(a, machineOf(a))
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(a)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents])
  return (
    <div className="space-y-5">
      {ATTENTION_ORDER.filter((s) => grouped.get(s.key)?.length).map((s) => (
        <section key={s.key} className="space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {s.label}
            <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
              {grouped.get(s.key)!.length}
            </span>
          </div>
          <div className="space-y-2">
            {grouped.get(s.key)!.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                machine={machineOf(a)}
                onOpen={onOpen}
                onBind={onBind}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function MachineGroups({
  agents,
  machineOf,
  machines,
  onOpen,
  onBind,
}: {
  agents: RemoteAgentView[]
  machineOf: (a: RemoteAgentView) => RemoteAgentMachineView | undefined
  machines: Map<string, RemoteAgentMachineView>
  onOpen: (a: RemoteAgentView) => void
  onBind: (a: RemoteAgentView) => void
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, RemoteAgentView[]>()
    for (const a of agents) {
      const k = a.binding?.machineId ?? "__unbound"
      ;(m.get(k) ?? m.set(k, []).get(k)!).push(a)
    }
    return m
  }, [agents])
  return (
    <div className="space-y-5">
      {[...grouped.entries()].map(([mid, list]) => {
        const machine = machines.get(mid)
        return (
          <section key={mid} className="space-y-2">
            <div className="text-sm font-medium">
              {machine?.title ?? "未绑定"}
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                {list.length}
              </span>
            </div>
            <div className="space-y-2">
              {list.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  machine={machineOf(a)}
                  onOpen={onOpen}
                  onBind={onBind}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function EmptyState({ onPair }: { onPair: () => void }) {
  const steps = [
    { n: 1, t: "配对主机", d: "在你的机器上启动守护进程" },
    { n: 2, t: "新建 Agent", d: "选择 Claude Code 或 Codex" },
    { n: 3, t: "绑定工作目录", d: "把 Agent 指向一个仓库目录" },
  ]
  return (
    <div className="rounded-2xl border border-dashed p-8 text-center">
      <h2 className="text-base font-semibold">还没有远程 Agent</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        配对一台主机，创建 Agent，绑定工作目录 —— 让 Claude Code / Codex
        作为团队成员为你干活。
      </p>
      <div className="mx-auto mt-5 grid max-w-lg gap-2 sm:grid-cols-3">
        {steps.map((s) => (
          <div key={s.n} className="rounded-xl border p-3 text-left">
            <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
              {s.n}
            </div>
            <div className="mt-2 text-sm font-medium">{s.t}</div>
            <div className="text-xs text-muted-foreground">{s.d}</div>
          </div>
        ))}
      </div>
      <Button className="mt-5" onClick={onPair}>
        <Link2 className="mr-1 size-4" />
        配对第一台主机
      </Button>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-transparent bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}
