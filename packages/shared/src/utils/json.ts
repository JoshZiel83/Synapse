/**
 * Safely coerce an unknown value (or a JSON string) into a plain object.
 *
 * Consolidates ~14 hand-rolled copies that had drifted: some re-validated the
 * parsed result and rejected arrays, others blindly cast `JSON.parse(...)` (or
 * a raw array) to Record<string, unknown> — so a JSONB column holding an array
 * was coerced differently depending on which copy ran. This is the correct,
 * array-rejecting version:
 *
 *   - string  → JSON.parse, then accept only a non-array object (else {})
 *   - object  → accept only a non-array object (else {})
 *   - anything else (incl. arrays, null, primitives) → {}
 *
 * Always returns a fresh-or-original plain object, never throws.
 *
 * NOTE: this is NOT for tool-input validation that must REJECT bad input — the
 * feishu parseJsonObjectInput intentionally throws and must stay separate.
 */
export function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

/**
 * Like parseJsonObject but returns undefined (not {}) when the value is absent
 * or not a plain object — for the call sites that distinguish "no metadata"
 * from "empty metadata".
 */
export function parseJsonObjectOrUndefined(
  value: unknown
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return isPlainObject(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return isPlainObject(value) ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
