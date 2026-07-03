"use client"

// The ONE unified roster: all 6 kinds concatenated, pinyin/locale sorted into
// A–Z sticky sections with a "#" catch-all, a pinned ★ Starred section on top,
// and a right-edge index rail. Filters shrink this same list in place — they
// never fork it back into the backend's 4 buckets.
import { useMemo, useRef } from "react"
import { Star } from "lucide-react"
import {
  cn,
  ContactAvatar,
  directMeta,
  relationDotClass,
  sectionCompare,
  sectionKey,
  targetBadge,
  titleCollator,
  type Entry,
} from "./contact-shared"

const keyOf = (e: Entry) => `${e.kind}:${e.id}`

export function ContactList({
  entries,
  starred,
  selectedKey,
  onSelect,
  onToggleStar,
}: {
  entries: Entry[]
  starred: Set<string>
  selectedKey?: string
  onSelect: (e: Entry) => void
  onToggleStar: (e: Entry) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const { sections, railKeys } = useMemo(() => {
    const sorted = [...entries].sort((a, b) =>
      titleCollator.compare(a.title, b.title)
    )
    const starredEntries = sorted.filter((e) => starred.has(keyOf(e)))
    const byLetter = new Map<string, Entry[]>()
    for (const e of sorted) {
      const k = sectionKey(e.title)
      ;(byLetter.get(k) ?? byLetter.set(k, []).get(k)!).push(e)
    }
    const letters = [...byLetter.keys()].sort(sectionCompare)
    const secs: { key: string; label: string; items: Entry[] }[] = []
    if (starredEntries.length)
      secs.push({ key: "★", label: "星标", items: starredEntries })
    for (const l of letters)
      secs.push({ key: l, label: l, items: byLetter.get(l)! })
    return {
      sections: secs,
      railKeys: [...(starredEntries.length ? ["★"] : []), ...letters],
    }
  }, [entries, starred])

  const jumpTo = (key: string) => {
    scrollRef.current
      ?.querySelector(`[data-sec="${key}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" })
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        没有符合条件的联系人
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
        {sections.map((sec) => (
          <div key={sec.key} data-sec={sec.key}>
            <div className="sticky top-0 z-10 flex items-center gap-1 bg-background/95 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur">
              {sec.key === "★" && (
                <Star className="size-3 fill-amber-400 text-amber-400" />
              )}
              {sec.label}
            </div>
            {sec.items.map((e) => {
              const k = keyOf(e)
              const badge = targetBadge(e.targetType)
              const dm = directMeta(e.directState.status)
              const isStar = starred.has(k)
              return (
                <button
                  key={k + sec.key}
                  type="button"
                  onClick={() => onSelect(e)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors hover:bg-accent/50",
                    k === selectedKey && "bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      relationDotClass(e)
                    )}
                  />
                  <ContactAvatar entry={e} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {e.title}
                      </span>
                      {badge && (
                        <span
                          className={cn(
                            "shrink-0 rounded-md border px-1 py-0 text-[10px] leading-4",
                            badge.className
                          )}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {e.subtitle ?? e.relationLabel}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {dm.label && (
                      <span className={cn("text-[11px]", dm.tone)}>
                        {dm.label}
                      </span>
                    )}
                    {dm.icon && <dm.icon className={cn("size-3.5", dm.tone)} />}
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={isStar ? "取消星标" : "星标"}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        onToggleStar(e)
                      }}
                      className={cn(
                        "cursor-pointer rounded p-0.5 transition-opacity",
                        isStar
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100"
                      )}
                    >
                      <Star
                        className={cn(
                          "size-3.5",
                          isStar
                            ? "fill-amber-400 text-amber-400"
                            : "text-muted-foreground/50"
                        )}
                      />
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* A–Z index rail — a real column beside the scroll area, not over it */}
      <div className="flex w-5 shrink-0 flex-col justify-center gap-0.5 py-2 select-none">
        {railKeys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => jumpTo(k)}
            className="text-[9px] leading-none text-muted-foreground/60 hover:text-primary"
          >
            {k === "★" ? "★" : k}
          </button>
        ))}
      </div>
    </div>
  )
}
