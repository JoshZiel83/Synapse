"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { ChevronLeft, Search } from "lucide-react"
import { useRouter } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  ContactHubEntryView,
  ContactHubResponse,
  FriendIdSearchMatchView,
  FriendIdSearchResponse,
} from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

type ConversationSummaryLike = {
  id: string
  title: string
  avatarUrl?: string
  lastMessage?: {
    content: string
  }
  presentation?: {
    title?: string
    avatarUrl?: string
    chatType?: "direct" | "group" | "virtual"
  }
}

function matchesConversation(conversation: ConversationSummaryLike, query: string) {
  if (!query) return false
  return [
    conversation.title,
    conversation.presentation?.title,
    conversation.lastMessage?.content,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function matchesContact(entry: ContactHubEntryView, query: string) {
  if (!query) return false
  return [entry.title, entry.subtitle, entry.workspace.name, entry.relationLabel]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

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

function friendStateLabel(match: FriendIdSearchMatchView) {
  switch (match.state) {
    case "same_workspace_user":
      return "同 workspace 用户"
    case "friend":
      return "已是好友"
    case "pending_request":
      return "好友申请待处理"
    default:
      return "可发起好友申请"
  }
}

export default function MobileGlobalSearchPage() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [conversations, setConversations] = useState<ConversationSummaryLike[]>([])
  const [hub, setHub] = useState<ContactHubResponse | null>(null)
  const [friendIdResults, setFriendIdResults] =
    useState<FriendIdSearchResponse | null>(null)
  const [friendIdMessage, setFriendIdMessage] = useState<string | null>(null)

  const deferredQuery = useDeferredValue(query.trim().toLowerCase())

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    void Promise.all([api.getThreads(workspaceId), api.getContactHub(workspaceId)])
      .then(([threadResponse, hubResponse]) => {
        if (!active) return
        setConversations(threadResponse.conversations as ConversationSummaryLike[])
        setHub(hubResponse)
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

  useEffect(() => {
    if (!workspaceId || !deferredQuery) {
      setFriendIdResults(null)
      setFriendIdMessage(null)
      return
    }

    let active = true
    void api
      .searchFriendId(workspaceId, deferredQuery)
      .then((result) => {
        if (!active) return
        setFriendIdResults(result)
        if (result.outcome === "invalid") {
          setFriendIdMessage("好友 ID 需为 4-32 位，只能包含字母、数字、点、下划线或短横线。")
        } else if (result.outcome === "not_found") {
          setFriendIdMessage("没有匹配的好友 ID。")
        } else if (result.outcome === "self") {
          setFriendIdMessage("这是你自己的好友 ID。")
        } else {
          setFriendIdMessage(null)
        }
      })
      .catch((error) => {
        if (!active) return
        setFriendIdResults(null)
        setFriendIdMessage(error instanceof Error ? error.message : "搜索好友 ID 失败。")
      })

    return () => {
      active = false
    }
  }, [deferredQuery, workspaceId])

  const matchedConversations = useMemo(
    () => conversations.filter((item) => matchesConversation(item, deferredQuery)),
    [conversations, deferredQuery]
  )
  const matchedContacts = useMemo(
    () =>
      [
        ...(hub?.workspaceActors || []),
        ...(hub?.workspaceUsers || []),
        ...(hub?.friends || []),
      ].filter((item) => matchesContact(item, deferredQuery)),
    [deferredQuery, hub?.friends, hub?.workspaceActors, hub?.workspaceUsers]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader
        title="搜索"
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
            <CardContent className="pt-5">
              <div className="relative">
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="搜索群聊记录、联系人或好友 ID"
                  className="rounded-2xl pl-9"
                  autoFocus
                />
              </div>
            </CardContent>
          </Card>

          {loading ? (
            <>
              <Skeleton className="h-28 rounded-3xl" />
              <Skeleton className="h-28 rounded-3xl" />
            </>
          ) : !deferredQuery ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                输入关键词开始搜索。这里会同时搜索会话记录、已有联系人和好友 ID。
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">会话记录</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {matchedConversations.length > 0 ? (
                    matchedConversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => router.push(`/m/chat/${conversation.id}`)}
                        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 text-left"
                      >
                        <Avatar className="size-10 rounded-2xl">
                          <AvatarImage
                            src={
                              resolveFileUrl(
                                conversation.presentation?.avatarUrl ||
                                  conversation.avatarUrl
                              ) || undefined
                            }
                            alt={conversation.presentation?.title || conversation.title}
                          />
                          <AvatarFallback className="rounded-2xl">
                            {(conversation.presentation?.title || conversation.title)
                              .slice(0, 1)
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {conversation.presentation?.title || conversation.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {conversation.lastMessage?.content || "打开会话"}
                          </div>
                        </div>
                        <Badge variant="outline">
                          {conversation.presentation?.chatType === "direct" ? "单聊" : "群聊"}
                        </Badge>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">没有匹配的会话。</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">已有联系人</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {matchedContacts.length > 0 ? (
                    matchedContacts.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.id}`}
                        type="button"
                        onClick={() => router.push(`/m/contacts/${entry.kind}/${entry.id}`)}
                        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 text-left"
                      >
                        <Avatar className="size-10 rounded-2xl">
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
                        <Badge variant="outline">{entry.relationLabel}</Badge>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">没有匹配的联系人。</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">好友 ID</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {friendIdResults?.matches?.length ? (
                    friendIdResults.matches.map((match) => (
                      <button
                        key={match.profileId}
                        type="button"
                        onClick={() => {
                          if (match.contact) {
                            router.push(`/m/contacts/${match.contact.kind}/${match.contact.id}`)
                            return
                          }
                          router.push(buildSearchDetailHref(match))
                        }}
                        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-background px-3 py-3 text-left"
                      >
                        <Avatar className="size-10 rounded-2xl">
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
                            {friendStateLabel(match)}
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {friendIdMessage || "没有匹配的好友 ID。"}
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
