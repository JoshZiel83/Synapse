"use client"

// Config tab: the routing strategy + its items as ONE runtime unit. The per-item
// knob is context-conditional on the strategy — reorderable priority chain for
// priority_failover (accessible Move up/down, last = floor), weight sliders with
// live % share for weighted_random — fixing "priority AND weight always shown +
// unexplained". attemptPolicy sits in its own collapsed container with defaults.
import { useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import type {
  ModelGroupDetailView,
  ModelGroupItemView,
  ModelGroupRoutingStrategy,
} from "@synapse/shared"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

type Strategy = ModelGroupRoutingStrategy

export function ConfigTab({
  group,
  readOnly,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onSave,
}: {
  group: ModelGroupDetailView
  readOnly: boolean
  onAddItem: () => void
  onEditItem: (item: ModelGroupItemView) => void
  onDeleteItem: (item: ModelGroupItemView) => void
  onSave: (strategy: Strategy, items: ModelGroupItemView[]) => Promise<void>
}) {
  const [strategy, setStrategy] = useState<Strategy>(group.routingStrategy)
  const [items, setItems] = useState<ModelGroupItemView[]>(group.items)
  const [saving, setSaving] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)

  useEffect(() => {
    setStrategy(group.routingStrategy)
    setItems(group.items)
  }, [group])

  const dirty =
    strategy !== group.routingStrategy ||
    JSON.stringify(
      items.map((i) => [i.id, i.priority, i.weight, i.isEnabled])
    ) !==
      JSON.stringify(
        group.items.map((i) => [i.id, i.priority, i.weight, i.isEnabled])
      )

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...items]
    const j = idx + dir
    if (j < 0 || j >= next.length) return
    ;[next[idx], next[j]] = [next[j], next[idx]]
    setItems(next.map((it, i) => ({ ...it, priority: i })))
  }
  const setWeight = (id: string, weight: number) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, weight } : it))
    )
  const toggleEnabled = (id: string, on: boolean) =>
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, isEnabled: on } : it))
    )

  const totalWeight = items.reduce((s, it) => s + Math.max(1, it.weight), 0)

  const save = async () => {
    setSaving(true)
    try {
      await onSave(strategy, items)
      toast.success("已保存")
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* strategy */}
      <div className="space-y-2">
        <div className="text-sm font-medium">路由策略</div>
        <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
          {(["priority_failover", "weighted_random"] as Strategy[]).map((s) => (
            <button
              key={s}
              type="button"
              disabled={readOnly}
              onClick={() => setStrategy(s)}
              className={cn(
                "rounded-md px-2 py-1.5 text-sm transition",
                strategy === s
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s === "priority_failover" ? "优先级故障转移" : "加权随机"}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {strategy === "priority_failover"
            ? "从上到下依次尝试，第一个成功的胜出。"
            : "按权重比例随机选主，失败再按顺序回退。"}
        </p>
      </div>

      {/* items */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">模型（{items.length}）</div>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={onAddItem}>
              <Plus className="mr-1 size-3.5" />
              添加模型
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {items.map((it, idx) => (
            <div
              key={it.id}
              className={cn(
                "rounded-lg border p-3",
                !it.isEnabled && "opacity-60"
              )}
            >
              <div className="flex items-center gap-2">
                {strategy === "priority_failover" && !readOnly && (
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0}
                      aria-label="上移"
                      className="text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={idx === items.length - 1}
                      aria-label="下移"
                      className="text-muted-foreground/50 hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="size-4" />
                    </button>
                  </div>
                )}
                {strategy === "priority_failover" && (
                  <span className="w-5 text-center text-xs font-medium text-muted-foreground">
                    {idx + 1}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {it.displayName}
                    {strategy === "priority_failover" &&
                      idx === items.length - 1 &&
                      items.length > 1 && (
                        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                          兜底
                        </span>
                      )}
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {it.vendor} · {it.modelName}
                  </div>
                </div>
                <Switch
                  checked={it.isEnabled}
                  onCheckedChange={(v) => toggleEnabled(it.id, v)}
                  disabled={readOnly}
                  aria-label="启用"
                />
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => onEditItem(it)}
                      aria-label="编辑"
                      className="text-muted-foreground/50 hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteItem(it)}
                      aria-label="删除"
                      className="text-muted-foreground/50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </>
                )}
              </div>

              {strategy === "weighted_random" && (
                <div className="mt-2 flex items-center gap-3 pl-1">
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    value={it.weight}
                    onChange={(e) => setWeight(it.id, +e.target.value)}
                    disabled={readOnly}
                    className="h-1.5 flex-1 accent-primary"
                  />
                  <span className="w-24 text-right text-xs text-muted-foreground tabular-nums">
                    权重 {it.weight} · ≈
                    {Math.round((Math.max(1, it.weight) / totalWeight) * 100)}%
                  </span>
                </div>
              )}
            </div>
          ))}
          {items.length === 0 && (
            <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              还没有模型，点「添加模型」开始。
            </div>
          )}
        </div>
      </div>

      {/* attempt policy */}
      <div className="rounded-lg border">
        <button
          type="button"
          onClick={() => setPolicyOpen((o) => !o)}
          className="flex w-full items-center gap-1 px-3 py-2.5 text-sm font-medium"
        >
          <ChevronDown
            className={cn("size-4 transition", policyOpen && "rotate-180")}
          />
          重试与故障转移策略
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            默认
          </span>
        </button>
        {policyOpen && (
          <div className="space-y-3 border-t p-3 text-sm">
            <div className="text-xs text-muted-foreground">重试</div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>总尝试上限：4</span>
              <span>每模型上限：2</span>
              <span>单次超时：5 分钟</span>
              <span>退避：0 / 1s / 3s</span>
            </div>
            <div className="text-xs text-muted-foreground">
              遇到以下情况换下一个模型
            </div>
            <div className="flex flex-wrap gap-2">
              {["限流", "5xx", "超时", "网络错误"].map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              遇到以下情况立即失败（不转移）
            </div>
            <div className="flex flex-wrap gap-2">
              {["鉴权错误", "错误请求", "策略拦截"].map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-600"
                >
                  {t}
                </span>
              ))}
            </div>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
            >
              恢复默认
            </button>
          </div>
        )}
      </div>

      {/* save */}
      {!readOnly && (
        <div className="flex items-center justify-end gap-2 border-t pt-3">
          {dirty && (
            <span className="text-xs text-amber-600">有未保存的修改</span>
          )}
          <Button onClick={save} disabled={saving || !dirty}>
            {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
            保存
          </Button>
        </div>
      )}
    </div>
  )
}
