"use client"

// Presets-first entry: the common cases as prefilled cards that compile to the
// real cron/interval/at/event config, plus a "start from scratch" escape.
import {
  CalendarClock,
  Clock,
  GitBranch,
  Repeat,
  Sparkles,
  Webhook,
} from "lucide-react"
import type { AutomationEventSource } from "@synapse/shared"
import { emptyDraft, type RuleDraft } from "./types"

interface Preset {
  key: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  desc: string
  build: (sources: AutomationEventSource[]) => RuleDraft
}

const schedulePreset = (
  over: Partial<RuleDraft["trigger"]>,
  name: string
): RuleDraft => ({
  ...emptyDraft(),
  name,
  trigger: { ...emptyDraft().trigger, triggerKind: "schedule", ...over },
})

const eventPreset =
  (
    sourceKey: string,
    matcher: Record<string, unknown>,
    name: string,
    fallbackProvider: AutomationEventSource["providerKind"]
  ) =>
  (sources: AutomationEventSource[]): RuleDraft => {
    const src = sources.find(
      (s) => s.sourceKey === sourceKey && s.status !== "archived"
    )
    const d = emptyDraft()
    return {
      ...d,
      name,
      trigger: {
        ...d.trigger,
        triggerKind: "event",
        eventSourceId: src?.id,
        matcher: src ? matcher : {},
      },
    }
  }

const PRESETS: Preset[] = [
  {
    key: "daily-9",
    icon: Clock,
    title: "每天早上 9 点提醒",
    desc: "每天固定时间往会话发一条消息",
    build: () =>
      schedulePreset(
        { scheduleKind: "cron", scheduleExpr: "0 9 * * *" },
        "每日提醒"
      ),
  },
  {
    key: "weekday-standup",
    icon: CalendarClock,
    title: "工作日站会",
    desc: "周一到周五 9:00 提醒同步",
    build: () =>
      schedulePreset(
        { scheduleKind: "cron", scheduleExpr: "0 9 * * 1-5" },
        "工作日站会提醒"
      ),
  },
  {
    key: "hourly",
    icon: Repeat,
    title: "每小时巡检",
    desc: "每隔一小时触发一次",
    build: () =>
      schedulePreset(
        { scheduleKind: "interval", intervalSeconds: 3600 },
        "每小时巡检"
      ),
  },
  {
    key: "github-push",
    icon: GitBranch,
    title: "GitHub 主分支推送时",
    desc: "监听 push，仅 main 分支触发",
    build: eventPreset(
      "github.push",
      { ref: "refs/heads/main" },
      "主分支推送即通知",
      "integration"
    ),
  },
  {
    key: "webhook",
    icon: Webhook,
    title: "Webhook 触发时",
    desc: "外部系统回调 webhook 即触发",
    build: eventPreset("webhook.deploy-hook", {}, "Webhook 播报", "webhook"),
  },
]

export function PresetGallery({
  sources,
  onPick,
  onScratch,
}: {
  sources: AutomationEventSource[]
  onPick: (draft: RuleDraft) => void
  onScratch: () => void
}) {
  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-muted-foreground">
        从一个常用场景开始，或从空白创建。
      </p>
      <div className="grid gap-2.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPick(p.build(sources))}
            className="group flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <p.icon className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{p.title}</span>
              <span className="block text-xs text-muted-foreground">
                {p.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onScratch}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Sparkles className="size-4" />
        从空白开始
      </button>
    </div>
  )
}
