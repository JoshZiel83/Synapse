"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Bell, Bot, ChevronDown, Check } from "lucide-react"
import { useRouter } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobileHeaderActions } from "@/components/mobile-header-actions"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import type { ContactHubEntryView, ContactHubResponse } from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

type ContactFilter = "all" | "friend" | "actor" | "workspace-user"

type ContactSection = {
  letter: string
  items: ContactHubEntryView[]
}

const FILTER_OPTIONS: Array<{ value: ContactFilter; label: string }> = [
  { value: "all", label: "默认" },
  { value: "friend", label: "好友" },
  { value: "actor", label: "Actor" },
  { value: "workspace-user", label: "Workspace User" },
]

const LETTER_RAIL = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"]

const PINYIN_INITIAL_BOUNDARIES: Array<{ letter: string; boundary: string }> = [
  { letter: "A", boundary: "阿" },
  { letter: "B", boundary: "八" },
  { letter: "C", boundary: "嚓" },
  { letter: "D", boundary: "哒" },
  { letter: "E", boundary: "妸" },
  { letter: "F", boundary: "发" },
  { letter: "G", boundary: "旮" },
  { letter: "H", boundary: "哈" },
  { letter: "J", boundary: "击" },
  { letter: "K", boundary: "喀" },
  { letter: "L", boundary: "垃" },
  { letter: "M", boundary: "妈" },
  { letter: "N", boundary: "拿" },
  { letter: "O", boundary: "哦" },
  { letter: "P", boundary: "啪" },
  { letter: "Q", boundary: "期" },
  { letter: "R", boundary: "然" },
  { letter: "S", boundary: "撒" },
  { letter: "T", boundary: "塌" },
  { letter: "W", boundary: "挖" },
  { letter: "X", boundary: "昔" },
  { letter: "Y", boundary: "压" },
  { letter: "Z", boundary: "匝" },
]

function compareText(left: string, right: string) {
  try {
    return left.localeCompare(right, "zh-Hans-u-co-pinyin", {
      sensitivity: "base",
    })
  } catch {
    return left.localeCompare(right, undefined, {
      sensitivity: "base",
    })
  }
}

function getInitialLetter(value: string) {
  const first = value.trim().charAt(0)
  if (!first) return "#"

  const upper = first.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return upper

  if (/^[\u4E00-\u9FFF]$/.test(first)) {
    for (let index = PINYIN_INITIAL_BOUNDARIES.length - 1; index >= 0; index -= 1) {
      const current = PINYIN_INITIAL_BOUNDARIES[index]
      if (current && compareText(first, current.boundary) >= 0) {
        return current.letter
      }
    }
    return "A"
  }

  return "#"
}

function isFriendEntry(entry: ContactHubEntryView) {
  return entry.kind.startsWith("friend")
}

function formatPendingCount(count: number) {
  return count > 99 ? "99+" : String(count)
}

function getEntryBucket(entry: ContactHubEntryView) {
  return getInitialLetter(entry.title)
}

function compareEntries(left: ContactHubEntryView, right: ContactHubEntryView) {
  const titleCompare = compareText(left.title, right.title)
  if (titleCompare !== 0) return titleCompare
  return compareText(left.subtitle || "", right.subtitle || "")
}

function EntryCard({
  entry,
  onPress,
}: {
  entry: ContactHubEntryView
  onPress: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex w-full items-center gap-2.5 border-b border-border/70 bg-background px-3 py-2.5 text-left last:border-b-0"
    >
      <div className="relative shrink-0">
        <Avatar className="size-9 rounded-2xl">
          <AvatarImage src={resolveFileUrl(entry.avatarUrl) || undefined} alt={entry.title} />
          <AvatarFallback className="rounded-2xl">
            {entry.title.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {entry.targetType === "actor" ? (
          <span className="absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground">
            <Bot className="size-3" />
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">
          {entry.title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {entry.subtitle || entry.workspace.name}
        </div>
      </div>
      {isFriendEntry(entry) ? <Badge variant="secondary">好友</Badge> : null}
    </button>
  )
}

export default function MobileContactsPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const railRef = useRef<HTMLDivElement | null>(null)
  const draggingRailRef = useRef(false)

  const [hub, setHub] = useState<ContactHubResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ContactFilter>("all")
  const [activeLetter, setActiveLetter] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return

    let active = true
    setLoading(true)
    setError(null)
    void api
      .getContactHub(workspaceId)
      .then((result) => {
        if (!active) return
        setHub(result)
      })
      .catch((nextError) => {
        if (!active) return
        setError(nextError instanceof Error ? nextError.message : "联系人加载失败。")
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [workspaceId])

  const filteredEntries = useMemo(() => {
    const all = [
      ...(hub?.workspaceActors || []),
      ...(hub?.workspaceUsers || []),
      ...(hub?.friends || []),
    ]

    if (filter === "friend") {
      return [...(hub?.friends || [])].sort(compareEntries)
    }
    if (filter === "actor") {
      return [...(hub?.workspaceActors || [])].sort(compareEntries)
    }
    if (filter === "workspace-user") {
      return [...(hub?.workspaceUsers || [])].sort(compareEntries)
    }
    return [...all].sort(compareEntries)
  }, [filter, hub?.friends, hub?.workspaceActors, hub?.workspaceUsers])

  const sections = useMemo<ContactSection[]>(() => {
    const grouped = new Map<string, ContactHubEntryView[]>()
    for (const entry of filteredEntries) {
      const letter = getEntryBucket(entry)
      if (!grouped.has(letter)) {
        grouped.set(letter, [])
      }
      grouped.get(letter)!.push(entry)
    }

    return LETTER_RAIL.filter((letter) => grouped.has(letter)).map((letter) => ({
      letter,
      items: grouped.get(letter) || [],
    }))
  }, [filteredEntries])

  const filterLabel =
    FILTER_OPTIONS.find((option) => option.value === filter)?.label || "默认"
  const pendingRequestCount = hub?.requestSummary.totalPendingCount || 0

  function scrollToLetter(letter: string) {
    const target = sectionRefs.current[letter]
    const container = containerRef.current
    if (!target || !container) return
    setActiveLetter(letter)
    container.scrollTo({
      top: Math.max(target.offsetTop - 62, 0),
      behavior: "auto",
    })
  }

  function activateRail(clientY: number) {
    const rail = railRef.current
    if (!rail) return
    const rect = rail.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    const index = Math.min(
      LETTER_RAIL.length - 1,
      Math.max(0, Math.floor(ratio * LETTER_RAIL.length))
    )
    scrollToLetter(LETTER_RAIL[index]!)
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-svh items-center justify-center px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Select a workspace to browse contacts on mobile.
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader
        title="联系人"
        action={
          <MobileHeaderActions
            onSearch={() => router.push("/m/search")}
            onStartGroup={() => router.push("/m/contacts/group/new")}
            onAddFriend={() => router.push("/m/contacts/add")}
            onScan={() => router.push("/m/scan?intent=relationship")}
            extraAction={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative size-7 rounded-none px-0 text-foreground hover:bg-transparent"
                aria-label="好友申请"
                onClick={() => router.push("/m/contacts/requests")}
              >
                <Bell className="size-[18px]" />
                {pendingRequestCount > 0 ? (
                  <span className="absolute -top-1.5 -right-1.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold leading-4 text-white">
                    {formatPendingCount(pendingRequestCount)}
                  </span>
                ) : null}
              </Button>
            }
          />
        }
      />

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 pt-3 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)]"
      >
        <div className="space-y-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-48 rounded-xl" />
            </div>
          ) : error ? (
            <div className="-mx-4 bg-background px-4 py-10 text-center">
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => window.location.reload()}
                >
                  重试
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-sm font-semibold text-foreground"
                    >
                      {filterLabel}
                      <ChevronDown className="size-4 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="rounded-2xl">
                    {FILTER_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onSelect={() => setFilter(option.value)}
                        className="rounded-xl"
                      >
                        {filter === option.value ? (
                          <Check className="mr-2 size-4 text-primary" />
                        ) : (
                          <span className="mr-2 inline-block size-4" />
                        )}
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="text-sm font-semibold text-muted-foreground">
                  {filteredEntries.length} 人
                </span>
              </div>

              {filteredEntries.length > 0 ? (
                <div className="-mx-4 bg-background">
                  {sections.map((section) => (
                    <div
                      key={section.letter}
                      ref={(node) => {
                        sectionRefs.current[section.letter] = node
                      }}
                    >
                      <div className="bg-muted/30 px-4 py-2 text-[11px] font-semibold tracking-[0.18em] text-muted-foreground">
                        {section.letter}
                      </div>
                      {section.items.map((entry) => (
                        <EntryCard
                          key={`${entry.kind}:${entry.id}`}
                          entry={entry}
                          onPress={() => router.push(`/m/contacts/${entry.kind}/${entry.id}`)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  当前分类下没有联系人。
                </p>
              )}
            </div>
          )}
        </div>

      </div>

      {!loading && !error && sections.length > 0 ? (
        <div
          ref={railRef}
          className="absolute top-28 right-1 z-10 flex h-[calc(100%-10rem-var(--mobile-tab-bar-clearance,0px))] w-5 flex-col items-center justify-center gap-0.5 select-none"
          onMouseDown={(event) => {
            draggingRailRef.current = true
            activateRail(event.clientY)
          }}
          onMouseMove={(event) => {
            if (!draggingRailRef.current) return
            activateRail(event.clientY)
          }}
          onMouseUp={() => {
            draggingRailRef.current = false
          }}
          onMouseLeave={() => {
            draggingRailRef.current = false
          }}
          onTouchStart={(event) => {
            activateRail(event.touches[0]!.clientY)
          }}
          onTouchMove={(event) => {
            activateRail(event.touches[0]!.clientY)
          }}
          style={{ touchAction: "none" }}
        >
          {LETTER_RAIL.map((letter) => {
            const enabled = sections.some((section) => section.letter === letter)
            return (
              <button
                key={letter}
                type="button"
                disabled={!enabled}
                onClick={() => scrollToLetter(letter)}
                className={`w-full text-[10px] leading-none ${
                  activeLetter === letter
                    ? "font-bold text-primary"
                    : enabled
                      ? "font-semibold text-primary/80"
                      : "text-border"
                }`}
              >
                {letter}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
