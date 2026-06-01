/**
 * Recursive secret redaction for structured data headed to logs / audit rows.
 *
 * The previous hand-rolled redactors only walked the TOP level of an object,
 * so a secret nested inside tool-call arguments (e.g. `{auth: {token: "..."}}`
 * or `{headers: [{name: "authorization", value: "..."}]}`) was written out in
 * the clear. This walks the whole tree.
 *
 * Matching is by key NAME (case-insensitive substring), which is the same
 * heuristic the old code used — we do not try to detect secret-shaped values,
 * only secret-named keys.
 */
const DEFAULT_SENSITIVE_KEY_PARTS = [
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "auth_token",
  "access_token",
  "refresh_token",
  "client_secret",
  "private_key",
  "credential",
] as const

const REDACTED = "***REDACTED***"

export interface RedactOptions {
  /** Extra lowercase key-substrings to treat as sensitive. */
  readonly extraKeys?: readonly string[]
  /** Replacement string for redacted values. */
  readonly placeholder?: string
  /** Max recursion depth (defensive against pathological/cyclic input). */
  readonly maxDepth?: number
}

function keyIsSensitive(key: string, parts: readonly string[]): boolean {
  const lower = key.toLowerCase()
  return parts.some((part) => lower.includes(part))
}

/**
 * Returns a deep copy of `value` with any value under a sensitive-named key
 * replaced by the placeholder. Non-plain containers (Date, Buffer, etc.) are
 * passed through as-is. Cycles are guarded via a visited set + depth cap.
 */
export function redactSecrets<T>(value: T, options: RedactOptions = {}): T {
  const parts = options.extraKeys
    ? [
        ...DEFAULT_SENSITIVE_KEY_PARTS,
        ...options.extraKeys.map((k) => k.toLowerCase()),
      ]
    : DEFAULT_SENSITIVE_KEY_PARTS
  const placeholder = options.placeholder ?? REDACTED
  const maxDepth = options.maxDepth ?? 12
  const seen = new WeakSet<object>()

  function walk(node: unknown, depth: number): unknown {
    if (depth > maxDepth) return node
    if (node === null || typeof node !== "object") return node

    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1))
    }

    // Only descend into plain objects; leave class instances (Date, Buffer,
    // Map, …) untouched to avoid corrupting them.
    const proto = Object.getPrototypeOf(node)
    if (proto !== Object.prototype && proto !== null) return node

    if (seen.has(node as object)) return node
    seen.add(node as object)

    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>
    )) {
      if (keyIsSensitive(key, parts)) {
        out[key] = placeholder
      } else {
        out[key] = walk(child, depth + 1)
      }
    }
    return out
  }

  return walk(value, 0) as T
}
