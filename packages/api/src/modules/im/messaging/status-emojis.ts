/**
 * StatusLevel enum and emoji mapping.
 *
 * Used by StatusReactionController (platform-neutral) and the per-connector
 * StatusReactionAdapter implementations (e.g. Feishu messageReaction.create).
 *
 * Tool name → status level mapping is priority-based so a single tool call
 * surfaces the most specific category. Update DEFAULT_TOOL_PATTERNS to add new
 * categories; the rest of the system reads from the resulting StatusLevel.
 */

export type StatusLevel =
  | "queued"
  | "thinking"
  | "tool"
  | "coding"
  | "web"
  | "done"
  | "error"
  | "stall"
  | "stall_hard"

/**
 * Default emoji glyphs by status level. Override per workspace if you ever
 * want to customize, but these defaults are what we send to Feishu by default.
 */
export const DEFAULT_STATUS_EMOJIS: Record<StatusLevel, string> = {
  queued: "👀",
  thinking: "🧠",
  tool: "🛠️",
  coding: "💻",
  web: "🌐",
  done: "✅",
  error: "❌",
  stall: "⏳",
  stall_hard: "⚠️",
}

/**
 * Feishu emoji_type values (validated against
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce).
 * Identifier casing matches Feishu exactly (THUMBSUP uppercase, OnIt mixed).
 */
export const DEFAULT_FEISHU_EMOJI_TYPES: Record<StatusLevel, string> = {
  queued: "OnIt", // "on it / got it" — best semantic match for 👀 queued
  thinking: "THINKING", // 🧠 — exact match in Feishu's table
  tool: "HAMMER", // 🛠️ — closest tool icon
  coding: "STRIVE", // 💻 — Feishu has no laptop; "strive" implies focused work
  web: "Get", // 🌐 — Feishu has no globe; "Get" implies fetching
  done: "DONE", // ✅ — exact match
  error: "ERROR", // ❌ — exact match
  stall: "Typing", // ⏳ — Feishu's typing indicator looks like a slow ellipsis
  stall_hard: "Alarm", // ⚠️ — alert / attention required
}

/**
 * Priority-ordered patterns for matching tool/action names to a status level.
 * First match wins. Patterns are case-insensitive substrings; order matters.
 *
 * Adding a new pattern: insert at the right priority spot (more specific first).
 */
export interface ToolPattern {
  level: Exclude<
    StatusLevel,
    "queued" | "thinking" | "done" | "error" | "stall" | "stall_hard"
  >
  needles: readonly string[]
}

export const DEFAULT_TOOL_PATTERNS: readonly ToolPattern[] = [
  {
    level: "web",
    needles: [
      "web_search",
      "web_fetch",
      "browser",
      "browse",
      "fetch",
      "http",
      "url",
      "search",
    ],
  },
  {
    level: "coding",
    needles: [
      "edit",
      "write",
      "patch",
      "code",
      "apply",
      "bash",
      "exec",
      "shell",
      "compile",
      "build",
    ],
  },
  {
    level: "tool",
    needles: ["mcp", "relay", "tool", "invoke", "call"],
  },
]

/**
 * Match a tool name (or similar action label) to a tool status level.
 * Returns "tool" as a fallback when no specific pattern matches.
 *
 * Pure function. Case-insensitive. Empty / unknown input → "tool".
 */
export function resolveToolStatusLevel(
  toolName: string,
  patterns: readonly ToolPattern[] = DEFAULT_TOOL_PATTERNS
): Extract<StatusLevel, "tool" | "coding" | "web"> {
  if (!toolName) return "tool"
  const lower = toolName.toLowerCase()
  for (const pattern of patterns) {
    for (const needle of pattern.needles) {
      if (lower.includes(needle)) {
        return pattern.level
      }
    }
  }
  return "tool"
}

/**
 * Pick the highest-priority status level among multiple concurrent tool calls.
 * Used when an `actor.action` event reports several tool invocations in one turn.
 *
 * Priority order: coding > web > tool. (More specific wins.)
 */
export function pickDominantToolStatus(
  toolNames: readonly string[]
): Extract<StatusLevel, "tool" | "coding" | "web"> {
  const levels = toolNames.map((n) => resolveToolStatusLevel(n))
  if (levels.includes("coding")) return "coding"
  if (levels.includes("web")) return "web"
  return "tool"
}

/**
 * Whether a status level is terminal (the controller stops accepting set() calls
 * after it enters this state, except for further done/error transitions).
 */
export function isTerminalStatus(level: StatusLevel): boolean {
  return level === "done" || level === "error"
}

/**
 * Whether a status level is a stall warning. The controller raises these
 * automatically when a non-terminal state has held for too long.
 */
export function isStallStatus(level: StatusLevel): boolean {
  return level === "stall" || level === "stall_hard"
}
