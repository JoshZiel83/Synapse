"use client"

import { useEffect, useState, useMemo } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { Search, X, Bot } from "lucide-react"
import ChatAvatar from "./chat-avatar"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.chat.new-conversation-dialog")

interface Actor {
  id: string
  displayName: string
  role: string
  title?: string
  avatarUrl?: string
  emoji?: string
}

type RawActorLike = {
  id: string
  avatarUrl?: string
  displayName?: string
  role?: string
  title?: string
  avatarEmoji?: string
  definition?: {
    role?: string
    title?: string
    avatarEmoji?: string
  }
}

function normalizeActor(actor: RawActorLike): Actor {
  const definition = actor?.definition || actor
  return {
    id: actor.id,
    displayName:
      actor.displayName || definition.title || actor.title || "Unknown actor",
    role: definition.role || "other",
    title: definition.title,
    avatarUrl: actor.avatarUrl,
    emoji: definition.avatarEmoji,
  }
}

interface NewConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  onCreateConversation: (actorIds: string[]) => void
  preselectedActorId?: string
}

// Group actors by role for the picker UI
function groupByRole(actors: Actor[]): { role: string; actors: Actor[] }[] {
  const map = new Map<string, Actor[]>()
  for (const a of actors) {
    const role = a.role || "other"
    if (!map.has(role)) map.set(role, [])
    map.get(role)!.push(a)
  }
  // Sort: secretary first, then alphabetical
  const entries = Array.from(map.entries())
  entries.sort(([a], [b]) => {
    if (a === "secretary") return -1
    if (b === "secretary") return 1
    return a.localeCompare(b)
  })
  return entries.map(([role, actors]) => ({ role, actors }))
}

function roleLabel(role: string): string {
  switch (role) {
    case "secretary":
      return "Secretary"
    case "specialist":
      return "Specialist"
    case "manager":
      return "Manager"
    default:
      return role.charAt(0).toUpperCase() + role.slice(1)
  }
}

export default function NewConversationDialog({
  open,
  onOpenChange,
  workspaceId,
  onCreateConversation,
  preselectedActorId,
}: NewConversationDialogProps) {
  const [actors, setActors] = useState<Actor[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !workspaceId) return
    ;(async () => {
      try {
        const actors = await api.getActors(workspaceId)
        const list: Actor[] = actors.map(normalizeActor)
        list.sort((a, b) => a.displayName.localeCompare(b.displayName))
        setActors(list)

        if (preselectedActorId) {
          setSelectedIds(new Set([preselectedActorId]))
        }
      } catch (err) {
        clientLog.error("Failed to load actors:", err)
      }
    })()
  }, [open, workspaceId, preselectedActorId])

  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set())
      setSearch("")
    }
  }, [open])

  function toggleActor(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function removeActor(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  async function handleCreate() {
    if (selectedIds.size === 0) return
    setLoading(true)
    try {
      onCreateConversation(Array.from(selectedIds))
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return actors
    const q = search.toLowerCase()
    return actors.filter(
      (a) =>
        a.displayName.toLowerCase().includes(q) ||
        a.title?.toLowerCase().includes(q)
    )
  }, [actors, search])

  const grouped = useMemo(() => groupByRole(filtered), [filtered])
  const selectedActors = useMemo(
    () => actors.filter((a) => selectedIds.has(a.id)),
    [actors, selectedIds]
  )

  function ActorAvatar({
    actor,
    size = "md",
  }: {
    actor: Actor
    size?: "md" | "sm"
  }) {
    return (
      <ChatAvatar
        name={actor.displayName}
        avatarUrl={actor.avatarUrl}
        emoji={actor.emoji}
        entityType="actor"
        size={size === "md" ? "default" : "sm"}
        className="shrink-0"
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden bg-white p-0 ring-1 ring-gray-200 sm:max-w-[920px] dark:bg-gray-900 dark:ring-white/10"
      >
        <div className="grid h-[min(560px,calc(100vh-5rem))] grid-cols-2">
          {/* Left: actor list */}
          <div className="flex min-h-0 min-w-0 flex-col border-r border-gray-200 dark:border-white/10">
            {/* Search */}
            <div className="border-b border-gray-100 p-4 dark:border-white/5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search actors..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="block w-full rounded-md bg-white py-1.5 pr-3 pl-9 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-ring dark:bg-white/5 dark:text-white dark:outline-white/10 dark:placeholder:text-gray-500 dark:focus:outline-ring"
                  autoFocus
                />
              </div>
            </div>

            {/* Scrollable list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {grouped.map(({ role, actors: groupActors }) => (
                <div key={role}>
                  {/* Role header */}
                  <div className="sticky top-0 bg-gray-50 px-5 py-1.5 text-xs font-semibold text-gray-500 dark:bg-white/5 dark:text-gray-400">
                    {roleLabel(role)}
                  </div>
                  {/* Actor rows */}
                  {groupActors.map((actor) => (
                    <label
                      key={actor.id}
                      className="flex cursor-pointer items-center px-5 py-2.5 transition-colors select-none hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <div className="mr-3 flex h-6 shrink-0 items-center">
                        <div className="group grid size-4 grid-cols-1">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(actor.id)}
                            onChange={() => toggleActor(actor.id)}
                            className="col-start-1 row-start-1 appearance-none rounded-sm border border-gray-300 bg-white checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-white/10 dark:bg-white/5 dark:checked:border-primary dark:checked:bg-primary dark:focus-visible:outline-ring"
                          />
                          <svg
                            fill="none"
                            viewBox="0 0 14 14"
                            className="pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white"
                          >
                            <path
                              d="M3 8L6 11L11 3.5"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="opacity-0 group-has-checked:opacity-100"
                            />
                          </svg>
                        </div>
                      </div>
                      <ActorAvatar actor={actor} />
                      <div className="ml-3 min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                          {actor.displayName}
                        </span>
                        {actor.title ? (
                          <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                            {actor.title}
                          </span>
                        ) : null}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
              {filtered.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                  No actors found
                </div>
              ) : null}
            </div>
          </div>

          {/* Right: selected list */}
          <div className="flex min-h-0 min-w-0 flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-white/5">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                New Conversation
              </h2>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {selectedIds.size > 0
                  ? `${selectedIds.size} selected`
                  : "Select actors"}
              </span>
            </div>

            {/* Selected actors */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {selectedActors.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 dark:bg-white/5">
                    <Bot className="h-8 w-8 text-gray-300 dark:text-gray-600" />
                  </div>
                  <p className="text-sm text-gray-400 dark:text-gray-500">
                    Select actors from the left
                  </p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {selectedActors.map((actor) => (
                    <div
                      key={`sel-${actor.id}`}
                      className="group flex items-center rounded-md px-2 py-2 transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
                    >
                      <ActorAvatar actor={actor} size="sm" />
                      <div className="ml-3 min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                          {actor.displayName}
                        </span>
                        {actor.title ? (
                          <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                            {actor.title}
                          </span>
                        ) : null}
                      </div>
                      <button
                        onClick={() => removeActor(actor.id)}
                        className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-300"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer buttons */}
            <div className="flex justify-end gap-3 border-t border-gray-100 bg-gray-50 px-6 py-4 dark:border-white/5 dark:bg-gray-900">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="rounded-md"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleCreate}
                disabled={selectedIds.size === 0 || loading}
                className="rounded-md"
              >
                Create
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
