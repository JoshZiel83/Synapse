/**
 * Shared chat timestamp formatting.
 *
 * Consolidates the per-frontend, ad-hoc date formatters that had drifted apart:
 *  - web  `conversation-list.tsx`  -> relative ("now" / "3m" / "5h" / "2d" / date)
 *  - mobile `conversation-item.tsx` -> absolute month/day + time (inbox)
 *  - mobile `message-item.tsx`      -> absolute time-of-day
 *
 * Dependency-free: uses the built-in `Intl` (available in modern browsers and
 * Hermes). The "relative" style takes an injectable `now` so it is deterministic
 * and testable. Locale defaults to "zh-CN" to preserve mobile's prior behaviour;
 * pass a different BCP-47 tag to override.
 *
 * Kept on its own subpath (not re-exported from the root barrel) to keep the
 * service-worker-reachable barrel surface tight.
 */

export * from "./instant.js"

export type ChatTimestampStyle = "relative" | "inboxShort" | "time"

export interface FormatChatTimestampOptions {
  /** "now" reference for the relative style (defaults to Date.now()). */
  now?: number
  /** BCP-47 locale tag. Defaults to "zh-CN". */
  locale?: string
}

function isDateObject(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === "[object Date]"
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = isDateObject(value) ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Format a chat timestamp in one of the three established styles.
 * Returns "" for empty/invalid input (matching the prior helpers).
 */
export function formatChatTimestamp(
  value: string | number | Date | null | undefined,
  style: ChatTimestampStyle,
  options: FormatChatTimestampOptions = {}
): string {
  const date = toDate(value)
  if (!date) return ""

  const locale = options.locale ?? "zh-CN"

  if (style === "time") {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  }

  if (style === "inboxShort") {
    return new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date)
  }

  // style === "relative"
  // datetime-ok: display-layer "now" reference for relative formatting
  // ("3m"/"5h"); injectable for tests. Not a wire instant or a value-masking
  // fallback.
  const now = options.now ?? Date.now()
  const diffMs = now - date.getTime()
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date)
}
