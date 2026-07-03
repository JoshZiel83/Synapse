"use client"

// The redesigned Contacts hub. The list IS the hub: one unified, filterable
// roster owns the left column; requests collapse into a single badged top-action
// row (right-pane inbox), and identity/add live behind the header "+" (Phase 2) —
// nothing ever stacks above the list. Replaces the 1456-line client that buried
// the roster under pending-requests + identity-ID + QR and split it into 4 lists.
import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Inbox, Loader2, RefreshCw, Search } from "lucide-react"
import { toast } from "sonner"
import { api } from "@/lib/api"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Input } from "@/components/ui/input"
import { cn, isFriend, type Entry, type TargetType } from "./contact-shared"
import { ContactList } from "./contact-list"
import { ContactDetail } from "./contact-detail"
import { RequestsInbox } from "./requests-inbox"

type TargetFacet = TargetType | "all"
type RelationFacet = "all" | "workspace" | "friend"
const keyOf = (e: Entry) => `${e.kind}:${e.id}`

const TARGET_FACETS: { value: TargetFacet; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "workspace_member", label: "人" },
  { value: "actor", label: "Actor" },
  { value: "remote_agent", label: "Agent" },
]

export default function ContactsHub() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [q, setQ] = useState("")
  const [target, setTarget] = useState<TargetFacet>("all")
  const [relation, setRelation] = useState<RelationFacet>("all")
  const [pendingOnly, setPendingOnly] = useState(false)
  const [starredOnly, setStarredOnly] = useState(false)
  const [selected, setSelected] = useState<Entry>()
  const [pane, setPane] = useState<"detail" | "requests">("detail")

  const [starred, setStarred] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set()
    try {
      return new Set(
        JSON.parse(localStorage.getItem("contact-stars") || "[]") as string[]
      )
    } catch {
      return new Set()
    }
  })
  const toggleStar = (e: Entry) =>
    setStarred((prev) => {
      const next = new Set(prev)
      const k = keyOf(e)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      if (typeof window !== "undefined")
        localStorage.setItem("contact-stars", JSON.stringify([...next]))
      return next
    })

  const hubQuery = useQuery({
    queryKey: ["contact-hub", workspaceId],
    queryFn: () => api.getContactHub(workspaceId!),
    enabled: !!workspaceId,
  })
  const hub = hubQuery.data

  const allEntries = useMemo<Entry[]>(
    () =>
      hub
        ? [
            ...hub.workspaceMembers,
            ...hub.workspaceActors,
            ...hub.workspaceRemoteAgents,
            ...hub.friends,
          ]
        : [],
    [hub]
  )

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    return allEntries.filter((e) => {
      if (target !== "all" && e.targetType !== target) return false
      if (relation === "workspace" && isFriend(e)) return false
      if (relation === "friend" && !isFriend(e)) return false
      if (
        pendingOnly &&
        !["pending_approval", "approval_required"].includes(
          e.directState.status
        )
      )
        return false
      if (starredOnly && !starred.has(keyOf(e))) return false
      if (n) {
        const hay =
          `${e.title} ${e.subtitle ?? ""} ${e.workspace.name} ${e.relationLabel}`.toLowerCase()
        if (!hay.includes(n)) return false
      }
      return true
    })
  }, [allEntries, q, target, relation, pendingOnly, starredOnly, starred])

  // keep a valid selection
  useEffect(() => {
    if (
      pane === "detail" &&
      selected &&
      !allEntries.some((e) => keyOf(e) === keyOf(selected))
    ) {
      setSelected(undefined)
    }
  }, [allEntries, selected, pane])

  const detailQuery = useQuery({
    queryKey: ["contact-detail", workspaceId, selected?.kind, selected?.id],
    queryFn: () =>
      api.getContactHubDetail(workspaceId!, selected!.kind, selected!.id),
    enabled: !!workspaceId && !!selected && pane === "detail",
  })

  const pendingTotal = hub?.requestSummary.totalPendingCount ?? 0

  return (
    <div className="grid h-full min-h-0 grid-cols-[24rem_minmax(0,1fr)] overflow-hidden">
      {/* LEFT — the roster is the hero */}
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h1 className="text-lg font-semibold">通讯录</h1>
          <button
            type="button"
            onClick={() => hubQuery.refetch()}
            aria-label="刷新"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"
          >
            <RefreshCw
              className={cn("size-4", hubQuery.isFetching && "animate-spin")}
            />
          </button>
        </div>

        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索联系人…"
              className="h-9 pl-8"
            />
          </div>
        </div>

        {/* facets — reshape the ONE list, never fork it */}
        <div className="space-y-1.5 px-4 pb-2">
          <div className="flex gap-1 rounded-lg bg-muted p-0.5">
            {TARGET_FACETS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTarget(t.value)}
                className={cn(
                  "flex-1 rounded-md px-1.5 py-1 text-xs transition",
                  target === t.value
                    ? "bg-background font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Chip
              active={relation !== "all"}
              onClick={() =>
                setRelation((r) =>
                  r === "all"
                    ? "workspace"
                    : r === "workspace"
                      ? "friend"
                      : "all"
                )
              }
            >
              {relation === "workspace"
                ? "工作区"
                : relation === "friend"
                  ? "好友"
                  : "关系"}
            </Chip>
            <Chip
              active={pendingOnly}
              onClick={() => setPendingOnly((v) => !v)}
            >
              待处理
            </Chip>
            <Chip
              active={starredOnly}
              onClick={() => setStarredOnly((v) => !v)}
            >
              星标
            </Chip>
          </div>
        </div>

        {/* single pinned top-action row: Requests */}
        <button
          type="button"
          onClick={() => setPane("requests")}
          className={cn(
            "mx-2 mb-1 flex items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent/50",
            pane === "requests" && "bg-accent"
          )}
        >
          <div className="flex size-9 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Inbox className="size-4" />
          </div>
          <span className="flex-1 text-sm font-medium">请求</span>
          {pendingTotal > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-medium text-white">
              {pendingTotal}
            </span>
          )}
          <ChevronRight className="size-4 text-muted-foreground/40" />
        </button>

        {/* the list */}
        {hubQuery.isPending ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ContactList
            entries={filtered}
            starred={starred}
            selectedKey={
              pane === "detail" && selected ? keyOf(selected) : undefined
            }
            onSelect={(e) => {
              setSelected(e)
              setPane("detail")
            }}
            onToggleStar={toggleStar}
          />
        )}
      </div>

      {/* RIGHT — router surface */}
      <div className="min-h-0 overflow-y-auto">
        {pane === "requests" && workspaceId ? (
          <RequestsInbox workspaceId={workspaceId} />
        ) : selected ? (
          detailQuery.data ? (
            <ContactDetail
              entry={detailQuery.data.contact}
              groups={detailQuery.data.groups}
              starred={starred.has(keyOf(selected))}
              workspaceId={workspaceId!}
              onMessage={(e) =>
                toast.success(
                  `${e.directState.status === "existing" ? "打开" : "发起"}与「${e.title}」的对话`
                )
              }
              onToggleStar={toggleStar}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            选择一个联系人查看详情
          </div>
        )}
      </div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition",
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-transparent bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}
