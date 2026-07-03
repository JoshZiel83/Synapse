"use client"

// Scope-badged group cards: name, routing chip, enabled/total item ratio, a
// default star, a paused pill — the scope badge is always visible so a
// cross-tenant platform group can never be mistaken for a personal one.
import { Star } from "lucide-react"
import type { ModelGroupDetailView } from "@synapse/shared"
import { cn } from "@/lib/utils"
import {
  getModelGroupScopeMeta,
  getModelGroupStrategyLabel,
} from "../model-group-shared"

export function GroupList({
  groups,
  selectedId,
  onSelect,
}: {
  groups: ModelGroupDetailView[]
  selectedId?: string
  onSelect: (id: string) => void
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground/80">这个作用域还没有模型组</p>
        <p className="mt-1">模型组 = 一组模型绑定 + 路由/故障转移策略。</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const meta = getModelGroupScopeMeta(g.ownerType)
        const enabled = g.items.filter((i) => i.isEnabled).length
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            className={cn(
              "w-full rounded-xl border p-3 text-left transition-colors hover:border-foreground/20",
              g.id === selectedId && "border-primary/50 bg-accent/40",
              !g.isActive && "opacity-70"
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]",
                  meta.badgeClassName
                )}
              >
                <meta.icon className="size-3" />
                {meta.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {g.name}
              </span>
              {g.isDefault && (
                <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded bg-muted px-1.5 py-0.5">
                {getModelGroupStrategyLabel(g.routingStrategy)}
              </span>
              <span>
                {enabled}/{g.items.length} 启用
              </span>
              {!g.isActive && <span className="text-amber-600">已暂停</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
