"use client"

import { startTransition, useEffect, useMemo, useState } from "react"
import { buildMobileScanUrl } from "@synapse/shared"
import QRCode from "qrcode"
import { useRouter } from "next/navigation"
import {
  Cpu,
  Inbox,
  MessageCircle,
  RefreshCcw,
  Users,
} from "lucide-react"

import { useWorkspace } from "../workspace-provider"
import type {
  ActorAccessRequestListResponse,
  ContactHubDetailResponse,
  ContactHubEntryView,
  ContactHubResponse,
  FriendRequestListResponse,
  IdentitySearchResponse,
  RelationshipProfileView,
} from "@/lib/api"
import { api } from "@/lib/api"
import { resolveFileUrl } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"

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
  }
}

function ContactAvatar({
  entry,
}: {
  entry: ContactHubEntryView
}) {
  return (
    <Avatar className="size-10 rounded-2xl">
      <AvatarImage src={resolveFileUrl(entry.avatarUrl) || undefined} alt={entry.title} />
      <AvatarFallback className="rounded-2xl">
        {entry.targetType === "actor" ? <Cpu className="size-4" /> : entry.title.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

function GroupAvatar({ conversation }: { conversation: ConversationSummaryLike }) {
  const title = conversation.presentation?.title || conversation.title
  const avatarUrl = conversation.presentation?.avatarUrl || conversation.avatarUrl
  return (
    <Avatar className="size-10 rounded-2xl">
      <AvatarImage src={resolveFileUrl(avatarUrl) || undefined} alt={title} />
      <AvatarFallback className="rounded-2xl">
        <Users className="size-4" />
      </AvatarFallback>
    </Avatar>
  )
}

function filterEntry(entry: ContactHubEntryView, query: string) {
  if (!query) return true
  return [entry.title, entry.subtitle, entry.workspace.name, entry.relationLabel]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function filterConversation(conversation: ConversationSummaryLike, query: string) {
  if (!query) return true
  return [
    conversation.title,
    conversation.presentation?.title,
    conversation.lastMessage?.content,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query)
}

function statusBadge(entry: ContactHubEntryView) {
  switch (entry.directState.status) {
    case "existing":
      return <Badge variant="secondary">Existing DM</Badge>
    case "pending_approval":
      return <Badge variant="outline">Pending approval</Badge>
    case "approval_required":
      return <Badge variant="outline">Approval required</Badge>
    default:
      return <Badge variant="outline">{entry.relationLabel}</Badge>
  }
}

export function ContactHubClient() {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [hub, setHub] = useState<ContactHubResponse | null>(null)
  const [detail, setDetail] = useState<ContactHubDetailResponse | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<ContactHubEntryView | null>(null)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [myProfile, setMyProfile] = useState<RelationshipProfileView | null>(null)
  const [friendIdProfile, setFriendIdProfile] = useState<RelationshipProfileView | null>(
    null
  )
  const [friendIdDraft, setFriendIdDraft] = useState("")
  const [friendIdQuery, setFriendIdQuery] = useState("")
  const [friendIdResults, setFriendIdResults] =
    useState<IdentitySearchResponse | null>(null)
  const [friendRequests, setFriendRequests] =
    useState<FriendRequestListResponse | null>(null)
  const [actorAccessRequests, setActorAccessRequests] =
    useState<ActorAccessRequestListResponse | null>(null)
  const [selectedActorProfile, setSelectedActorProfile] =
    useState<RelationshipProfileView | null>(null)
  const [myQrImage, setMyQrImage] = useState<string | null>(null)
  const [actorQrImage, setActorQrImage] = useState<string | null>(null)
  const [submittingRequestId, setSubmittingRequestId] = useState<string | null>(null)
  const [submittingSearchProfileId, setSubmittingSearchProfileId] =
    useState<string | null>(null)
  const [savingFriendId, setSavingFriendId] = useState(false)
  const [searchingFriendId, setSearchingFriendId] = useState(false)

  async function loadHub(nextSelected?: ContactHubEntryView | null) {
    if (!workspaceId) return
    setRefreshing(true)
    try {
      const [
        hubResponse,
        profileResponse,
        friendRequestResponse,
        actorAccessResponse,
      ] = await Promise.all([
        api.getContactHub(workspaceId),
        api.getMyRelationshipProfile(workspaceId),
        api.getFriendRequests(workspaceId),
        api.getActorAccessRequests(workspaceId),
      ])
      setHub(hubResponse)
      setMyProfile(profileResponse)
      setFriendIdProfile(profileResponse)
      setFriendIdDraft(profileResponse.identityId)
      setFriendRequests(friendRequestResponse)
      setActorAccessRequests(actorAccessResponse)

      const selected =
        nextSelected ||
        selectedEntry ||
        hubResponse.workspaceActors[0] ||
        hubResponse.workspaceMembers[0] ||
        hubResponse.friends[0] ||
        null

      setSelectedEntry(selected)
      if (selected) {
        const nextDetail = await api.getContactHubDetail(
          workspaceId,
          selected.kind,
          selected.id
        )
        setDetail(nextDetail)
      } else {
        setDetail(null)
      }
    } catch (error) {
      console.error("Failed to load contact hub:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load contacts")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function handleSaveFriendId() {
    if (!workspaceId || !friendIdProfile) return
    setSavingFriendId(true)
    try {
      const nextProfile = await api.updateMyRelationshipProfile(workspaceId, {
        approvalMode: friendIdProfile.approvalMode,
        identityId: friendIdDraft,
        identitySearchEnabled: friendIdProfile.identitySearchEnabled,
      })
      setFriendIdProfile(nextProfile)
      setMyProfile(nextProfile)
      setFriendIdDraft(nextProfile.identityId)
      toast.success(`Identity ID updated to ${nextProfile.identityId}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update identity ID")
    } finally {
      setSavingFriendId(false)
    }
  }

  async function handleToggleFriendIdSearch() {
    if (!workspaceId || !friendIdProfile) return
    setSavingFriendId(true)
    try {
      const nextProfile = await api.updateMyRelationshipProfile(workspaceId, {
        approvalMode: friendIdProfile.approvalMode,
        identityId: friendIdProfile.identityId,
        identitySearchEnabled: !friendIdProfile.identitySearchEnabled,
      })
      setFriendIdProfile(nextProfile)
      setMyProfile(nextProfile)
      setFriendIdDraft(nextProfile.identityId)
      toast.success(
        nextProfile.identitySearchEnabled
          ? "Identity search is now enabled."
          : "Identity search is now disabled."
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update search visibility"
      )
    } finally {
      setSavingFriendId(false)
    }
  }

  async function handleSearchFriendId() {
    if (!workspaceId) return
    setSearchingFriendId(true)
    try {
      const result = await api.searchIdentity(workspaceId, friendIdQuery)
      setFriendIdResults(result)
      if (result.outcome === "self") {
        toast.message("This is your current workspace identity.")
      } else if (result.outcome === "invalid") {
        toast.error(
          "Identity IDs must be 4-32 chars using letters, numbers, dot, underscore, or hyphen."
        )
      } else if (result.outcome === "not_found") {
        toast.message("No searchable identity matched that ID.")
      } else if (result.outcome === "found" && result.matches.length > 1) {
        toast.message(
          "This account can be added from multiple workspace identities. Pick the right one."
        )
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Identity search failed")
    } finally {
      setSearchingFriendId(false)
    }
  }

  async function handleFriendIdMatchAction(
    match: NonNullable<IdentitySearchResponse["matches"]>[number]
  ) {
    if (!workspaceId) return

    if (match.contact) {
      const opened = await api.openDirectConversation(workspaceId, {
        contactKind: match.contact.kind,
        contactId: match.contact.id,
      })
      if (opened.conversationId) {
        startTransition(() => {
          router.push(`/dashboard/chat?conversation=${opened.conversationId}`)
        })
      }
      return
    }

    if (match.state !== "requestable") return

    setSubmittingSearchProfileId(match.profileId)
    try {
      const result = await api.requestRelationshipByIdentityProfile(
        workspaceId,
        match.profileId
      )
      toast.message(
        result.outcome === "friend_request_created"
          ? "Relationship request created."
          : result.outcome === "friend_request_pending"
            ? "Relationship request is already pending."
            : result.outcome === "friend_active"
              ? "You are already connected."
              : "Request submitted."
      )
      await loadHub(selectedEntry)
      if (friendIdQuery.trim()) {
        const refreshed = await api.searchIdentity(workspaceId, friendIdQuery)
        setFriendIdResults(refreshed)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create relationship")
    } finally {
      setSubmittingSearchProfileId(null)
    }
  }

  useEffect(() => {
    void loadHub(null)
  }, [workspaceId])

  useEffect(() => {
    if (!myProfile?.qrToken) {
      setMyQrImage(null)
      return
    }
    void QRCode.toDataURL(
      buildMobileScanUrl({
        origin: window.location.origin,
        kind: "relationship",
        token: myProfile.qrToken,
      }),
      {
      width: 220,
      margin: 1,
      }
    ).then(setMyQrImage)
  }, [myProfile?.qrToken])

  useEffect(() => {
    if (!workspaceId || selectedEntry?.kind !== "workspace-actor" || !selectedEntry.actorId) {
      setSelectedActorProfile(null)
      setActorQrImage(null)
      return
    }

    let active = true
    void api
      .getActorRelationshipProfile(workspaceId, selectedEntry.actorId)
      .then(async (profile) => {
        if (!active) return
        setSelectedActorProfile(profile)
        if (profile.qrToken) {
          const image = await QRCode.toDataURL(
            buildMobileScanUrl({
              origin: window.location.origin,
              kind: "relationship",
              token: profile.qrToken,
            }),
            { width: 220, margin: 1 }
          )
          if (active) {
            setActorQrImage(image)
          }
        }
      })
      .catch(() => {
        if (!active) return
        setSelectedActorProfile(null)
        setActorQrImage(null)
      })

    return () => {
      active = false
    }
  }, [selectedEntry?.actorId, selectedEntry?.kind, workspaceId])

  async function handleSelectEntry(entry: ContactHubEntryView) {
    if (!workspaceId) return
    setSelectedEntry(entry)
    try {
      const nextDetail = await api.getContactHubDetail(workspaceId, entry.kind, entry.id)
      setDetail(nextDetail)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load contact")
    }
  }

  async function handleOpenDirect(entry: ContactHubEntryView) {
    if (!workspaceId) return
    if (entry.directState.status === "existing" && entry.directState.conversationId) {
      startTransition(() => {
        router.push(`/dashboard/chat?conversation=${entry.directState.conversationId}`)
      })
      return
    }

    const result = await api.openDirectConversation(workspaceId, {
      contactKind: entry.kind,
      contactId: entry.id,
    })
    if (result.status === "pending_approval") {
      toast.message("Request submitted. Wait for approval before starting a DM.")
      await loadHub(entry)
      return
    }
    if (result.conversationId) {
      startTransition(() => {
        router.push(`/dashboard/chat?conversation=${result.conversationId}`)
      })
    }
  }

  async function handleResolveFriend(requestId: string, decision: "approve" | "reject") {
    if (!workspaceId) return
    setSubmittingRequestId(requestId)
    try {
      if (decision === "approve") {
        await api.approveFriendRequest(workspaceId, requestId)
      } else {
        await api.rejectFriendRequest(workspaceId, requestId)
      }
      await loadHub(selectedEntry)
    } finally {
      setSubmittingRequestId(null)
    }
  }

  async function handleResolveActor(requestId: string, decision: "approve" | "reject") {
    if (!workspaceId) return
    setSubmittingRequestId(requestId)
    try {
      if (decision === "approve") {
        await api.approveActorAccessRequest(workspaceId, requestId)
      } else {
        await api.rejectActorAccessRequest(workspaceId, requestId)
      }
      await loadHub(selectedEntry)
    } finally {
      setSubmittingRequestId(null)
    }
  }

  async function handleToggleMyApprovalMode() {
    if (!workspaceId || !myProfile) return
    const nextMode = myProfile.approvalMode === "auto" ? "manual" : "auto"
    const nextProfile = await api.updateMyRelationshipProfile(workspaceId, {
      approvalMode: nextMode,
    })
    setMyProfile(nextProfile)
    setFriendIdProfile(nextProfile)
    toast.success(`My approval mode switched to ${nextMode}.`)
  }

  async function handleToggleActorApprovalMode() {
    if (!workspaceId || !selectedEntry?.actorId || !selectedActorProfile) return
    const nextMode =
      selectedActorProfile.approvalMode === "auto" ? "manual" : "auto"
    const nextProfile = await api.updateActorRelationshipProfile(
      workspaceId,
      selectedEntry.actorId,
      {
        approvalMode: nextMode,
        accessPolicy: selectedActorProfile.accessPolicy,
      }
    )
    setSelectedActorProfile(nextProfile)
    toast.success(`Actor approval mode switched to ${nextMode}.`)
  }

  async function handleToggleActorAccessPolicy() {
    if (!workspaceId || !selectedEntry?.actorId || !selectedActorProfile) return
    const nextPolicy =
      selectedActorProfile.accessPolicy === "workspace_open"
        ? "approval_required"
        : "workspace_open"
    const nextProfile = await api.updateActorRelationshipProfile(
      workspaceId,
      selectedEntry.actorId,
      {
        approvalMode: selectedActorProfile.approvalMode,
        accessPolicy: nextPolicy,
      }
    )
    setSelectedActorProfile(nextProfile)
    await loadHub(selectedEntry)
    toast.success(`Actor access policy switched to ${nextPolicy}.`)
  }

  async function handleToggleActorPublicShare() {
    if (!workspaceId || !selectedEntry?.actorId || !selectedActorProfile) return
    const nextPublicShared = !selectedActorProfile.isPublicShared
    const nextProfile = await api.updateActorRelationshipProfile(
      workspaceId,
      selectedEntry.actorId,
      {
        approvalMode: selectedActorProfile.approvalMode,
        accessPolicy: selectedActorProfile.accessPolicy,
        isPublicShared: nextPublicShared,
      }
    )
    setSelectedActorProfile(nextProfile)
    toast.success(
      nextPublicShared
        ? "Actor public sharing enabled."
        : "Actor public sharing disabled."
    )
  }

  const normalizedQuery = search.trim().toLowerCase()
  const visibleGroups = useMemo(
    () => ((hub?.groups as ConversationSummaryLike[] | undefined) || []).filter((item) => filterConversation(item, normalizedQuery)),
    [hub?.groups, normalizedQuery]
  )
  const visibleActors = useMemo(
    () => (hub?.workspaceActors || []).filter((entry) => filterEntry(entry, normalizedQuery)),
    [hub?.workspaceActors, normalizedQuery]
  )
  const visibleMembers = useMemo(
    () => (hub?.workspaceMembers || []).filter((entry) => filterEntry(entry, normalizedQuery)),
    [hub?.workspaceMembers, normalizedQuery]
  )
  const visibleFriends = useMemo(
    () => (hub?.friends || []).filter((entry) => filterEntry(entry, normalizedQuery)),
    [hub?.friends, normalizedQuery]
  )

  return (
    <div className="grid min-h-0 grid-cols-[24rem_minmax(0,1fr)] gap-6">
      <div className="flex min-h-0 flex-col gap-4">
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center justify-between gap-3">
              <span>Contacts</span>
              <Button variant="outline" size="sm" onClick={() => void loadHub(selectedEntry)}>
                <RefreshCcw className="mr-2 size-4" />
                Refresh
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search groups, actors, members, friends"
                className="rounded-2xl"
              />
            </div>

            {loading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 rounded-2xl" />
                <Skeleton className="h-16 rounded-2xl" />
                <Skeleton className="h-16 rounded-2xl" />
              </div>
            ) : (
              <div className="space-y-5">
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground">Pending requests</h3>
                    <Badge variant="secondary">
                      {hub?.requestSummary.totalPendingCount || 0}
                    </Badge>
                  </div>
                  <div className="space-y-3">
                    {(friendRequests?.incoming || []).slice(0, 2).map((request) => (
                      <div
                        key={request.id}
                        className="rounded-2xl border border-border bg-muted/20 px-4 py-3"
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
                            size="sm"
                            className="flex-1 rounded-full"
                            disabled={submittingRequestId === request.id}
                            onClick={() => void handleResolveFriend(request.id, "approve")}
                          >
                            {submittingRequestId === request.id ? "Working..." : "Approve"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 rounded-full"
                            disabled={submittingRequestId === request.id}
                            onClick={() => void handleResolveFriend(request.id, "reject")}
                          >
                            Reject
                          </Button>
                        </div>
                      </div>
                    ))}
                    {(actorAccessRequests?.incoming || []).slice(0, 2).map((request) => (
                      <div
                        key={request.id}
                        className="rounded-2xl border border-border bg-muted/20 px-4 py-3"
                      >
                        <div className="text-sm font-medium text-foreground">
                          {request.actor?.name || "Unknown actor"}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {request.requester?.name || "A user"} wants to start a DM.
                        </div>
                        <div className="mt-3 flex gap-2">
                          <Button
                            size="sm"
                            className="flex-1 rounded-full"
                            disabled={submittingRequestId === request.id}
                            onClick={() => void handleResolveActor(request.id, "approve")}
                          >
                            {submittingRequestId === request.id ? "Working..." : "Approve"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 rounded-full"
                            disabled={submittingRequestId === request.id}
                            onClick={() => void handleResolveActor(request.id, "reject")}
                          >
                            Reject
                          </Button>
                        </div>
                      </div>
                    ))}
                    {(friendRequests?.incoming || []).length === 0 &&
                    (actorAccessRequests?.incoming || []).length === 0 ? (
                      <div className="rounded-2xl border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                        No pending requests right now.
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">My Identity ID</h3>
                  <div className="rounded-2xl border border-border bg-muted/20 px-4 py-4">
                    <div className="space-y-1">
                      <div className="text-sm text-muted-foreground">
                        Unique to your current workspace identity. Searchability is off by
                        default.
                      </div>
                    </div>
                    <div className="mt-3 space-y-3">
                      <Input
                        value={friendIdDraft}
                        onChange={(event) => setFriendIdDraft(event.target.value)}
                        autoCapitalize="none"
                        autoCorrect="off"
                        placeholder="Set your identity ID"
                        className="rounded-2xl"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          variant="outline"
                          className="rounded-2xl"
                          onClick={() => void handleSaveFriendId()}
                          disabled={savingFriendId || !friendIdDraft.trim()}
                        >
                          {savingFriendId ? "Saving..." : "Save ID"}
                        </Button>
                        <Button
                          variant="outline"
                          className="rounded-2xl"
                          onClick={() => void handleToggleFriendIdSearch()}
                          disabled={savingFriendId || !friendIdProfile}
                        >
                          {friendIdProfile?.identitySearchEnabled
                            ? "Disable search"
                            : "Enable search"}
                        </Button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Add by Identity ID</h3>
                  <div className="rounded-2xl border border-border bg-muted/20 px-4 py-4">
                    <div className="text-sm text-muted-foreground">
                      Search a workspace identity and add the matching member or actor.
                    </div>
                    <div className="mt-3 space-y-3">
                      <Input
                        value={friendIdQuery}
                        onChange={(event) => setFriendIdQuery(event.target.value)}
                        autoCapitalize="none"
                        autoCorrect="off"
                        placeholder="Enter an identity ID"
                        className="rounded-2xl"
                      />
                      <Button
                        variant="outline"
                        className="w-full rounded-2xl"
                        onClick={() => void handleSearchFriendId()}
                        disabled={searchingFriendId}
                      >
                        {searchingFriendId ? "Searching..." : "Search identity"}
                      </Button>
                      {friendIdResults?.matches?.length ? (
                        <div className="space-y-3">
                          {friendIdResults.matches.map((match) => (
                            <div
                              key={match.profileId}
                              className="rounded-2xl border border-border/70 bg-background px-3 py-3"
                            >
                              <div className="text-sm font-medium text-foreground">
                                {match.title}
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                {match.subtitle}
                              </div>
                              <div className="mt-2 text-xs text-muted-foreground">
                                {match.state === "same_workspace_member"
                                  ? "Same workspace member"
                                  : match.state === "friend"
                                    ? "Already a friend"
                                    : match.state === "available"
                                      ? "Available for DM"
                                      : match.state === "approval_required"
                                        ? "Approval required"
                                        : match.state === "pending_approval"
                                          ? "Approval pending"
                                          : match.state === "existing"
                                            ? "Already connected"
                                    : match.state === "pending_request"
                                      ? "Friend request pending"
                                      : "Can send relationship request"}
                              </div>
                              <Button
                                variant="outline"
                                className="mt-3 w-full rounded-2xl"
                                onClick={() => void handleFriendIdMatchAction(match)}
                                disabled={
                                  match.state === "pending_request" ||
                                  match.state === "pending_approval" ||
                                  submittingSearchProfileId === match.profileId
                                }
                              >
                                {match.state === "same_workspace_member" ||
                                match.state === "friend" ||
                                match.state === "available" ||
                                match.state === "existing"
                                  ? "Open DM"
                                  : match.state === "pending_request" ||
                                      match.state === "pending_approval"
                                    ? "Pending"
                                    : submittingSearchProfileId === match.profileId
                                      ? "Submitting..."
                                      : "Request"}
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Groups</h3>
                  <div className="space-y-2">
                    {visibleGroups.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => router.push(`/dashboard/chat?conversation=${conversation.id}`)}
                        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 px-3 py-3 text-left transition-colors hover:bg-accent/40"
                      >
                        <GroupAvatar conversation={conversation} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {conversation.presentation?.title || conversation.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {conversation.lastMessage?.content || "Open group chat"}
                          </div>
                        </div>
                        <Badge variant="outline">Group</Badge>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Actors</h3>
                  <div className="space-y-2">
                    {visibleActors.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.id}`}
                        type="button"
                        onClick={() => void handleSelectEntry(entry)}
                        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
                          selectedEntry?.kind === entry.kind && selectedEntry?.id === entry.id
                            ? "border-primary bg-accent"
                            : "border-border/70 hover:bg-accent/40"
                        }`}
                      >
                        <ContactAvatar entry={entry} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {entry.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {entry.subtitle || entry.workspace.name}
                          </div>
                        </div>
                        {statusBadge(entry)}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Workspace members</h3>
                  <div className="space-y-2">
                    {visibleMembers.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.id}`}
                        type="button"
                        onClick={() => void handleSelectEntry(entry)}
                        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
                          selectedEntry?.kind === entry.kind && selectedEntry?.id === entry.id
                            ? "border-primary bg-accent"
                            : "border-border/70 hover:bg-accent/40"
                        }`}
                      >
                        <ContactAvatar entry={entry} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {entry.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {entry.subtitle}
                          </div>
                        </div>
                        {statusBadge(entry)}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Friends</h3>
                  <div className="space-y-2">
                    {visibleFriends.map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.id}`}
                        type="button"
                        onClick={() => void handleSelectEntry(entry)}
                        className={`flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors ${
                          selectedEntry?.kind === entry.kind && selectedEntry?.id === entry.id
                            ? "border-primary bg-accent"
                            : "border-border/70 hover:bg-accent/40"
                        }`}
                      >
                        <ContactAvatar entry={entry} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {entry.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {entry.subtitle}
                          </div>
                        </div>
                        {statusBadge(entry)}
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="min-h-0">
        {selectedEntry && detail ? (
          <div className="grid gap-4">
            <Card>
              <CardContent className="flex items-start gap-4 pt-6">
                <ContactAvatar entry={selectedEntry} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-xl font-semibold text-foreground">
                      {selectedEntry.title}
                    </h2>
                    {statusBadge(selectedEntry)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {selectedEntry.subtitle || selectedEntry.workspace.name}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => void handleOpenDirect(selectedEntry)}>
                      <MessageCircle className="mr-2 size-4" />
                      {selectedEntry.directState.status === "existing"
                        ? "Open existing DM"
                        : selectedEntry.directState.status === "approval_required"
                          ? "Request access and DM"
                          : "Start DM"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Shared groups</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(detail.groups as ConversationSummaryLike[]).length > 0 ? (
                    (detail.groups as ConversationSummaryLike[]).map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        onClick={() => router.push(`/dashboard/chat?conversation=${conversation.id}`)}
                        className="flex w-full items-center gap-3 rounded-2xl border border-border/70 px-3 py-3 text-left transition-colors hover:bg-accent/40"
                      >
                        <GroupAvatar conversation={conversation} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {conversation.presentation?.title || conversation.title}
                          </div>
                          <div className="truncate text-sm text-muted-foreground">
                            {conversation.lastMessage?.content || "Open group chat"}
                          </div>
                        </div>
                        <Badge variant="outline">Group</Badge>
                      </button>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                      No shared groups yet.
                    </div>
                  )}
                </CardContent>
              </Card>

              <div className="grid gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle>My QR</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {myQrImage ? (
                      <img
                        src={myQrImage}
                        alt="My relationship QR"
                        className="w-full rounded-2xl border border-border bg-white p-4"
                      />
                    ) : (
                      <Skeleton className="aspect-square rounded-2xl" />
                    )}
                    <p className="text-sm text-muted-foreground">
                      Approval mode: {myProfile?.approvalMode || "manual"}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full rounded-full"
                      onClick={() => void handleToggleMyApprovalMode()}
                    >
                      Switch to {myProfile?.approvalMode === "auto" ? "manual" : "auto"}
                    </Button>
                  </CardContent>
                </Card>

                {selectedEntry.kind === "workspace-actor" && selectedActorProfile ? (
                  <Card>
                    <CardHeader>
                      <CardTitle>Actor QR</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {actorQrImage ? (
                        <img
                          src={actorQrImage}
                          alt="Actor relationship QR"
                          className="w-full rounded-2xl border border-border bg-white p-4"
                        />
                      ) : (
                        <Skeleton className="aspect-square rounded-2xl" />
                      )}
                      <p className="text-sm text-muted-foreground">
                        Approval mode: {selectedActorProfile.approvalMode} · access policy{" "}
                        {selectedActorProfile.accessPolicy} · public share{" "}
                        {selectedActorProfile.isPublicShared ? "on" : "off"}
                      </p>
                      <div className="grid gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full rounded-full"
                          onClick={() => void handleToggleActorApprovalMode()}
                        >
                          Switch approval to{" "}
                          {selectedActorProfile.approvalMode === "auto"
                            ? "manual"
                            : "auto"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full rounded-full"
                          onClick={() => void handleToggleActorAccessPolicy()}
                        >
                          Switch policy to{" "}
                          {selectedActorProfile.accessPolicy === "workspace_open"
                            ? "approval_required"
                            : "workspace_open"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full rounded-full"
                          onClick={() => void handleToggleActorPublicShare()}
                        >
                          Turn public share{" "}
                          {selectedActorProfile.isPublicShared ? "off" : "on"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <Card className="h-full">
            <CardContent className="flex h-full min-h-[28rem] items-center justify-center text-center text-sm text-muted-foreground">
              Select a contact to see details, shared groups, and the direct-conversation action.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
