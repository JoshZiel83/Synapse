"use client"

import { startTransition, useDeferredValue, useEffect, useState } from "react"
import { extractText, type Actor } from "@synapse/shared"
import { Bot, Mail, Search, Sparkles, Users } from "lucide-react"
import { useRouter } from "next/navigation"

import ChatAvatar from "@/app/dashboard/chat/chat-avatar"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn, resolveFileUrl } from "@/lib/utils"
import { api } from "@/lib/api"
import { useChatStore } from "@/stores/chat-store"

type WorkspaceMember = {
  id: string
  userId: string
  userName?: string
  userEmail?: string
  avatarUrl?: string | null
  trustLevel: string
  joinedAt: string
}

type DirectoryMode = "actors" | "people"

function titleCase(input: string) {
  return input
    .split("_")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function actorSummary(actor: Actor) {
  const docs = [...actor.definition.docs].sort(
    (left, right) => right.priority - left.priority
  )
  const summary = docs
    .map((doc) => extractText(doc.content).replace(/\s+/g, " ").trim())
    .find(Boolean)

  return summary || actor.definition.title || titleCase(actor.definition.role)
}

export default function MobileContactsPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const createGroup = useChatStore((state) => state.createGroup)
  const selectGroup = useChatStore((state) => state.selectGroup)

  const [mode, setMode] = useState<DirectoryMode>("actors")
  const [members, setMembers] = useState<WorkspaceMember[]>([])
  const [actors, setActors] = useState<Actor[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [launchingActorId, setLaunchingActorId] = useState<string | null>(null)

  const deferredSearch = useDeferredValue(search)
  const normalizedQuery = deferredSearch.trim().toLowerCase()

  useEffect(() => {
    if (!workspaceId) return

    let cancelled = false
    setLoading(true)

    void Promise.all([
      api.getWorkspaceMembers(workspaceId),
      api.getActors(workspaceId),
    ])
      .then(([memberResponse, actorResponse]) => {
        if (cancelled) return
        const nextMembers = Array.isArray(memberResponse)
          ? memberResponse
          : (memberResponse?.data || [])
        const nextActors = Array.isArray(actorResponse)
          ? actorResponse
          : (actorResponse?.actors || [])

        setMembers(nextMembers)
        setActors(nextActors.filter((actor: Actor) => actor.isActive))
      })
      .catch((error) => {
        if (cancelled) return
        console.error("Failed to load contacts:", error)
        setMembers([])
        setActors([])
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const visibleActors = normalizedQuery
    ? actors.filter((actor) => {
        const haystack = [
          actor.definition.name,
          actor.definition.title,
          actor.definition.role,
          actorSummary(actor),
        ]
          .join(" ")
          .toLowerCase()
        return haystack.includes(normalizedQuery)
      })
    : actors

  const visibleMembers = normalizedQuery
    ? members.filter((member) => {
        const haystack = [
          member.userName || "",
          member.userEmail || "",
          member.trustLevel || "",
        ]
          .join(" ")
          .toLowerCase()
        return haystack.includes(normalizedQuery)
      })
    : members

  async function handleStartActorChat(actor: Actor) {
    if (!workspaceId || launchingActorId) return
    setLaunchingActorId(actor.id)
    try {
      const groupId = await createGroup(workspaceId, [actor.id])
      selectGroup(groupId)
      startTransition(() => {
        router.push(`/m/chat/${groupId}`)
      })
    } catch (error) {
      console.error("Failed to start actor chat:", error)
    } finally {
      setLaunchingActorId(null)
    }
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
    <div className="flex flex-1 flex-col overflow-y-auto px-4 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Contacts
          </h1>
        </div>

        <div className="-mx-4 space-y-3 border-y border-border/70 bg-background/80 px-4 py-4">
          <div className="grid grid-cols-2 gap-2 rounded-[22px] bg-muted/70 p-1">
            <button
              type="button"
              className={cn(
                "flex items-center justify-center gap-2 rounded-[18px] px-3 py-2 text-sm font-medium transition-colors",
                mode === "actors"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              )}
              onClick={() => setMode("actors")}
            >
              <Sparkles className="size-4" />
              Actors
            </button>
            <button
              type="button"
              className={cn(
                "flex items-center justify-center gap-2 rounded-[18px] px-3 py-2 text-sm font-medium transition-colors",
                mode === "people"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              )}
              onClick={() => setMode("people")}
            >
              <Users className="size-4" />
              People
            </button>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={
                mode === "actors"
                  ? "Search actors..."
                  : "Search people..."
              }
              className="h-11 rounded-full border-border/70 bg-background pl-9"
            />
          </div>
        </div>

        <div className="space-y-3">
          {loading ? (
            <>
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </>
          ) : mode === "actors" ? (
            visibleActors.length > 0 ? (
              <div className="-mx-4 divide-y divide-border/70 border-y border-border/70 bg-background/80">
                {visibleActors.map((actor) => (
                  <div
                    key={actor.id}
                    className="px-4 py-4"
                  >
                  <div className="flex items-start gap-3">
                    <ChatAvatar
                      name={actor.definition.name}
                      avatarUrl={actor.avatarUrl}
                      emoji={
                        typeof actor.definition.config.avatar_emoji === "string"
                          ? actor.definition.config.avatar_emoji
                          : undefined
                      }
                      entityType="actor"
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-medium text-foreground">
                          {actor.definition.name}
                        </div>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {actor.definition.title || titleCase(actor.definition.role)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                        {actorSummary(actor)}
                      </p>
                      <Button
                        size="sm"
                        className="mt-3 rounded-full"
                        onClick={() => void handleStartActorChat(actor)}
                        disabled={launchingActorId === actor.id}
                      >
                        <Bot className="mr-2 size-4" />
                        {launchingActorId === actor.id ? "Starting..." : "Chat"}
                      </Button>
                    </div>
                  </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="-mx-4 border-y border-dashed border-border bg-background/75 px-4 py-8 text-center">
                <p className="text-sm font-medium text-foreground">
                  No actors found
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try a different search query.
                </p>
              </div>
            )
          ) : visibleMembers.length > 0 ? (
            <div className="-mx-4 divide-y divide-border/70 border-y border-border/70 bg-background/80">
              {visibleMembers.map((member) => {
                const displayName = member.userName || "Unknown user"
                return (
                  <div
                    key={member.userId}
                    className="px-4 py-4"
                  >
                  <div className="flex items-start gap-3">
                    <Avatar className="size-12">
                      <AvatarImage
                        src={resolveFileUrl(member.avatarUrl) || undefined}
                        alt={displayName}
                      />
                      <AvatarFallback>
                        {displayName.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {displayName}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                        <Mail className="size-4" />
                        <span className="truncate">
                          {member.userEmail || "No email available"}
                        </span>
                      </div>
                      <div className="mt-2 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        {titleCase(member.trustLevel)}
                      </div>
                    </div>
                  </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="-mx-4 border-y border-dashed border-border bg-background/75 px-4 py-8 text-center">
              <p className="text-sm font-medium text-foreground">
                No people found
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try a different search query.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
