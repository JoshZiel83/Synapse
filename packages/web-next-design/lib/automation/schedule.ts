// Schedule domain logic for the automation editor: compile friendly presets to
// the real 5-field cron / interval-seconds / one-shot primitives the backend
// stores, compute "next N runs" (the correctness check) with the same
// cron-parser the scheduler uses, and humanize a schedule for the summary line.
// Pure functions — no React — so the picker and the summary share one source of
// truth.
import { CronExpressionParser } from "cron-parser"
import cronstrue from "cronstrue/i18n"

export type ScheduleKind = "cron" | "at" | "interval"

export interface ScheduleValue {
  scheduleKind?: ScheduleKind
  scheduleExpr?: string
  scheduleTimezone?: string
  intervalSeconds?: number
  startsAt?: string
}

// ── Next runs (via the real cron-parser; interval/at computed directly) ───────
export function scheduleNextRuns(
  v: ScheduleValue,
  count = 5,
  from: Date = new Date()
): Date[] {
  const tz = v.scheduleTimezone || "UTC"
  if (v.scheduleKind === "cron" && v.scheduleExpr) {
    try {
      const it = CronExpressionParser.parse(v.scheduleExpr, {
        tz,
        currentDate: from,
      })
      return Array.from({ length: count }, () => it.next().toDate())
    } catch {
      return []
    }
  }
  if (v.scheduleKind === "at") {
    const raw = v.startsAt ?? v.scheduleExpr
    const at = raw ? new Date(raw) : null
    return at && !Number.isNaN(at.getTime()) && at > from ? [at] : []
  }
  if (
    v.scheduleKind === "interval" &&
    v.intervalSeconds &&
    v.intervalSeconds > 0
  ) {
    const step = v.intervalSeconds * 1000
    const anchor = v.startsAt ? new Date(v.startsAt) : null
    let next =
      anchor && anchor > from ? anchor : new Date(from.getTime() + step)
    const runs: Date[] = []
    for (let i = 0; i < count; i += 1) {
      runs.push(next)
      next = new Date(next.getTime() + step)
    }
    return runs
  }
  return []
}

export function isValidCron(expr: string, tz = "UTC"): boolean {
  try {
    CronExpressionParser.parse(expr, { tz })
    return true
  } catch {
    return false
  }
}

// English/localized cron description for the advanced raw-cron echo.
export function describeCron(expr: string, locale = "zh_CN"): string {
  try {
    return cronstrue.toString(expr, { locale, use24HourTimeFormat: true })
  } catch {
    return "无效的 cron 表达式"
  }
}

// ── Presets ↔ cron (friendly builder is two-way with the raw field) ───────────
export type CronPreset =
  | { every: "hour"; minute: number }
  | { every: "day"; time: string } // "HH:MM"
  | { every: "weekdays"; time: string }
  | { every: "week"; days: number[]; time: string } // 0=Sun..6=Sat
  | { every: "month"; day: number; time: string }

const hm = (time: string): [number, number] => {
  const [h, m] = time.split(":").map((n) => Number.parseInt(n, 10))
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0]
}

export function presetToCron(p: CronPreset): string {
  if (p.every === "hour") return `${p.minute} * * * *`
  const [h, m] = hm("time" in p ? p.time : "0:0")
  if (p.every === "day") return `${m} ${h} * * *`
  if (p.every === "weekdays") return `${m} ${h} * * 1-5`
  if (p.every === "week") {
    const dow = p.days.length
      ? [...p.days].sort((a, b) => a - b).join(",")
      : "*"
    return `${m} ${h} * * ${dow}`
  }
  return `${m} ${h} ${p.day} * *` // month
}

// Best-effort parse of a 5-field cron back into a friendly preset (round-trip);
// returns null when the expression is too rich for the friendly builder (then
// the UI shows an "editing in advanced mode" banner rather than lying).
export function cronToPreset(expr: string): CronPreset | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  const num = (s: string) => (/^\d+$/.test(s) ? Number.parseInt(s, 10) : null)
  const time = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`

  if (mon !== "*") return null
  const m = num(min)
  // Every hour: "M * * * *"
  if (m !== null && hour === "*" && dom === "*" && dow === "*")
    return { every: "hour", minute: m }
  const h = num(hour)
  if (m === null || h === null) return null
  // Daily / weekdays / weekly / monthly
  if (dom === "*" && dow === "*") return { every: "day", time: time(h, m) }
  if (dom === "*" && dow === "1-5")
    return { every: "weekdays", time: time(h, m) }
  if (dom === "*" && /^[0-6](,[0-6])*$/.test(dow))
    return {
      every: "week",
      days: dow.split(",").map((d) => Number.parseInt(d, 10)),
      time: time(h, m),
    }
  const d = num(dom)
  if (d !== null && dow === "*")
    return { every: "month", day: d, time: time(h, m) }
  return null
}

// ── Interval seconds ↔ {value, unit} ─────────────────────────────────────────
export type IntervalUnit = "minute" | "hour" | "day"
const UNIT_SECONDS: Record<IntervalUnit, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
}
export function secondsToInterval(sec: number): {
  value: number
  unit: IntervalUnit
} {
  for (const unit of ["day", "hour", "minute"] as IntervalUnit[]) {
    const s = UNIT_SECONDS[unit]
    if (sec % s === 0 && sec >= s) return { value: sec / s, unit }
  }
  return { value: Math.max(1, Math.round(sec / 60)), unit: "minute" }
}
export function intervalToSeconds(value: number, unit: IntervalUnit): number {
  return Math.max(1, Math.round(value)) * UNIT_SECONDS[unit]
}
// The scheduler polls ~every 15s, so never offer/allow finer cadence.
export const MIN_INTERVAL_SECONDS = 60

// ── Timezones ────────────────────────────────────────────────────────────────
export function listTimezones(): string[] {
  try {
    return (
      Intl as unknown as { supportedValuesOf: (k: string) => string[] }
    ).supportedValuesOf("timeZone")
  } catch {
    return ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Europe/London"]
  }
}
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}
