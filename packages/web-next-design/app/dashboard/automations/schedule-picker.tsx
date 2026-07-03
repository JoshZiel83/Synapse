"use client"

// Schedule branch: friendly presets (compiled to real 5-field cron / interval
// seconds / one-shot) with an Advanced reveal of the raw primitives — two
// round-trippable views of one value — plus the always-visible next-runs check.
import { useMemo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  cronToPreset,
  describeCron,
  intervalToSeconds,
  isValidCron,
  listTimezones,
  presetToCron,
  secondsToInterval,
  type CronPreset,
  type IntervalUnit,
} from "@/lib/automation/schedule"
import type { RuleDraft } from "./types"
import { NextRuns } from "./next-runs"
import { Combobox } from "./combobox"

type Trig = RuleDraft["trigger"]
type Patch = (p: Partial<Trig>) => void

const SEG: { kind: Trig["scheduleKind"]; label: string; hint: string }[] = [
  { kind: "cron", label: "重复", hint: "按周期反复运行" },
  { kind: "interval", label: "间隔", hint: "每隔一段时间" },
  { kind: "at", label: "一次", hint: "在某个时刻运行一次" },
]

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

export function SchedulePicker({
  trigger,
  patch,
}: {
  trigger: Trig
  patch: Patch
}) {
  const [advanced, setAdvanced] = useState(false)
  const tzOptions = useMemo(
    () => listTimezones().map((t) => ({ value: t, label: t })),
    []
  )

  return (
    <div className="space-y-4">
      {/* segmented kind */}
      <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted p-1">
        {SEG.map((s) => (
          <button
            key={s.kind}
            type="button"
            onClick={() => {
              const p: Partial<Trig> = { scheduleKind: s.kind }
              if (s.kind === "cron" && !trigger.scheduleExpr) {
                p.scheduleExpr = "0 9 * * *"
                p.scheduleTimezone = trigger.scheduleTimezone ?? "Asia/Shanghai"
              }
              if (s.kind === "interval" && !trigger.intervalSeconds)
                p.intervalSeconds = 300
              patch(p)
            }}
            className={cn(
              "rounded-md px-2 py-1.5 text-center text-sm transition",
              trigger.scheduleKind === s.kind
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {trigger.scheduleKind === "cron" && (
        <CronEditor trigger={trigger} patch={patch} advanced={advanced} />
      )}
      {trigger.scheduleKind === "interval" && (
        <IntervalEditor trigger={trigger} patch={patch} />
      )}
      {trigger.scheduleKind === "at" && (
        <AtEditor trigger={trigger} patch={patch} />
      )}

      {/* timezone (cron + at) */}
      {trigger.scheduleKind !== "interval" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">时区</Label>
          <Combobox
            options={tzOptions}
            value={trigger.scheduleTimezone}
            onChange={(v) => patch({ scheduleTimezone: v })}
            placeholder="选择时区"
            searchPlaceholder="搜索时区…"
          />
        </div>
      )}

      <NextRuns value={trigger} />

      {trigger.scheduleKind === "cron" && (
        <div>
          <button
            type="button"
            onClick={() => setAdvanced((a) => !a)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-3.5 transition", advanced && "rotate-180")}
            />
            高级：原始 cron 表达式
          </button>
          {advanced && <RawCron trigger={trigger} patch={patch} />}
        </div>
      )}
    </div>
  )
}

// ── Recurring (cron via presets) ─────────────────────────────────────────────
type PresetEvery = CronPreset["every"]
const PRESET_CHIPS: { every: PresetEvery; label: string }[] = [
  { every: "hour", label: "每小时" },
  { every: "day", label: "每天" },
  { every: "weekdays", label: "工作日" },
  { every: "week", label: "每周" },
  { every: "month", label: "每月" },
]

function CronEditor({
  trigger,
  patch,
  advanced,
}: {
  trigger: Trig
  patch: Patch
  advanced: boolean
}) {
  const preset = trigger.scheduleExpr
    ? cronToPreset(trigger.scheduleExpr)
    : null
  const every = preset?.every ?? "day"
  const time = preset && "time" in preset ? preset.time : "09:00"

  const setPreset = (p: CronPreset) => patch({ scheduleExpr: presetToCron(p) })

  const changeEvery = (e: PresetEvery) => {
    if (e === "hour") setPreset({ every: "hour", minute: 0 })
    else if (e === "day") setPreset({ every: "day", time })
    else if (e === "weekdays") setPreset({ every: "weekdays", time })
    else if (e === "week")
      setPreset({
        every: "week",
        days: preset?.every === "week" ? preset.days : [1],
        time,
      })
    else
      setPreset({
        every: "month",
        day: preset?.every === "month" ? preset.day : 1,
        time,
      })
  }

  if (!preset && trigger.scheduleExpr && advanced) {
    return (
      <div className="rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 text-xs text-amber-700 dark:bg-amber-500/5">
        当前表达式较复杂，正在高级模式下编辑（见下方原始 cron）。
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESET_CHIPS.map((c) => (
          <button
            key={c.every}
            type="button"
            onClick={() => changeEvery(c.every)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition",
              every === c.every
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-border text-muted-foreground hover:border-foreground/30"
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {every === "hour" && (
          <label className="flex items-center gap-2 text-sm">
            每小时的第
            <Input
              type="number"
              min={0}
              max={59}
              value={preset?.every === "hour" ? preset.minute : 0}
              onChange={(e) =>
                setPreset({
                  every: "hour",
                  minute: clamp(+e.target.value, 0, 59),
                })
              }
              className="h-8 w-16"
            />
            分钟
          </label>
        )}
        {(every === "day" ||
          every === "weekdays" ||
          every === "week" ||
          every === "month") && (
          <label className="flex items-center gap-2 text-sm">
            时间
            <Input
              type="time"
              value={time}
              onChange={(e) => {
                const t = e.target.value || "09:00"
                if (every === "week")
                  setPreset({
                    every: "week",
                    days: preset?.every === "week" ? preset.days : [1],
                    time: t,
                  })
                else if (every === "month")
                  setPreset({
                    every: "month",
                    day: preset?.every === "month" ? preset.day : 1,
                    time: t,
                  })
                else setPreset({ every, time: t } as CronPreset)
              }}
              className="h-8 w-32"
            />
          </label>
        )}
        {every === "month" && (
          <label className="flex items-center gap-2 text-sm">
            每月
            <Input
              type="number"
              min={1}
              max={31}
              value={preset?.every === "month" ? preset.day : 1}
              onChange={(e) =>
                setPreset({
                  every: "month",
                  day: clamp(+e.target.value, 1, 31),
                  time,
                })
              }
              className="h-8 w-16"
            />
            号
          </label>
        )}
      </div>

      {every === "week" && (
        <div className="flex gap-1.5">
          {WEEKDAYS.map((w, i) => {
            const days = preset?.every === "week" ? preset.days : []
            const on = days.includes(i)
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  const next = on ? days.filter((d) => d !== i) : [...days, i]
                  setPreset({
                    every: "week",
                    days: next.length ? next : [i],
                    time,
                  })
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border text-sm transition",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-foreground/30"
                )}
              >
                {w}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RawCron({ trigger, patch }: { trigger: Trig; patch: Patch }) {
  const expr = trigger.scheduleExpr ?? ""
  const valid = expr.trim()
    ? isValidCron(expr, trigger.scheduleTimezone)
    : false
  return (
    <div className="mt-2 space-y-1.5">
      <div className="grid grid-cols-5 gap-1 text-center text-[10px] text-muted-foreground/60">
        <span>分</span>
        <span>时</span>
        <span>日</span>
        <span>月</span>
        <span>周</span>
      </div>
      <Input
        value={expr}
        onChange={(e) => patch({ scheduleExpr: e.target.value })}
        placeholder="0 9 * * 1-5"
        className={cn(
          "font-mono",
          !valid && expr.trim() && "border-destructive"
        )}
      />
      <p className="text-xs text-muted-foreground">
        {valid
          ? describeCron(expr)
          : "标准 5 段 cron（不支持秒、@daily 宏、Quartz ?）"}
      </p>
    </div>
  )
}

// ── Interval ─────────────────────────────────────────────────────────────────
const UNIT_LABEL: Record<IntervalUnit, string> = {
  minute: "分钟",
  hour: "小时",
  day: "天",
}
function IntervalEditor({ trigger, patch }: { trigger: Trig; patch: Patch }) {
  const iv = trigger.intervalSeconds
    ? secondsToInterval(trigger.intervalSeconds)
    : { value: 5, unit: "minute" as IntervalUnit }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm">每隔</span>
        <Input
          type="number"
          min={1}
          value={iv.value}
          onChange={(e) =>
            patch({
              intervalSeconds: intervalToSeconds(
                Math.max(1, +e.target.value),
                iv.unit
              ),
            })
          }
          className="h-9 w-20"
        />
        <Select
          value={iv.unit}
          onValueChange={(u) =>
            patch({
              intervalSeconds: intervalToSeconds(iv.value, u as IntervalUnit),
            })
          }
        >
          <SelectTrigger className="h-9 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["minute", "hour", "day"] as IntervalUnit[]).map((u) => (
              <SelectItem key={u} value={u}>
                {UNIT_LABEL[u]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-sm">运行一次</span>
      </div>
      <p className="text-xs text-muted-foreground">
        首次约在保存后一个间隔触发，之后按间隔递推（时区无关）。
      </p>
    </div>
  )
}

// ── Once (at) ────────────────────────────────────────────────────────────────
function AtEditor({ trigger, patch }: { trigger: Trig; patch: Patch }) {
  const local = trigger.startsAt ? toLocalInput(trigger.startsAt) : ""
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">触发时间</Label>
      <Input
        type="datetime-local"
        value={local}
        onChange={(e) =>
          patch({
            startsAt: e.target.value
              ? new Date(e.target.value).toISOString()
              : undefined,
          })
        }
        className="w-full"
      />
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
