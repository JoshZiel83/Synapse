"use client"

// Matcher builder. Because matching is strict-equality deep-subset, there is NO
// operator column — just KEY = VALUE. You toggle keys straight from the source's
// example payload (EventBridge-sandbox style); {} is shown positively as "fires
// on every occurrence"; a live verdict says whether the example WOULD deliver.
import { CircleCheck, CircleSlash } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import {
  clausesToMatcher,
  coerceToExampleType,
  evaluateMatcher,
  flattenPaths,
  matcherToClauses,
} from "@/lib/automation/matcher"

type Rec = Record<string, unknown>

export function MatcherBuilder({
  examplePayload,
  matcher,
  onChange,
}: {
  examplePayload: Rec
  matcher: Rec
  onChange: (m: Rec) => void
}) {
  // Only scalar leaves are matchable (strict equality, no arrays/objects).
  const leaves = flattenPaths(examplePayload).filter(
    (l) => !Array.isArray(l.value)
  )
  const clauses = matcherToClauses(matcher)
  const clauseByPath = new Map(clauses.map((c) => [c.path, c.value]))

  const setClause = (path: string, value: unknown, on: boolean) => {
    const next = clauses.filter((c) => c.path !== path)
    if (on) next.push({ path, value })
    onChange(clausesToMatcher(next))
  }

  const verdict = evaluateMatcher(matcher, examplePayload)
  const active = clauses.length > 0

  return (
    <div className="space-y-3">
      {leaves.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          该事件源没有示例数据，可在事件源管理里补充。
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {leaves.map((leaf) => {
            const on = clauseByPath.has(leaf.path)
            const value = on ? clauseByPath.get(leaf.path) : leaf.value
            return (
              <div
                key={leaf.path}
                className="flex items-center gap-3 px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setClause(leaf.path, leaf.value, e.target.checked)
                  }
                  className="size-4 shrink-0 accent-primary"
                />
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">
                  {leaf.path}
                </code>
                {on ? (
                  <Input
                    value={String(value ?? "")}
                    onChange={(e) =>
                      setClause(
                        leaf.path,
                        coerceToExampleType(e.target.value, leaf.value),
                        true
                      )
                    }
                    className="h-7 w-40 font-mono text-xs"
                  />
                ) : (
                  <span className="w-40 truncate text-right font-mono text-xs text-muted-foreground/50">
                    {fmt(leaf.value)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* {} positive state */}
      {!active && (
        <div className="rounded-lg border border-dashed bg-muted/20 p-3 text-sm text-muted-foreground">
          未设置条件 —— 该事件源的
          <strong className="text-foreground/80">每一次</strong>
          触发都会投递消息。
        </div>
      )}

      {/* live verdict against the example */}
      {leaves.length > 0 && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
            verdict.matches
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
              : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
          )}
        >
          {verdict.matches ? (
            <CircleCheck className="size-4 shrink-0" />
          ) : (
            <CircleSlash className="size-4 shrink-0" />
          )}
          <span>
            对示例事件：{verdict.matches ? "会投递" : "不会投递"}
            {!verdict.matches && verdict.mismatchPath && (
              <span className="text-muted-foreground">
                （在 <code className="font-mono">{verdict.mismatchPath}</code>{" "}
                不匹配）
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

function fmt(v: unknown): string {
  if (typeof v === "string") return `"${v}"`
  if (v === null) return "null"
  return String(v)
}
