"use client"

// The redesigned Model Groups workbench. Scope is a first-class segmented
// control (maps 1:1 to the endpoint family — set by path, never a body field);
// master-detail with a scope-badged list and a scope-bannered detail. Replaces
// the 1962-line workbench that flattened all 3 scopes into one undifferentiated
// pile (the named safety bug).
import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Plus, Search } from "lucide-react"
import { toast } from "sonner"
import type {
  ModelGroupDetailView,
  ModelGroupGrantScope,
  ModelGroupItemView,
  ModelGroupRoutingStrategy,
} from "@synapse/shared"
import type { ModelGroupItemCreateInput } from "@synapse/shared/schemas"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { groupApi, SCOPE_TABS, type Scope } from "./mg-api"
import { GroupList } from "./mg-group-list"
import { GroupDetail } from "./mg-group-detail"

export default function ModelGroupsWorkbench() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>("workspace")
  const [selectedId, setSelectedId] = useState<string>()
  const [q, setQ] = useState("")
  const [newOpen, setNewOpen] = useState(false)

  const api = useMemo(
    () => groupApi(scope, workspaceId ?? ""),
    [scope, workspaceId]
  )
  const listKey = ["model-groups", scope, workspaceId]
  const detailKey = ["model-group", scope, selectedId]

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => api.list(),
    enabled: !!workspaceId,
  })
  // The sandbox mock returns full detail views for the list, so the cards can
  // show the item ratio (production's list view omits items — harmless here).
  const groups = (listQuery.data ?? []) as ModelGroupDetailView[]
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? groups.filter((g) => g.name.toLowerCase().includes(n)) : groups
  }, [groups, q])

  useEffect(() => {
    if (groups.length && !groups.some((g) => g.id === selectedId)) {
      setSelectedId(groups[0].id)
    }
  }, [groups, selectedId])

  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: () => api.detail(selectedId!),
    enabled: !!workspaceId && !!selectedId,
  })
  const group = detailQuery.data

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["model-groups", scope, workspaceId] })
    qc.invalidateQueries({ queryKey: ["model-group", scope, selectedId] })
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">模型组</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            模型绑定 + 路由/故障转移策略
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="mr-1 size-4" />
          新建组
        </Button>
      </div>

      {/* scope segmented control */}
      <div className="mb-4 inline-flex gap-1 rounded-lg bg-muted p-1">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.scope}
            type="button"
            onClick={() => setScope(t.scope)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition",
              scope === t.scope
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* list */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索组…"
              className="pl-8"
            />
          </div>
          {listQuery.isPending ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <GroupList
              groups={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>

        {/* detail */}
        <div>
          {group ? (
            <GroupDetail
              group={group}
              activeScope={scope}
              onSaveConfig={async (
                strategy: ModelGroupRoutingStrategy,
                items: ModelGroupItemView[]
              ) => {
                await api.update(group.id, { routingStrategy: strategy })
                await Promise.all(
                  items.map((it) =>
                    api.updateItem(group.id, it.id, {
                      priority: it.priority,
                      weight: it.weight,
                      isEnabled: it.isEnabled,
                    })
                  )
                )
                invalidate()
              }}
              onSaveItem={async (
                input: ModelGroupItemCreateInput,
                itemId?: string
              ) => {
                if (itemId) await api.updateItem(group.id, itemId, input)
                else await api.addItem(group.id, input)
                invalidate()
              }}
              onDeleteItem={async (item: ModelGroupItemView) => {
                await api.deleteItem(group.id, item.id)
                invalidate()
                toast.success("已删除模型")
              }}
              onRevokeGrant={async (grantId: string) => {
                await api.revokeGrant(group.id, grantId)
                invalidate()
              }}
              onIssueGrant={async (
                grantScope: ModelGroupGrantScope,
                actorId?: string
              ) => {
                await api.issueGrant(group.id, { grantScope, actorId })
                invalidate()
              }}
              onSetDefault={async () => {
                await api.update(group.id, { isDefault: true })
                invalidate()
                toast.success("已设为默认组")
              }}
              onToggleActive={async (active: boolean) => {
                await api.update(group.id, { isActive: active })
                invalidate()
              }}
            />
          ) : (
            <div className="rounded-xl border border-dashed py-24 text-center text-sm text-muted-foreground">
              选择左侧的组查看与编辑
            </div>
          )}
        </div>
      </div>

      <NewGroupDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        scopeLabel={SCOPE_TABS.find((t) => t.scope === scope)?.label ?? ""}
        onCreate={async (name, description, routingStrategy) => {
          await api.create({ name, description, routingStrategy })
          invalidate()
          toast.success("已创建组")
        }}
      />
    </div>
  )
}

function NewGroupDialog({
  open,
  onOpenChange,
  scopeLabel,
  onCreate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  scopeLabel: string
  onCreate: (
    name: string,
    description: string,
    routingStrategy: ModelGroupRoutingStrategy
  ) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [desc, setDesc] = useState("")
  const [strategy, setStrategy] =
    useState<ModelGroupRoutingStrategy>("priority_failover")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建模型组 · {scopeLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产主力"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">说明</Label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
            {(
              [
                "priority_failover",
                "weighted_random",
              ] as ModelGroupRoutingStrategy[]
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStrategy(s)}
                className={cn(
                  "rounded-md px-2 py-1.5 text-sm transition",
                  strategy === s
                    ? "bg-background font-medium shadow-sm"
                    : "text-muted-foreground"
                )}
              >
                {s === "priority_failover" ? "优先级故障转移" : "加权随机"}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!name.trim()}
            onClick={async () => {
              await onCreate(name.trim(), desc, strategy)
              onOpenChange(false)
              setName("")
              setDesc("")
            }}
          >
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
