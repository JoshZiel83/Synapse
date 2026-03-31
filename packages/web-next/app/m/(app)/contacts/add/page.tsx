"use client"

import { useState } from "react"
import { ChevronLeft, Search } from "lucide-react"
import { useRouter } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { FriendIdSearchMatchView } from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

function buildSearchDetailHref(match: FriendIdSearchMatchView) {
  const params = new URLSearchParams({
    title: match.title,
    subtitle: match.subtitle || "",
    avatarUrl: match.avatarUrl || "",
    workspaceName: match.workspace.name,
    workspaceSlug: match.workspace.slug,
    state: match.state,
  })
  return `/m/contacts/search/${match.profileId}?${params.toString()}`
}

function resultStateLabel(match: FriendIdSearchMatchView) {
  switch (match.state) {
    case "same_workspace_user":
      return "同 workspace 用户"
    case "friend":
      return "已是好友"
    case "pending_request":
      return "好友申请待处理"
    default:
      return "可查看并发起好友申请"
  }
}

export default function MobileAddFriendPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<FriendIdSearchMatchView[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  async function handleSearch() {
    if (!workspaceId) return

    setSearching(true)
    setMessage(null)
    try {
      const result = await api.searchFriendId(workspaceId, query)
      if (result.outcome === "empty") {
        setResults([])
        setMessage("请输入好友 ID。")
        return
      }
      if (result.outcome === "invalid") {
        setResults([])
        setMessage("好友 ID 需为 4-32 位，只能包含字母、数字、点、下划线或短横线。")
        return
      }
      if (result.outcome === "self") {
        setResults([])
        setMessage("这是你自己的好友 ID。")
        return
      }
      if (result.outcome === "not_found" || result.matches.length === 0) {
        setResults([])
        setMessage("没有找到结果。对方可能关闭了 ID 搜索。")
        return
      }

      setResults(result.matches)
      if (result.matches.length === 1) {
        const match = result.matches[0]!
        if (match.contact) {
          router.push(`/m/contacts/${match.contact.kind}/${match.contact.id}`)
        } else {
          router.push(buildSearchDetailHref(match))
        }
        return
      }
      setMessage("同一个账号在多个 workspace 中可被添加，请选择具体身份。")
    } catch (error) {
      setResults([])
      setMessage(error instanceof Error ? error.message : "搜索好友失败。")
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader
        title="添加好友"
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
                输入对方的好友 ID。查到后会进入联系人详情；如果没有结果，会直接在这里提示。
              </p>
              <div className="relative">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="输入好友 ID"
                  className="rounded-2xl pl-9"
                />
              </div>
              <Button
                type="button"
                className="w-full rounded-full"
                onClick={() => void handleSearch()}
                disabled={searching}
              >
                {searching ? "搜索中..." : "搜索好友 ID"}
              </Button>
            </CardContent>
          </Card>

          {searching ? (
            <Skeleton className="h-28 rounded-3xl" />
          ) : message && results.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {message}
              </CardContent>
            </Card>
          ) : results.length > 1 ? (
            <Card>
              <CardContent className="space-y-3 pt-5">
                {results.map((match) => (
                  <button
                    key={match.profileId}
                    type="button"
                    onClick={() => {
                      if (match.contact) {
                        router.push(
                          `/m/contacts/${match.contact.kind}/${match.contact.id}`
                        )
                        return
                      }
                      router.push(buildSearchDetailHref(match))
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 text-left"
                  >
                    <Avatar className="size-11 rounded-2xl">
                      <AvatarImage
                        src={resolveFileUrl(match.avatarUrl) || undefined}
                        alt={match.title}
                      />
                      <AvatarFallback className="rounded-2xl">
                        {match.title.slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {match.title}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {match.subtitle}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {resultStateLabel(match)}
                      </div>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
