"use client"

import { useEffect, useState } from "react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { MobilePageHeader } from "@/components/mobile-page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  ActorAccessRequestListResponse,
  FriendRequestListResponse,
} from "@/lib/api"
import { api } from "@/lib/api"

export default function MobileContactRequestsPage() {
  const { workspaceId } = useWorkspace()
  const [friendRequests, setFriendRequests] =
    useState<FriendRequestListResponse | null>(null)
  const [actorAccessRequests, setActorAccessRequests] =
    useState<ActorAccessRequestListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [submittingId, setSubmittingId] = useState<string | null>(null)

  async function loadRequests() {
    if (!workspaceId) return
    setLoading(true)
    try {
      const [friendResponse, actorResponse] = await Promise.all([
        api.getFriendRequests(workspaceId),
        api.getActorAccessRequests(workspaceId),
      ])
      setFriendRequests(friendResponse)
      setActorAccessRequests(actorResponse)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadRequests()
  }, [workspaceId])

  async function handleResolveFriend(requestId: string, decision: "approve" | "reject") {
    if (!workspaceId) return
    setSubmittingId(requestId)
    try {
      if (decision === "approve") {
        await api.approveFriendRequest(workspaceId, requestId)
      } else {
        await api.rejectFriendRequest(workspaceId, requestId)
      }
      await loadRequests()
    } finally {
      setSubmittingId(null)
    }
  }

  async function handleResolveActor(requestId: string, decision: "approve" | "reject") {
    if (!workspaceId) return
    setSubmittingId(requestId)
    try {
      if (decision === "approve") {
        await api.approveActorAccessRequest(workspaceId, requestId)
      } else {
        await api.rejectActorAccessRequest(workspaceId, requestId)
      }
      await loadRequests()
    } finally {
      setSubmittingId(null)
    }
  }

  if (!workspaceId) {
    return (
      <div className="flex min-h-svh items-center justify-center px-6">
        <p className="max-w-xs text-center text-sm text-muted-foreground">
          Select a workspace to review requests.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-svh bg-background px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <MobilePageHeader title="Requests" />

        {loading ? (
          <>
            <Skeleton className="h-36 rounded-2xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Incoming friend requests</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(friendRequests?.incoming || []).length > 0 ? (
                  friendRequests?.incoming.map((request) => (
                    <div
                      key={request.id}
                      className="rounded-2xl border border-border/70 bg-background px-4 py-3"
                    >
                      <div className="text-sm font-medium text-foreground">
                        {request.requester?.name || "Unknown user"}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {request.targetType === "actor"
                          ? `Requested actor ${request.targetActor?.name || "Unknown actor"}`
                          : `Requested friendship from ${request.requester?.workspace.name || "another workspace"}`}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button
                          className="flex-1 rounded-full"
                          disabled={submittingId === request.id}
                          onClick={() => void handleResolveFriend(request.id, "approve")}
                        >
                          {submittingId === request.id ? "Working..." : "Approve"}
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1 rounded-full"
                          disabled={submittingId === request.id}
                          onClick={() => void handleResolveFriend(request.id, "reject")}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No pending friend requests.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Incoming actor access requests</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(actorAccessRequests?.incoming || []).length > 0 ? (
                  actorAccessRequests?.incoming.map((request) => (
                    <div
                      key={request.id}
                      className="rounded-2xl border border-border/70 bg-background px-4 py-3"
                    >
                      <div className="text-sm font-medium text-foreground">
                        {request.actor?.name || "Unknown actor"}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {request.requester?.name || "A user"} wants to start a DM.
                      </div>
                      <div className="mt-3 flex gap-2">
                        <Button
                          className="flex-1 rounded-full"
                          disabled={submittingId === request.id}
                          onClick={() => void handleResolveActor(request.id, "approve")}
                        >
                          {submittingId === request.id ? "Working..." : "Approve"}
                        </Button>
                        <Button
                          variant="outline"
                          className="flex-1 rounded-full"
                          disabled={submittingId === request.id}
                          onClick={() => void handleResolveActor(request.id, "reject")}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No pending actor access requests.</p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

