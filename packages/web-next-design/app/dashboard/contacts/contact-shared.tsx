"use client"

// Shared vocabulary for the unified Contacts hub: the three ORTHOGONAL per-row
// signals (WHAT it is = target badge, HOW you relate = relation cue, REACHABLE =
// directState), the avatar, and pinyin-aware A–Z section keys (no dep — a zh
// collator + boundary chars). One row template serves all 6 kinds.
import { Bot, Cpu, Lock } from "lucide-react"
import type { ContactHubEntryView } from "@synapse/shared"
import { cn } from "@/lib/utils"

export type Entry = ContactHubEntryView
export type TargetType = Entry["targetType"]
export type DirectStatus = Entry["directState"]["status"]

export const isFriend = (e: Entry) => e.kind.startsWith("friend-")

// WHAT it is — system-owned, non-editable. People get no pill; agents do.
export function targetBadge(
  t: TargetType
): { label: string; className: string } | null {
  switch (t) {
    case "actor":
      return {
        label: "Actor",
        className: "bg-violet-500/10 text-violet-600 border-violet-500/20",
      }
    case "remote_agent":
      return {
        label: "Agent",
        className: "bg-sky-500/10 text-sky-600 border-sky-500/20",
      }
    default:
      return null // people carry no type pill
  }
}

// HOW you relate — a subtle leading dot (workspace = primary, friend = external).
export const relationDotClass = (e: Entry) =>
  isFriend(e) ? "bg-amber-400" : "bg-primary/60"

// REACHABLE — a quiet right-aligned micro-status.
export function directMeta(s: DirectStatus): {
  label?: string
  icon?: typeof Lock
  tone: string
} {
  switch (s) {
    case "pending_approval":
      return { label: "待批准", tone: "text-muted-foreground" }
    case "approval_required":
      return { icon: Lock, tone: "text-muted-foreground/60" }
    default:
      return { tone: "" } // existing / available stay quiet
  }
}

export function messageCtaLabel(s: DirectStatus): {
  label: string
  disabled: boolean
} {
  switch (s) {
    case "existing":
      return { label: "打开对话", disabled: false }
    case "available":
      return { label: "发起对话", disabled: false }
    case "approval_required":
      return { label: "申请并私信", disabled: false }
    case "pending_approval":
      return { label: "等待批准", disabled: true }
    default:
      return { label: "发消息", disabled: false }
  }
}

type AvatarLike = Pick<
  Entry,
  "avatarUrl" | "avatarEmoji" | "targetType" | "title"
>
export function ContactAvatar({
  entry,
  size = 40,
}: {
  entry: AvatarLike
  size?: number
}) {
  const px = { width: size, height: size }
  const glyph =
    entry.targetType === "actor"
      ? Cpu
      : entry.targetType === "remote_agent"
        ? Bot
        : null
  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted text-muted-foreground"
      style={px}
    >
      {entry.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={entry.avatarUrl} alt="" className="size-full object-cover" />
      ) : entry.avatarEmoji ? (
        <span style={{ fontSize: size * 0.5 }}>{entry.avatarEmoji}</span>
      ) : glyph ? (
        (() => {
          const G = glyph
          return <G style={{ width: size * 0.45, height: size * 0.45 }} />
        })()
      ) : (
        <span
          className="font-medium text-foreground/70"
          style={{ fontSize: size * 0.4 }}
        >
          {entry.title.trim()[0]?.toUpperCase() ?? "?"}
        </span>
      )}
    </div>
  )
}

// ── pinyin-aware A–Z section key (no library) ────────────────────────────────
const zhCollator = new Intl.Collator("zh-Hans", { sensitivity: "base" })
export const titleCollator = new Intl.Collator("zh-Hans", {
  numeric: true,
  sensitivity: "base",
})
// representative first-char of each pinyin initial group (GB order)
const BOUNDARIES: [string, string][] = [
  ["A", "阿"],
  ["B", "芭"],
  ["C", "擦"],
  ["D", "搭"],
  ["E", "蛾"],
  ["F", "发"],
  ["G", "噶"],
  ["H", "哈"],
  ["J", "击"],
  ["K", "喀"],
  ["L", "垃"],
  ["M", "妈"],
  ["N", "拿"],
  ["O", "哦"],
  ["P", "啪"],
  ["Q", "期"],
  ["R", "然"],
  ["S", "撒"],
  ["T", "塌"],
  ["W", "挖"],
  ["X", "昔"],
  ["Y", "压"],
  ["Z", "匝"],
]

export function sectionKey(title: string): string {
  const c = title.trim()[0]
  if (!c) return "#"
  if (/[a-zA-Z]/.test(c)) return c.toUpperCase()
  if (/[一-鿿]/.test(c)) {
    for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
      if (zhCollator.compare(c, BOUNDARIES[i][1]) >= 0) return BOUNDARIES[i][0]
    }
    return "A"
  }
  return "#"
}

export const SECTION_ORDER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "#"]

export function sectionCompare(a: string, b: string) {
  return SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b)
}

export { cn }
