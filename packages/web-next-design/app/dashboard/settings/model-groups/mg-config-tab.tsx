"use client"

// Config tab: the routing strategy + its items as ONE runtime unit. The per-item
// knob is context-conditional on the strategy — reorderable priority chain for
// priority_failover (accessible Move up/down, last = floor), weight sliders with
// live % share for weighted_random. The strategy explainer lives behind an info
// icon (progressive disclosure). attemptPolicy is a REAL editable advanced panel
// (a supported ModelGroupUpdateInput field that drives the failover loop), not a
// static display.
import { useEffect, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { InfoTip } from "@/components/info-tip"

type Strategy = ModelGroupRoutingStrategy

interface Policy {
  maxAttemptsTotal: number
  maxAttemptsPerBinding: number
  timeoutSec: number
  continueOn: string[]
  stopOn: string[]
}
const DEFAULT_POLICY: Policy = {
  maxAttemptsTotal: 4,
  maxAttemptsPerBinding: 2,
  timeoutSec: 300,
  continueOn: ["rate_limit", "5xx", "timeout", "network"],
  stopOn: ["auth_error", "bad_request", "policy_block"],
}
const CONTINUE_OPTS: [string, string][] = [
  ["rate_limit", "限流"],
  ["5xx", "5xx"],
  ["timeout", "超时"],
  ["network", "网络错误"],
]
const STOP_OPTS: [string, string][] = [
  ["auth_error", "鉴权错误"],
  ["bad_request", "错误请求"],
  ["policy_block", "策略拦截"],
]

function policyFromGroup(g: ModelGroupDetailView): Policy {
  const p = (g.attemptPolicy ?? {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === "number" ? v : d)
  const arr = (v: unknown, d: string[]) =>
    Array.isArray(v) ? (v as string[]) : d
  return {
    maxAttemptsTotal: num(p.maxAttemptsTotal, DEFAULT_POLICY.maxAttemptsTotal),
    maxAttemptsPerBinding: num(
      p.maxAttemptsPerBinding,
      DEFAULT_POLICY.maxAttemptsPerBinding
    ),
    timeoutSec: p.timeoutMsPerAttempt
      ? Math.round(num(p.timeoutMsPerAttempt, 300000) / 1000)
      : DEFAULT_POLICY.timeoutSec,
    continueOn: arr(p.continueOn, DEFAULT_POLICY.continueOn),
    stopOn: arr(p.stopOn, DEFAULT_POLICY.stopOn),
  }
}
const isDefaultPolicy = (p: Policy) =>
  JSON.stringify(p) === JSON.stringify(DEFAULT_POLICY)

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
  onSave: (
    strategy: Strategy,
    items: ModelGroupItemView[],
    attemptPolicy: Record<string, unknown>
  ) => Promise<void>
}) {
  const [strategy, setStrategy] = useState<Strategy>(group.routingStrategy)
  const [items, setItems] = useState<ModelGroupItemView[]>(group.items)
  const [policy, setPolicy] = useState<Policy>(() => policyFromGroup(group))
  const [saving, setSaving] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)

  useEffect(() => {
    setStrategy(group.routingStrategy)
    setItems(group.items)
    setPolicy(policyFromGroup(group))
  }, [group])

  const dirty =
    strategy !== group.routingStrategy ||
    JSON.stringify(policy) !== JSON.stringify(policyFromGroup(group)) ||
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

  const patchPolicy = (p: Partial<Policy>) =>
    setPolicy((prev) => ({ ...prev, ...p }))
  const toggleClass = (field: "continueOn" | "stopOn", key: string) =>
    setPolicy((prev) => ({
      ...prev,
      [field]: prev[field].includes(key)
        ? prev[field].filter((k) => k !== key)
        : [...prev[field], key],
    }))

  const save = async () => {
    setSaving(true)
    try {
      await onSave(strategy, items, {
        maxAttemptsTotal: policy.maxAttemptsTotal,
        maxAttemptsPerBinding: policy.maxAttemptsPerBinding,
        timeoutMsPerAttempt: policy.timeoutSec * 1000,
        continueOn: policy.continueOn,
        stopOn: policy.stopOn,
      })
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
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">路由策略</span>
          <InfoTip
            text={
              strategy === "priority_failover"
                ? "从上到下依次尝试，第一个成功的胜出。"
                : "按权重比例随机选主，失败再按顺序回退。"
            }
          />
        </div>
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

      {/* attempt policy — a real supported group setting */}
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
            {isDefaultPolicy(policy) ? "默认" : "自定义"}
          </span>
        </button>
        {policyOpen && (
          <div className="space-y-4 border-t p-3">
            <div className="grid grid-cols-3 gap-3">
              <PolicyNum
                label="总尝试上限"
                value={policy.maxAttemptsTotal}
                onChange={(v) => patchPolicy({ maxAttemptsTotal: v })}
                disabled={readOnly}
              />
              <PolicyNum
                label="每模型上限"
                value={policy.maxAttemptsPerBinding}
                onChange={(v) => patchPolicy({ maxAttemptsPerBinding: v })}
                disabled={readOnly}
              />
              <PolicyNum
                label="单次超时(秒)"
                value={policy.timeoutSec}
                onChange={(v) => patchPolicy({ timeoutSec: v })}
                disabled={readOnly}
              />
            </div>
            <ClassRow
              label="换下一个模型"
              opts={CONTINUE_OPTS}
              active={policy.continueOn}
              tone="emerald"
              onToggle={(k) => toggleClass("continueOn", k)}
              disabled={readOnly}
            />
            <ClassRow
              label="立即失败(不转移)"
              opts={STOP_OPTS}
              active={policy.stopOn}
              tone="red"
              onToggle={(k) => toggleClass("stopOn", k)}
              disabled={readOnly}
            />
            {!readOnly && !isDefaultPolicy(policy) && (
              <button
                type="button"
                onClick={() => setPolicy(DEFAULT_POLICY)}
                className="text-xs text-primary hover:underline"
              >
                恢复默认
              </button>
            )}
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

function PolicyNum({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(e) => onChange(Math.max(1, +e.target.value || 1))}
        disabled={disabled}
        className="h-8"
      />
    </div>
  )
}

function ClassRow({
  label,
  opts,
  active,
  tone,
  onToggle,
  disabled,
}: {
  label: string
  opts: [string, string][]
  active: string[]
  tone: "emerald" | "red"
  onToggle: (key: string) => void
  disabled: boolean
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">遇到以下情况{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {opts.map(([key, cn2]) => {
          const on = active.includes(key)
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(key)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] transition",
                on &&
                  tone === "emerald" &&
                  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
                on &&
                  tone === "red" &&
                  "border-red-500/30 bg-red-500/10 text-red-600",
                !on &&
                  "border-transparent bg-muted text-muted-foreground/60 hover:text-muted-foreground"
              )}
            >
              {cn2}
            </button>
          )
        })}
      </div>
    </div>
  )
}
