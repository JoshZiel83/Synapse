"use client"

// Start-conversation picker. It is the Contacts roster in SELECT mode inside a
// single-column dialog — same rows / pinyin A–Z sections / rail / kind badges as
// the Contacts page (reuses ContactList), so browse and select feel identical.
// The footer is count-driven: 0 disabled, 1 → 单聊 + 发起群聊, 2+ → 发起群聊(N).
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, X } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ContactList } from "@/app/dashboard/contacts/contact-list"
import {
  ContactAvatar,
  messageCtaLabel,
  type Entry,
} from "@/app/dashboard/contacts/contact-shared"

const keyOf = (e: Entry) => `${e.kind}:${e.id}`

export type CreateMode = "direct" | "group"
export interface CreateIds {
  actorIds: string[]
  workspaceMemberIds: string[]
  remoteAgentIds: string[]
}

function splitIds(entries: Entry[]): CreateIds {
  const actorIds: string[] = []
  const workspaceMemberIds: string[] = []
  const remoteAgentIds: string[] = []
  for (const e of entries) {
    if (e.targetType === "actor" && e.actorId) actorIds.push(e.actorId)
    else if (e.targetType === "remote_agent" && e.remoteAgentId)
      remoteAgentIds.push(e.remoteAgentId)
    else if (e.targetType === "workspace_member" && e.workspaceMemberId)
      workspaceMemberIds.push(e.workspaceMemberId)
  }
  return { actorIds, workspaceMemberIds, remoteAgentIds }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  onCreateConversation: (mode: CreateMode, ids: CreateIds) => void
  preselectedActorId?: string
}

export default function NewConversationDialog({
  open,
  onOpenChange,
  workspaceId,
  onCreateConversation,
  preselectedActorId,
}: Props) {
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const hubQuery = useQuery({
    queryKey: ["contact-hub", workspaceId],
    queryFn: () => api.getContactHub(workspaceId),
    enabled: open && !!workspaceId,
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

  // reset on close; preselect an actor when opened from its "message" action
  useEffect(() => {
    if (!open) {
      setQ("")
      setSelected(new Set())
    }
  }, [open])
  useEffect(() => {
    if (open && preselectedActorId && allEntries.length) {
      const m = allEntries.find(
        (e) => e.targetType === "actor" && e.actorId === preselectedActorId
      )
      if (m) setSelected(new Set([keyOf(m)]))
    }
  }, [open, preselectedActorId, allEntries])

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return allEntries
    return allEntries.filter((e) =>
      `${e.title} ${e.subtitle ?? ""} ${e.workspace.name} ${e.relationLabel}`
        .toLowerCase()
        .includes(n)
    )
  }, [allEntries, q])

  const selectedEntries = useMemo(
    () => allEntries.filter((e) => selected.has(keyOf(e))),
    [allEntries, selected]
  )
  const count = selectedEntries.length

  const toggle = (e: Entry) =>
    setSelected((prev) => {
      const next = new Set(prev)
      const k = keyOf(e)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const remove = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(k)
      return next
    })

  const create = (mode: CreateMode) => {
    if (count === 0) return
    onCreateConversation(mode, splitIds(selectedEntries))
    onOpenChange(false)
  }

  const soloCta =
    count === 1 ? messageCtaLabel(selectedEntries[0].directState.status) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(600px,calc(100vh-5rem))] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]"
      >
        {/* header */}
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-base font-semibold">发起会话</h2>
          <span className="text-sm text-muted-foreground">
            {count > 0 ? `已选 ${count} 人` : "选择联系人"}
          </span>
        </div>

        {/* search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索联系人"
              className="h-9 pl-8"
              autoFocus
            />
          </div>
        </div>

        {/* selected strip */}
        {count > 0 && (
          <div className="flex gap-2 overflow-x-auto border-b px-4 pb-3">
            {selectedEntries.map((e) => {
              const k = keyOf(e)
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => remove(k)}
                  className="group flex w-12 shrink-0 flex-col items-center gap-0.5"
                  title={`移除 ${e.title}`}
                >
                  <span className="relative">
                    <ContactAvatar entry={e} size={36} />
                    <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-foreground/70 text-background opacity-0 transition-opacity group-hover:opacity-100">
                      <X className="size-2.5" />
                    </span>
                  </span>
                  <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                    {e.title}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* the reused Contacts list, in select mode */}
        <div className="flex min-h-0 flex-1 flex-col px-1">
          <ContactList
            entries={filtered}
            starred={new Set()}
            selectable
            selectedKeys={selected}
            onToggle={toggle}
            onSelect={() => {}}
            onToggleStar={() => {}}
          />
        </div>

        {/* count-driven footer */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {count <= 1 && (
            <Button
              onClick={() => create("direct")}
              disabled={count !== 1 || !!soloCta?.disabled}
            >
              {count === 1 ? (soloCta?.label ?? "单聊") : "单聊"}
            </Button>
          )}
          <Button
            variant={count === 1 ? "outline" : "default"}
            onClick={() => create("group")}
            disabled={count === 0}
          >
            {count >= 2 ? `发起群聊（${count}）` : "发起群聊"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
