/**
 * Recursive secret redaction for structured data headed to logs / audit rows.
 *
 * The previous hand-rolled redactors only walked the TOP level of an object,
 * so a secret nested inside tool-call arguments (e.g. `{auth: {token: "..."}}`
 * or `{headers: [{name: "authorization", value: "..."}]}`) was written out in
 * the clear. This walks the whole tree.
 *
 * Matching is by key NAME (case-insensitive substring). In addition, common
 * name/value PAIR shapes (`{name: "authorization", value: "<secret>"}`, as the
 * fetch Headers array and many SDKs serialize headers) are detected so the
 * paired value is redacted even though the literal key is just "value".
 */
const DEFAULT_SENSITIVE_KEY_PARTS = [
  "apikey",
  "api_key",
  "api-key",
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
  "x-api-key",
] as const

const REDACTED = "***REDACTED***"

// Keys that name a field in a {name, value} pair, and the keys that hold the
// corresponding value to redact when that name is sensitive.
const PAIR_NAME_KEYS = ["name", "key", "header", "field"]
const PAIR_VALUE_KEYS = ["value", "val"]

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
 * passed through as-is. Cycles and shared references are handled by caching the
 * REDACTED output per source object — so a revisited node yields its redacted
 * copy, never the original (which would leak the secret).
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
  // Maps a source object/array to its redacted copy. Registered BEFORE
  // recursing into children so a cycle resolves to the (in-progress) redacted
  // copy rather than returning the original unredacted object.
  const done = new Map<object, unknown>()

  function isPlainObject(node: unknown): node is Record<string, unknown> {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return false
    }
    const proto = Object.getPrototypeOf(node)
    return proto === Object.prototype || proto === null
  }

  // Does this object look like a {name:"authorization", value:"..."} pair whose
  // name is sensitive? If so, the paired value key should be redacted.
  function sensitivePairValueKeys(obj: Record<string, unknown>): Set<string> {
    const out = new Set<string>()
    const lowerEntries = Object.entries(obj).map(
      ([k, v]) => [k.toLowerCase(), k, v] as const
    )
    const nameField = lowerEntries.find(
      ([lk, , v]) =>
        PAIR_NAME_KEYS.includes(lk) &&
        typeof v === "string" &&
        keyIsSensitive(v, parts)
    )
    if (!nameField) return out
    for (const [lk, origKey] of lowerEntries) {
      if (PAIR_VALUE_KEYS.includes(lk)) out.add(origKey)
    }
    return out
  }

  function walk(node: unknown, depth: number): unknown {
    if (depth > maxDepth) return node
    if (node === null || typeof node !== "object") return node

    if (Array.isArray(node)) {
      const cached = done.get(node)
      if (cached !== undefined) return cached
      const arr: unknown[] = []
      done.set(node, arr)
      for (const item of node) arr.push(walk(item, depth + 1))
      return arr
    }

    // Leave class instances (Date, Buffer, Map, …) untouched.
    if (!isPlainObject(node)) return node

    const cached = done.get(node)
    if (cached !== undefined) return cached

    const out: Record<string, unknown> = {}
    done.set(node, out)
    const pairValueKeys = sensitivePairValueKeys(node)
    for (const [key, child] of Object.entries(node)) {
      if (keyIsSensitive(key, parts) || pairValueKeys.has(key)) {
        out[key] = placeholder
      } else {
        out[key] = walk(child, depth + 1)
      }
    }
    return out
  }

  return walk(value, 0) as T
}
