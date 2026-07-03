"use client"

// Event branch: subscribe to exactly one reusable event source, then filter its
// occurrences with the matcher builder driven by that source's example payload.
import { useState } from "react"
import { Plus } from "lucide-react"
import type { AutomationEventSource } from "@synapse/shared"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { InfoTip } from "@/components/info-tip"
import {
  PROVIDER_KIND_LABEL,
  SOURCE_STATUS_LABEL,
} from "@/lib/automation/describe"
import type { RuleDraft } from "./types"
import { Combobox } from "./combobox"
import { MatcherBuilder } from "./matcher-builder"
import { SourceRegisterDialog } from "./source-register-dialog"

type Trig = RuleDraft["trigger"]
type Patch = (p: Partial<Trig>) => void

export function EventPicker({
  trigger,
  patch,
  sources,
}: {
  trigger: Trig
  patch: Patch
  sources: AutomationEventSource[]
}) {
  const [registerOpen, setRegisterOpen] = useState(false)
  // subscribing requires an active source
  const selectable = sources.filter((s) => s.status !== "archived")
  const selected = sources.find((s) => s.id === trigger.eventSourceId)

  const options = selectable.map((s) => ({
    value: s.id,
    label: s.name,
    hint: PROVIDER_KIND_LABEL[s.providerKind],
    group: s.providerKind,
  }))

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Label className="text-xs text-muted-foreground">事件源</Label>
            <InfoTip text="事件为实时触发，仅匹配订阅之后发生的事件。" />
          </div>
          <button
            type="button"
            onClick={() => setRegisterOpen(true)}
            className="flex items-center gap-0.5 text-xs text-primary hover:underline"
          >
            <Plus className="size-3" />
            注册新源
          </button>
        </div>
        <Combobox
          options={options}
          value={trigger.eventSourceId}
          onChange={(v) => patch({ eventSourceId: v, matcher: {} })}
          placeholder="选择一个事件源"
          searchPlaceholder="搜索事件源…"
          renderOption={(o) => {
            const src = sources.find((s) => s.id === o.value)
            return (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{o.label}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {o.hint}
                  </Badge>
                  {src && src.status !== "active" && (
                    <span className="shrink-0 text-[10px] text-amber-600">
                      {SOURCE_STATUS_LABEL[src.status]}
                    </span>
                  )}
                </span>
                {src?.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {src.description}
                  </span>
                )}
              </span>
            )
          }}
        />
      </div>

      {selected ? (
        <>
          {selected.recommendedUsage && (
            <p className="text-xs text-muted-foreground">
              {selected.recommendedUsage}
            </p>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Label className="text-xs text-muted-foreground">匹配条件</Label>
              <InfoTip text="仅当事件里勾选的字段完全相等时才触发；不勾选任何字段则每次都触发。" />
            </div>
            <MatcherBuilder
              examplePayload={selected.examplePayload}
              matcher={trigger.matcher}
              onChange={(m) => patch({ matcher: m })}
            />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          先选择一个事件源，再设置匹配条件。
        </div>
      )}

      <SourceRegisterDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
      />
    </div>
  )
}
