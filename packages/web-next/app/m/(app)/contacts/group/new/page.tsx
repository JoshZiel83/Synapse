"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, Search } from "lucide-react"
import { useRouter } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { ContactHubEntryView, ContactHubResponse } from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

function matchesEntry(entry: ContactHubEntryView, query: string) {
  if (!query) return true
  return [entry.title, entry.subtitle, entry.workspace.name, entry.relationLabel]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

export default function MobileNewGroupPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [hub, setHub] = useState<ContactHubResponse | null>(null)
  const [search, setSearch] = useState("")
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    void api
      .getContactHub(workspaceId)
      .then((result) => {
        if (!active) return
        setHub(result)
      })
      .catch((nextError) => {
        if (!active) return
        setError(nextError instanceof Error ? nextError.message : "群聊发起页加载失败。")
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

  const normalizedQuery = search.trim().toLowerCase()
  const allEntries = useMemo(
    () => [
      ...(hub?.workspaceActors || []),
      ...(hub?.workspaceUsers || []),
      ...(hub?.friends || []),
    ],
    [hub?.friends, hub?.workspaceActors, hub?.workspaceUsers]
  )
  const entries = useMemo(
    () => allEntries.filter((entry) => matchesEntry(entry, normalizedQuery)),
    [allEntries, normalizedQuery]
  )

  const selectedEntries = useMemo(
    () =>
      allEntries.filter((entry) =>
        selectedKeys.includes(`${entry.kind}:${entry.id}`)
      ),
    [allEntries, selectedKeys]
  )

  const selectedActorIds = Array.from(
    new Set(
      selectedEntries
        .map((entry) => entry.actorId)
        .filter((value): value is string => Boolean(value))
    )
  )
  const selectedWorkspaceMemberIds = Array.from(
    new Set(
      selectedEntries
        .map((entry) => entry.workspaceMemberId)
        .filter((value): value is string => Boolean(value))
    )
  )

  function toggleEntry(entry: ContactHubEntryView) {
    const key = `${entry.kind}:${entry.id}`
    setSelectedKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    )
  }

  async function handleCreateGroup() {
    if (!workspaceId || selectedEntries.length === 0 || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      if (
        selectedEntries.some(
          (entry) => entry.targetType === "user" && !entry.workspaceMemberId
        )
      ) {
        throw new Error("存在缺少 workspace 成员身份的用户，暂时无法发起群聊")
      }

      const created = await api.createThread(workspaceId, {
        kind: "group",
        actorIds: selectedActorIds,
        workspaceMemberIds: selectedWorkspaceMemberIds,
      })
      if (!created.conversationId) {
        throw new Error("服务器没有返回 conversationId")
      }
      router.replace(`/m/chat/${created.conversationId}`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "发起群聊失败。")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader
        title="发起群聊"
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-none px-0"
            onClick={() => router.back()}
          >
            <ChevronLeft className="size-5" />
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-[calc(var(--mobile-tab-bar-clearance,0px)+1.5rem)]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 pt-5">
              <p className="text-sm text-muted-foreground">
                选择至少一个对象。当前工作区中的你会自动加入这个群聊。
              </p>
              <div className="relative">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索联系人"
                  className="rounded-2xl pl-9"
                />
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline">Group chat</Badge>
                <span>已选 {selectedEntries.length} 项</span>
              </div>
              <Button
                type="button"
                className="w-full rounded-full"
                onClick={() => void handleCreateGroup()}
                disabled={selectedEntries.length === 0 || submitting}
              >
                {submitting ? "创建中..." : "创建群聊"}
              </Button>
              {error ? (
                <p className="text-sm text-destructive">{error}</p>
              ) : null}
            </CardContent>
          </Card>

          {loading ? (
            <>
              <Skeleton className="h-24 rounded-3xl" />
              <Skeleton className="h-24 rounded-3xl" />
            </>
          ) : (
            <Card>
              <CardContent className="space-y-3 pt-5">
                {entries.length > 0 ? (
                  entries.map((entry) => {
                    const selected = selectedKeys.includes(`${entry.kind}:${entry.id}`)
                    return (
                      <button
                        key={`${entry.kind}:${entry.id}`}
                        type="button"
                        onClick={() => toggleEntry(entry)}
                        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left ${
                          selected
                            ? "border-primary bg-accent"
                            : "border-border/70 bg-background"
                        }`}
                      >
                        <Avatar className="size-11 rounded-2xl">
                          <AvatarImage
                            src={resolveFileUrl(entry.avatarUrl) || undefined}
                            alt={entry.title}
                          />
                          <AvatarFallback className="rounded-2xl">
                            {entry.title.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {entry.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {entry.subtitle || entry.workspace.name}
                          </div>
                        </div>
                        <Badge variant={selected ? "secondary" : "outline"}>
                          {selected ? "已选" : entry.relationLabel}
                        </Badge>
                      </button>
                    )
                  })
                ) : (
                  <p className="text-sm text-muted-foreground">
                    没有匹配到可加入群聊的对象。
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
