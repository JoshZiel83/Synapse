"use client"

import { useState } from "react"
import { ChevronLeft } from "lucide-react"
import { useParams, useRouter, useSearchParams } from "next/navigation"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { resolveFileUrl } from "@/lib/utils"
import { api } from "@/lib/api"

type SearchState =
  | "same_workspace_member"
  | "friend"
  | "pending_request"
  | "requestable"
  | "available"
  | "approval_required"
  | "pending_approval"
  | "existing"

function statusLabel(state: SearchState) {
  switch (state) {
    case "same_workspace_member":
      return "同 workspace 成员"
    case "friend":
      return "已是好友"
    case "pending_request":
      return "好友申请待处理"
    case "available":
      return "可直接联系"
    case "approval_required":
      return "需要审批"
    case "pending_approval":
      return "审批中"
    case "existing":
      return "已建立联系"
    default:
      return "可发起关系请求"
  }
}

export default function MobileSearchContactDetailPage() {
  const router = useRouter()
  const params = useParams<{ profileId: string }>()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()
  const profileId = Array.isArray(params.profileId)
    ? params.profileId[0]
    : params.profileId
  const state = (searchParams.get("state") || "requestable") as SearchState
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleRequestRelationship() {
    if (!workspaceId || !profileId || submitting) return
    setSubmitting(true)
    setMessage(null)
    try {
      const result = await api.requestRelationshipByIdentityProfile(workspaceId, profileId)
      if (result.contact) {
        router.replace(`/m/contacts/${result.contact.kind}/${result.contact.id}`)
        return
      }
      setMessage(
        result.outcome === "friend_request_created"
          ? "好友申请已发出。"
          : result.outcome === "friend_request_pending"
            ? "好友申请正在等待处理。"
            : result.outcome === "friend_active"
              ? "已经是好友了。"
              : "操作已提交。"
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发起关系请求失败。")
    } finally {
      setSubmitting(false)
    }
  }

  const title = searchParams.get("title") || "未命名用户"
  const subtitle =
    searchParams.get("subtitle") || searchParams.get("workspaceName") || "外部用户"
  const avatarUrl = searchParams.get("avatarUrl") || ""
  const workspaceName = searchParams.get("workspaceName") || "未知工作区"
  const workspaceSlug = searchParams.get("workspaceSlug") || ""

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
          <Card>
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-center gap-4">
                <Avatar className="size-16 rounded-3xl">
                  <AvatarImage src={resolveFileUrl(avatarUrl) || undefined} alt={title} />
                  <AvatarFallback className="rounded-3xl">
                    {title.slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-semibold text-foreground">
                    {title}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {subtitle}
                  </div>
                </div>
              </div>
              <Button
                type="button"
                className="w-full rounded-full"
                onClick={() => void handleRequestRelationship()}
                disabled={["pending_request", "pending_approval"].includes(state) || submitting}
              >
                {state === "pending_request" || state === "pending_approval"
                  ? "等待处理"
                  : submitting
                    ? "提交中..."
                    : "发起联系"}
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
                <span>状态</span>
                <span className="font-medium text-foreground">{statusLabel(state)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>来源工作区</span>
                <span className="font-medium text-foreground">{workspaceName}</span>
              </div>
              {workspaceSlug ? (
                <div className="flex items-center justify-between gap-3">
                  <span>Workspace ID</span>
                  <span className="font-medium text-foreground">{workspaceSlug}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
