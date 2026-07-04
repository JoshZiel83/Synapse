"use client"

// Skills — a quiet, card-based surface. Two tabs (已安装 default / 市场) with
// IDENTICAL card anatomy, differing only in the primary action; search + filter
// chips reshape the same grid in place. Replaces the lorem-filled table.
import { useMemo, useState } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Download, Plus, Search } from "lucide-react"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { descText, InstalledSkillCard, MarketSkillCard } from "./skill-card"

const GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"

export default function SkillsHub() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState("installed")

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">技能</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            给 AI 团队装配可复用的能力模块
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" asChild>
            <Link href="/dashboard/skills/new?import=1">
              <Download className="mr-1 size-4" />
              导入
            </Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard/skills/new">
              <Plus className="mr-1 size-4" />
              新建技能
            </Link>
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="installed">已安装</TabsTrigger>
          <TabsTrigger value="market">市场</TabsTrigger>
        </TabsList>
        <TabsContent value="installed" className="mt-4">
          {workspaceId && <InstalledTab workspaceId={workspaceId} />}
        </TabsContent>
        <TabsContent value="market" className="mt-4">
          {workspaceId && <MarketTab workspaceId={workspaceId} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

type InstalledFilter = "all" | "enabled" | "disabled" | "upgrade"

function InstalledTab({ workspaceId }: { workspaceId: string }) {
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<InstalledFilter>("all")
  const query = useQuery({
    queryKey: ["installed-skills", workspaceId],
    queryFn: () => api.getInstalledSkills(workspaceId),
  })
  const skills = query.data?.skills ?? []
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return skills.filter((s) => {
      if (filter === "enabled" && !s.isEnabled) return false
      if (filter === "disabled" && s.isEnabled) return false
      if (
        filter === "upgrade" &&
        !s.upgradeAvailable &&
        s.mirrorSource?.lastSyncStatus !== "error"
      )
        return false
      if (
        n &&
        !`${s.displayName} ${descText(s.description)} ${s.tags.join(" ")}`
          .toLowerCase()
          .includes(n)
      )
        return false
      return true
    })
  }, [skills, q, filter])

  return (
    <div className="space-y-3">
      <Toolbar q={q} setQ={setQ}>
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          全部
        </FilterChip>
        <FilterChip
          active={filter === "enabled"}
          onClick={() => setFilter("enabled")}
        >
          已启用
        </FilterChip>
        <FilterChip
          active={filter === "disabled"}
          onClick={() => setFilter("disabled")}
        >
          已停用
        </FilterChip>
        <FilterChip
          active={filter === "upgrade"}
          onClick={() => setFilter("upgrade")}
        >
          有更新 / 需同步
        </FilterChip>
      </Toolbar>
      {query.isPending ? (
        <GridSkeleton />
      ) : skills.length === 0 ? (
        <Empty>
          还没有技能 ·{" "}
          <Link
            href="/dashboard/skills/new"
            className="text-primary hover:underline"
          >
            新建
          </Link>{" "}
          或去市场安装
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty>没有符合条件的技能</Empty>
      ) : (
        <div className={GRID}>
          {filtered.map((s) => (
            <InstalledSkillCard key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  )
}

function MarketTab({ workspaceId }: { workspaceId: string }) {
  const [q, setQ] = useState("")
  const query = useQuery({
    queryKey: ["skill-marketplace", workspaceId],
    queryFn: () => api.getSkillMarketplace({ workspaceId }),
  })
  const skills = query.data?.skills ?? []
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return skills
    return skills.filter((s) =>
      `${s.name} ${descText(s.description)} ${s.tags.join(" ")}`
        .toLowerCase()
        .includes(n)
    )
  }, [skills, q])

  return (
    <div className="space-y-3">
      <Toolbar q={q} setQ={setQ} />
      {query.isPending ? (
        <GridSkeleton />
      ) : filtered.length === 0 ? (
        <Empty>
          没有匹配的技能 ·{" "}
          <Link
            href="/dashboard/skills/new"
            className="text-primary hover:underline"
          >
            新建你自己的
          </Link>
        </Empty>
      ) : (
        <div className={GRID}>
          {filtered.map((s) => (
            <MarketSkillCard key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  )
}

function Toolbar({
  q,
  setQ,
  children,
}: {
  q: string
  setQ: (v: string) => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-52 flex-1">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索技能…"
          className="h-9 pl-8"
        />
      </div>
      {children}
    </div>
  )
}

function FilterChip({
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
        "rounded-full border px-2.5 py-1 text-xs transition",
        active
          ? "border-transparent bg-secondary text-secondary-foreground"
          : "border-transparent bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function GridSkeleton() {
  return (
    <div className={GRID}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-xl border bg-card p-4"
        >
          <div className="size-10 shrink-0 animate-pulse rounded-xl bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
