"use client"

// Redesigned per-actor model-assignment board. An actor's ordered failover
// CHAIN of grant-visible groups, with ACCESSIBLE reorder (Move up/down buttons +
// keyboard, never 3px mouse-only DnD), a floor tag, provenance chips, a resolved-
// precedence panel, and — critically — EXPLICIT save with a diff preview (fixing
// the old autosave-only + fully-silent-failure design).
import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Search,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"
import type {
  Actor,
  ActorModelGroupAssignmentView,
  ModelGroupDetailView,
  ModelGroupOwnerType,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/info-tip"
import {
  getModelGroupScopeMeta,
  getModelGroupStrategyLabel,
} from "../model-group-shared"

interface ChainEntry {
  groupId: string
  groupName: string
  routingStrategy: string
  ownerType: ModelGroupOwnerType
}

const toEntry = (a: ActorModelGroupAssignmentView): ChainEntry => ({
  groupId: a.groupId,
  groupName: a.groupName,
  routingStrategy: a.routingStrategy,
  ownerType: a.ownerType,
})

export default function ActorBoard() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [actorId, setActorId] = useState<string>()

  const actorsQuery = useQuery({
    queryKey: ["actors", workspaceId],
    queryFn: () => api.getActors(workspaceId!),
    enabled: !!workspaceId,
  })
  const actors = (actorsQuery.data ?? []) as Actor[]
  const filteredActors = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n
      ? actors.filter((a) => a.displayName.toLowerCase().includes(n))
      : actors
  }, [actors, q])
  useEffect(() => {
    if (actors.length && !actors.some((a) => a.id === actorId))
      setActorId(actors[0].id)
  }, [actors, actorId])

  const selected = actors.find((a) => a.id === actorId)

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Actor 模型指派</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          为 Actor 指派模型组的故障转移顺序
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* actor list */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 Actor…"
              className="pl-8"
            />
          </div>
          {actorsQuery.isPending ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredActors.length === 0 ? (
            <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
              没有 Actor
            </div>
          ) : (
            <div className="space-y-1.5">
              {filteredActors.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setActorId(a.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border p-2.5 text-left transition-colors hover:border-foreground/20",
                    a.id === actorId && "border-primary/50 bg-accent/40"
                  )}
                >
                  <span className="text-lg">
                    {a.definition.avatarEmoji ?? "🤖"}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {a.displayName}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* chain editor */}
        <div>
          {selected && workspaceId ? (
            <ChainEditor
              key={selected.id}
              workspaceId={workspaceId}
              actor={selected}
              onSaved={() =>
                qc.invalidateQueries({
                  queryKey: ["actor-chain", workspaceId, selected.id],
                })
              }
            />
          ) : (
            <div className="rounded-xl border border-dashed py-24 text-center text-sm text-muted-foreground">
              选择左侧的 Actor 配置模型链
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ChainEditor({
  workspaceId,
  actor,
  onSaved,
}: {
  workspaceId: string
  actor: Actor
  onSaved: () => void
}) {
  const chainQuery = useQuery({
    queryKey: ["actor-chain", workspaceId, actor.id],
    queryFn: () => api.getActorModelGroups(workspaceId, actor.id),
  })
  const poolQuery = useQuery({
    queryKey: ["actor-visible-groups", workspaceId, actor.id],
    queryFn: () => api.getVisibleActorModelGroups(workspaceId, actor.id),
  })
  const persisted = useMemo(
    () =>
      (chainQuery.data ?? [])
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .map(toEntry),
    [chainQuery.data]
  )
  const pool = (poolQuery.data ?? []) as ModelGroupDetailView[]

  const [chain, setChain] = useState<ChainEntry[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => setChain(persisted), [persisted])

  const dirty =
    JSON.stringify(chain.map((c) => c.groupId)) !==
    JSON.stringify(persisted.map((c) => c.groupId))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= chain.length) return
    const next = [...chain]
    ;[next[i], next[j]] = [next[j], next[i]]
    setChain(next)
  }
  const remove = (id: string) =>
    setChain((c) => c.filter((x) => x.groupId !== id))
  const add = (g: ModelGroupDetailView) =>
    setChain((c) => [
      ...c,
      {
        groupId: g.id,
        groupName: g.name,
        routingStrategy: g.routingStrategy,
        ownerType: g.ownerType,
      },
    ])

  const singleProvider = chain.length === 1

  const save = async () => {
    setSaving(true)
    try {
      await api.setActorModelGroups(
        workspaceId,
        actor.id,
        chain.map((c, i) => ({ groupId: c.groupId, priority: i }))
      )
      onSaved()
      toast.success(
        chain.length === persisted.length && !dirty ? "无改动" : "已保存模型链"
      )
    } catch {
      toast.error("保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  if (chainQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const available = pool.filter((g) => !chain.some((c) => c.groupId === g.id))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">模型链</span>
          <span className="text-xs text-muted-foreground">{chain.length}</span>
          <InfoTip
            label="解析优先级说明"
            text="解析顺序：Actor 链 → 成员默认 → 工作区默认 → 平台默认。设置了链就会覆盖各级默认。"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
          disabled={available.length === 0}
        >
          <Plus className="mr-1 size-3.5" />
          添加组
        </Button>
      </div>

      {singleProvider && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          链里只有一个组，建议再加一个不同提供方的组作为兜底，避免单点故障。
        </div>
      )}

      {chain.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground/80">未指派模型组</p>
          <p className="mt-1">
            当前回退到工作区 / 平台默认组。点「添加组」为该 Actor 指定专属顺序。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {chain.map((c, i) => {
            const meta = getModelGroupScopeMeta(c.ownerType)
            return (
              <li
                key={c.groupId}
                className="flex items-center gap-2 rounded-xl border p-3"
              >
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label={`上移 ${c.groupName}`}
                    className="text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={i === chain.length - 1}
                    aria-label={`下移 ${c.groupName}`}
                    className="text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="size-4" />
                  </button>
                </div>
                <span className="w-5 text-center text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {c.groupName}
                    {i === chain.length - 1 && chain.length > 1 && (
                      <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        兜底
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span
                      className={cn(
                        "flex items-center gap-0.5 rounded-full border px-1.5 py-0.5",
                        meta.badgeClassName
                      )}
                    >
                      <meta.icon className="size-2.5" />
                      {meta.label}
                    </span>
                    <span>{getModelGroupStrategyLabel(c.routingStrategy)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(c.groupId)}
                  aria-label={`移除 ${c.groupName}`}
                  className="text-muted-foreground/50 hover:text-red-600"
                >
                  <X className="size-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* sticky save */}
      <div className="flex items-center justify-end gap-3 border-t pt-3">
        {dirty && (
          <span className="text-xs text-amber-600">有未保存的修改</span>
        )}
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setChain(persisted)}>
            撤销
          </Button>
        )}
        <Button onClick={save} disabled={saving || !dirty}>
          {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
          保存链
        </Button>
      </div>

      <AddGroupDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groups={available}
        onAdd={add}
      />
    </div>
  )
}

function AddGroupDialog({
  open,
  onOpenChange,
  groups,
  onAdd,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  groups: ModelGroupDetailView[]
  onAdd: (g: ModelGroupDetailView) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加模型组</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          只列出该 Actor 有权使用（已授权）的组。
        </p>
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {groups.map((g) => {
            const meta = getModelGroupScopeMeta(g.ownerType)
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => {
                  onAdd(g)
                  onOpenChange(false)
                }}
                className="flex w-full items-center gap-2 rounded-lg border p-2.5 text-left hover:border-primary/40 hover:bg-accent/30"
              >
                <span
                  className={cn(
                    "flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px]",
                    meta.badgeClassName
                  )}
                >
                  <meta.icon className="size-2.5" />
                  {meta.label}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {g.name}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {getModelGroupStrategyLabel(g.routingStrategy)}
                </span>
              </button>
            )
          })}
          {groups.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              没有更多可添加的组
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
