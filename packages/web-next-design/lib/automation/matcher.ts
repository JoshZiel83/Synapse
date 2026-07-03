// Matcher domain logic. Our matcher is a strict-equality DEEP-SUBSET test: {}
// matches everything, scalars compare with ===, no operators/ranges/arrays. So
// the UI is just KEY = VALUE clauses (dotted paths), and we can drive the field
// picker + a real WOULD/WOULD-NOT verdict straight from the source's example
// payload. Pure functions shared by the builder and the summary.

type Json = unknown
type Rec = Record<string, Json>

export interface MatchClause {
  path: string // dotted, e.g. "repository.name"
  value: Json
}

const isObj = (v: Json): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v)

// ── Flatten a payload/example into selectable leaf paths ─────────────────────
export function flattenPaths(
  obj: Json,
  prefix = ""
): Array<{ path: string; value: Json }> {
  if (!isObj(obj)) return []
  const out: Array<{ path: string; value: Json }> = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (isObj(v)) out.push(...flattenPaths(v, path))
    else out.push({ path, value: v })
  }
  return out
}

// ── Clauses (flat) ↔ matcher (nested) ────────────────────────────────────────
export function clausesToMatcher(clauses: MatchClause[]): Rec {
  const root: Rec = {}
  for (const { path, value } of clauses) {
    const keys = path.split(".")
    let node = root
    keys.forEach((key, i) => {
      if (i === keys.length - 1) {
        node[key] = value
      } else {
        if (!isObj(node[key])) node[key] = {}
        node = node[key] as Rec
      }
    })
  }
  return root
}

export function matcherToClauses(matcher: Rec | undefined): MatchClause[] {
  if (!matcher || !isObj(matcher)) return []
  return flattenPaths(matcher).map(({ path, value }) => ({ path, value }))
}

// ── The verdict: deep-subset strict-equality (mirrors backend subsetMatch) ────
export function evaluateMatcher(
  matcher: Rec | undefined,
  payload: Json
): { matches: boolean; mismatchPath?: string } {
  const walk = (m: Json, p: Json, prefix: string): string | null => {
    if (isObj(m)) {
      if (!isObj(p)) return prefix || "(root)"
      for (const [k, mv] of Object.entries(m)) {
        const miss = walk(mv, p[k], prefix ? `${prefix}.${k}` : k)
        if (miss) return miss
      }
      return null
    }
    return m === p ? null : prefix
  }
  if (!matcher || Object.keys(matcher).length === 0) return { matches: true }
  const mismatch = walk(matcher, payload, "")
  return mismatch
    ? { matches: false, mismatchPath: mismatch }
    : { matches: true }
}

// ── Humanize ─────────────────────────────────────────────────────────────────
const fmtVal = (v: Json): string => {
  if (typeof v === "string") return `"${v}"`
  if (v === null) return "null"
  return String(v)
}

export function describeMatcher(matcher: Rec | undefined): string {
  const clauses = matcherToClauses(matcher)
  if (clauses.length === 0) return "匹配该事件源的每一次触发"
  return clauses.map((c) => `${c.path} = ${fmtVal(c.value)}`).join(" 且 ")
}

// Coerce a user-typed value to the type of the example's value at that path, so
// string-"150" doesn't silently fail to equal number-150 (we have no operator
// layer to hang a loose-type toggle on).
export function coerceToExampleType(input: string, exampleValue: Json): Json {
  if (typeof exampleValue === "number") {
    const n = Number(input)
    return Number.isFinite(n) ? n : input
  }
  if (typeof exampleValue === "boolean") return input === "true"
  return input
}
