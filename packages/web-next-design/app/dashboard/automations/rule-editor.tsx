"use client"

// The single-screen automation editor in a Sheet: presets-first for new rules,
// then the "When X → deliver to Y" form (never a wizard/canvas — one fixed
// action). A live When-summary + Save/Cancel anchor the footer.
import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { AutomationRule, AutomationEventSource } from "@synapse/shared"
import type { AutomationRuleCreateInput } from "@synapse/shared/schemas"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { describeDelivery, describeTrigger } from "@/lib/automation/describe"
import { compileDraft, draftError, emptyDraft, type RuleDraft } from "./types"
import { PresetGallery } from "./preset-gallery"
import { SchedulePicker } from "./schedule-picker"
import { EventPicker } from "./event-picker"
import { DeliveryStep } from "./delivery-step"
import { Combobox } from "./combobox"

export interface ConversationOption {
  id: string
  name: string
  members: { id: string; name: string }[]
}

function hydrate(rule: AutomationRule): RuleDraft {
  const t = rule.trigger
  return {
    name: rule.name,
    conversationId: rule.conversationId,
    trigger: {
      triggerKind: t.triggerKind,
      scheduleKind: t.scheduleKind ?? "cron",
      scheduleExpr: t.scheduleExpr,
      scheduleTimezone: t.scheduleTimezone ?? "Asia/Shanghai",
      intervalSeconds: t.intervalSeconds,
      startsAt: t.startsAt,
      eventSourceId: t.eventSourceId,
      matcher: (t.matcher as Record<string, unknown>) ?? {},
    },
    delivery: {
      message: rule.delivery.messageText ?? "",
      wakeEnabled: !!rule.delivery.wakeReasonText,
      wakeReason: rule.delivery.wakeReasonText,
      targetPolicy: rule.delivery.targetPolicy,
      targetParticipantIds: rule.delivery.targetParticipantIds ?? [],
    },
    policy: {
      activeFrom: rule.policy.activeFrom,
      activeUntil: rule.policy.activeUntil,
      maxTriggerCount: rule.policy.maxTriggerCount,
    },
    startPaused: rule.status === "paused",
  }
}

export function RuleEditor({
  open,
  onOpenChange,
  initial,
  conversations,
  sources,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initial?: AutomationRule
  conversations: ConversationOption[]
  sources: AutomationEventSource[]
  onSubmit: (input: AutomationRuleCreateInput) => Promise<void>
}) {
  const [stage, setStage] = useState<"presets" | "form">("presets")
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [advancedPolicy, setAdvancedPolicy] = useState(false)

  // reset each time the sheet opens
  useEffect(() => {
    if (!open) return
    if (initial) {
      setDraft(hydrate(initial))
      setStage("form")
    } else {
      setDraft(emptyDraft())
      setStage("presets")
    }
    setAdvancedPolicy(false)
  }, [open, initial])

  const patchTrigger = (p: Partial<RuleDraft["trigger"]>) =>
    setDraft((d) => ({ ...d, trigger: { ...d.trigger, ...p } }))
  const patchDelivery = (p: Partial<RuleDraft["delivery"]>) =>
    setDraft((d) => ({ ...d, delivery: { ...d.delivery, ...p } }))

  const conv = conversations.find((c) => c.id === draft.conversationId)
  const source = sources.find((s) => s.id === draft.trigger.eventSourceId)
  const err = draftError(draft)

  const summary = useMemo(() => {
    const t = describeTrigger({
      ...draft.trigger,
      eventSourceName: source?.name,
    })
    const d = describeDelivery({
      messageText: draft.delivery.message,
      wakeReasonText: draft.delivery.wakeReason,
      targetPolicy: draft.delivery.targetPolicy,
      targetParticipantIds: draft.delivery.targetParticipantIds,
    })
    return { t, d }
  }, [draft, source])

  const save = async () => {
    if (err) {
      toast.error(err)
      return
    }
    setSaving(true)
    try {
      await onSubmit(compileDraft(draft))
      toast.success(initial ? "已更新自动化" : "已创建自动化")
      onOpenChange(false)
    } catch {
      toast.error("保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>
            {initial
              ? "编辑自动化"
              : stage === "presets"
                ? "新建自动化"
                : "自定义自动化"}
          </SheetTitle>
        </SheetHeader>

        {stage === "presets" ? (
          <ScrollArea className="flex-1">
            <PresetGallery
              sources={sources}
              onPick={(d) => {
                setDraft(d)
                setStage("form")
              }}
              onScratch={() => setStage("form")}
            />
          </ScrollArea>
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-6 p-5">
              {/* name + conversation */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">名称</Label>
                  <Input
                    value={draft.name}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, name: e.target.value }))
                    }
                    placeholder="给这条自动化起个名字"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    投递到会话
                  </Label>
                  <Combobox
                    options={conversations.map((c) => ({
                      value: c.id,
                      label: c.name,
                    }))}
                    value={draft.conversationId}
                    onChange={(v) =>
                      setDraft((d) => ({ ...d, conversationId: v }))
                    }
                    placeholder="选择一个会话"
                    searchPlaceholder="搜索会话…"
                  />
                </div>
              </div>

              {/* When */}
              <section className="space-y-3">
                <div className="text-sm font-semibold">触发条件</div>
                <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-muted p-1">
                  {(["schedule", "event"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => patchTrigger({ triggerKind: k })}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-sm transition",
                        draft.trigger.triggerKind === k
                          ? "bg-background font-medium shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {k === "schedule" ? "定时" : "事件"}
                    </button>
                  ))}
                </div>
                {draft.trigger.triggerKind === "schedule" ? (
                  <SchedulePicker
                    trigger={draft.trigger}
                    patch={patchTrigger}
                  />
                ) : (
                  <EventPicker
                    trigger={draft.trigger}
                    patch={patchTrigger}
                    sources={sources}
                  />
                )}
              </section>

              {/* Deliver */}
              <section className="space-y-3">
                <div className="text-sm font-semibold">投递消息</div>
                <DeliveryStep
                  delivery={draft.delivery}
                  patch={patchDelivery}
                  members={conv?.members ?? []}
                />
              </section>

              {/* Refine */}
              <section>
                <button
                  type="button"
                  onClick={() => setAdvancedPolicy((a) => !a)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition",
                      advancedPolicy && "rotate-180"
                    )}
                  />
                  更多设置（生效时间、最大次数、创建后暂停）
                </button>
                {advancedPolicy && (
                  <div className="mt-3 space-y-3 rounded-lg border p-3">
                    <label className="flex items-center justify-between gap-3 text-sm">
                      最多触发次数
                      <Input
                        type="number"
                        min={1}
                        value={draft.policy.maxTriggerCount ?? ""}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            policy: {
                              ...d.policy,
                              maxTriggerCount: e.target.value
                                ? +e.target.value
                                : undefined,
                            },
                          }))
                        }
                        placeholder="不限"
                        className="h-8 w-28"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-sm">
                      创建后先暂停
                      <Switch
                        checked={draft.startPaused}
                        onCheckedChange={(v) =>
                          setDraft((d) => ({ ...d, startPaused: v }))
                        }
                      />
                    </label>
                  </div>
                )}
              </section>
            </div>
          </ScrollArea>
        )}

        {stage === "form" && (
          <div className="border-t p-4">
            <div className="mb-3 rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <span className="text-foreground/80">{summary.t}</span>
              {conv && (
                <> ，{summary.d.replace("向", `向「${conv.name}」的`)}</>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1 size-4 animate-spin" />}
                {initial ? "保存" : "创建"}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
