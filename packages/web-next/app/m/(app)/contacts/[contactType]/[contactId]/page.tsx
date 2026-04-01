"use client"

import { startTransition, useEffect, useState } from "react"
import { ChevronLeft } from "lucide-react"
import { useParams, useRouter } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type { ContactHubDetailResponse, ContactHubEntryView } from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"

function statusLabel(entry: ContactHubEntryView) {
  switch (entry.directState.status) {
    case "existing":
      return "已有私聊"
    case "pending_approval":
      return "等待批准"
    case "approval_required":
      return "需要申请"
    default:
      return entry.relationLabel
  }
}

function directButtonLabel(entry: ContactHubEntryView) {
  switch (entry.directState.status) {
    case "existing":
      return "进入已有私聊"
    case "pending_approval":
      return "等待批准"
    case "approval_required":
      return "申请访问并发起私聊"
    default:
      return "发起私聊"
  }
}

export default function MobileContactDetailPage() {
  const params = useParams<{ contactType: string; contactId: string }>()
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const contactType = Array.isArray(params.contactType)
    ? params.contactType[0]
    : params.contactType
  const contactId = Array.isArray(params.contactId)
    ? params.contactId[0]
    : params.contactId

  const [detail, setDetail] = useState<ContactHubDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !contactType || !contactId) {
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    void api
      .getContactHubDetail(
        workspaceId,
        contactType as ContactHubEntryView["kind"],
        contactId
      )
      .then((result) => {
        if (!active) return
        setDetail(result)
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [contactId, contactType, workspaceId])

  async function handleOpenDirect() {
    if (!workspaceId || !detail?.contact || submitting) return

    if (
      detail.contact.directState.status === "existing" &&
      detail.contact.directState.conversationId
    ) {
      startTransition(() => {
        router.push(`/m/chat/${detail.contact.directState.conversationId}`)
      })
      return
    }

    setSubmitting(true)
    setMessage(null)
    try {
      const result = await api.openDirectConversation(workspaceId, {
        contactKind: detail.contact.kind,
        contactId: detail.contact.id,
      })
      if (result.status === "pending_approval") {
        setMessage("已提交申请，等待对方批准后才能发起私聊。")
        return
      }
      if (result.conversationId) {
        startTransition(() => {
          router.replace(`/m/chat/${result.conversationId}`)
        })
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发起私聊失败。")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <MobilePageHeader
        title="联系人详情"
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
          {loading ? (
            <>
              <Skeleton className="h-40 rounded-3xl" />
              <Skeleton className="h-36 rounded-3xl" />
            </>
          ) : detail?.contact ? (
            <>
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <div className="flex items-center gap-4">
                    <Avatar className="size-16 rounded-3xl">
                      <AvatarImage
                        src={resolveFileUrl(detail.contact.avatarUrl) || undefined}
                        alt={detail.contact.title}
                      />
                      <AvatarFallback className="rounded-3xl">
                        {detail.contact.title.slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-lg font-semibold text-foreground">
                        {detail.contact.title}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {detail.contact.subtitle || detail.contact.workspace.name}
                      </div>
                    </div>
                    <Badge variant="secondary">{statusLabel(detail.contact)}</Badge>
                  </div>
                  <Button
                    type="button"
                    className="w-full rounded-full"
                    onClick={() => void handleOpenDirect()}
                    disabled={submitting}
                  >
                    {submitting ? "处理中..." : directButtonLabel(detail.contact)}
                  </Button>
                  {message ? (
                    <p className="text-sm text-muted-foreground">{message}</p>
                  ) : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">基础信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <span>类型</span>
                    <span className="font-medium text-foreground">
                      {detail.contact.targetType === "actor" ? "Actor" : "成员"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>来源工作区</span>
                    <span className="font-medium text-foreground">
                      {detail.contact.workspace.name}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>私聊状态</span>
                    <span className="font-medium text-foreground">
                      {statusLabel(detail.contact)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">共同所在群聊</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {detail.groups.length > 0 ? (
                    detail.groups.map((conversation: any) => (
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
                            alt={
                              conversation.presentation?.title || conversation.title
                            }
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
                            {conversation.lastMessage?.content || "打开群聊查看消息"}
                          </div>
                        </div>
                        <Badge variant="outline">群聊</Badge>
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      暂时没有共同群聊。
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                没有找到这个联系人。
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
