"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import {
  Bot,
  GripVertical,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"

import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import type {
  ActorModelGroupAssignmentView,
  ModelGroupView,
} from "@synapse/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger(
  "web.dashboard.settings.actor-model-assignment-board"
)

type ActorRecord = {
  id: string
  displayName: string
  role: string
  title: string
}

type GroupRecord = {
  id: string
  name: string
  scope?: "workspace" | "platform" | "workspace_member"
  ownerType?: "workspace" | "platform" | "workspace_member"
  routingStrategy: string
  isDefault: boolean
}

type AssignedGroupRecord = {
  actorId: string
  groupId: string
  priority: number
  groupName: string
  routingStrategy: string
  isDefault: boolean
  workspaceId: string | null
  ownerType?: "workspace" | "platform" | "workspace_member"
}

type DragState =
  | { source: "available"; group: GroupRecord }
  | { source: "assigned"; group: AssignedGroupRecord; index: number }
  | null

function normalizeActor(actor: any): ActorRecord {
  const definition = actor?.definition || actor
  return {
    id: actor.id,
    displayName:
      actor.displayName || definition.title || actor.title || "Actor",
    role: definition.role,
    title: definition.title,
  }
}

function normalizeVisibleGroup(group: ModelGroupView): GroupRecord {
  return {
    id: group.id,
    name: group.name,
    scope: group.scope,
    ownerType: group.ownerType,
    routingStrategy: group.routingStrategy,
    isDefault: Boolean(group.isDefault),
  }
}

function normalizeAssignedGroup(
  group: ActorModelGroupAssignmentView
): AssignedGroupRecord {
  return {
    actorId: group.actorId,
    groupId: group.groupId,
    priority: group.priority,
    groupName: group.groupName,
    routingStrategy: group.routingStrategy,
    isDefault: Boolean(group.isDefault),
    workspaceId: group.workspaceId ?? null,
    ownerType: group.ownerType,
  }
}

function actorRoleTone(role: string) {
  switch (role) {
    case "secretary":
      return "bg-blue-500/10 text-blue-500 border-blue-500/20"
    case "manager":
      return "bg-orange-500/10 text-orange-500 border-orange-500/20"
    case "specialist":
      return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
    default:
      return "bg-muted text-muted-foreground border-border"
  }
}

function groupScopeLabel(group: { scope?: string; ownerType?: string }) {
  switch (group.scope || group.ownerType) {
    case "platform":
      return "Platform"
    case "workspace_member":
      return "Member"
    default:
      return "Workspace"
  }
}

function sameAssignment(
  left: AssignedGroupRecord[],
  right: AssignedGroupRecord[]
) {
  if (left.length !== right.length) return false
  return left.every((group, index) => {
    const target = right[index]
    return (
      target &&
      group.groupId === target.groupId &&
      group.priority === target.priority
    )
  })
}

function assignmentSignature(groups: AssignedGroupRecord[]) {
  return groups.map((group) => `${group.groupId}:${group.priority}`).join("|")
}

function AssignedCard({
  group,
  index,
  onRemove,
  onDragStart,
}: {
  group: AssignedGroupRecord
  index: number
  onRemove: () => void
  onDragStart: () => void
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="flex items-start gap-3 rounded-2xl border border-border bg-background px-3 py-3"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <GripVertical className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">#{index + 1}</Badge>
          <span className="truncate font-medium text-foreground">
            {group.groupName}
          </span>
          <Badge variant="outline">{groupScopeLabel(group)}</Badge>
          {group.isDefault ? <Badge variant="outline">Default</Badge> : null}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {group.routingStrategy.replaceAll("_", " ")}
        </div>
      </div>
      <Button variant="ghost" size="icon" onClick={onRemove}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function DropSlot({
  active,
  onDragOver,
  onDrop,
}: {
  active: boolean
  onDragOver: () => void
  onDrop: () => void
}) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
      className={`h-3 rounded-full transition-colors ${active ? "bg-primary/30" : "bg-transparent hover:bg-accent"}`}
    />
  )
}

export default function ActorModelAssignmentBoard() {
  const { workspaceId } = useWorkspace()
  const [actors, setActors] = useState<ActorRecord[]>([])
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null)
  const [assignedGroups, setAssignedGroups] = useState<AssignedGroupRecord[]>(
    []
  )
  const [persistedGroups, setPersistedGroups] = useState<AssignedGroupRecord[]>(
    []
  )
  const [visibleGroups, setVisibleGroups] = useState<GroupRecord[]>([])
  const [loadingActors, setLoadingActors] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")
  const [dragState, setDragState] = useState<DragState>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const deferredSearch = useDeferredValue(search)
  const latestAssignedRef = useRef<AssignedGroupRecord[]>([])
  const selectedActorIdRef = useRef<string | null>(null)
  const workspaceIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    const currentWorkspaceId = workspaceId
    let cancelled = false

    async function loadActors() {
      setLoadingActors(true)
      try {
        const response = await api.getActors(currentWorkspaceId)
        if (cancelled) return

        const nextActors = response.map(normalizeActor)
        setActors(nextActors)
        setSelectedActorId((current) =>
          current &&
          nextActors.some((actor: ActorRecord) => actor.id === current)
            ? current
            : nextActors[0]?.id || null
        )
      } catch (error) {
        clientLog.error("Failed to load actors for model assignment:", error)
        setActors([])
        setSelectedActorId(null)
      } finally {
        if (!cancelled) setLoadingActors(false)
      }
    }

    void loadActors()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  useEffect(() => {
    latestAssignedRef.current = assignedGroups
  }, [assignedGroups])

  useEffect(() => {
    selectedActorIdRef.current = selectedActorId
  }, [selectedActorId])

  useEffect(() => {
    workspaceIdRef.current = workspaceId
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !selectedActorId) {
      setAssignedGroups([])
      setPersistedGroups([])
      setVisibleGroups([])
      return
    }

    const currentWorkspaceId = workspaceId
    const currentActorId = selectedActorId
    let cancelled = false

    async function loadActorData() {
      setLoadingDetail(true)
      try {
        const [assignedResponse, visibleResponse] = await Promise.all([
          api.getActorModelGroups(currentWorkspaceId, currentActorId),
          api.getVisibleActorModelGroups(currentWorkspaceId, currentActorId),
        ])

        if (cancelled) return

        const nextAssigned = assignedResponse.map(normalizeAssignedGroup)
        const nextVisible = visibleResponse.map(normalizeVisibleGroup)
        setAssignedGroups(nextAssigned)
        setPersistedGroups(nextAssigned)
        setVisibleGroups(nextVisible)
      } catch (error) {
        clientLog.error("Failed to load actor assignment detail:", error)
        setAssignedGroups([])
        setPersistedGroups([])
        setVisibleGroups([])
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    }

    void loadActorData()
    return () => {
      cancelled = true
    }
  }, [selectedActorId, workspaceId])

  const filteredActors = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    if (!needle) return actors
    return actors.filter((actor) => {
      const haystack =
        `${actor.displayName} ${actor.role} ${actor.title}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [actors, deferredSearch])

  const selectedActor = useMemo(
    () => actors.find((actor) => actor.id === selectedActorId) || null,
    [actors, selectedActorId]
  )

  const availableGroups = useMemo(
    () =>
      visibleGroups.filter(
        (group) =>
          !assignedGroups.some((assigned) => assigned.groupId === group.id)
      ),
    [assignedGroups, visibleGroups]
  )

  const dirty = !sameAssignment(assignedGroups, persistedGroups)

  useEffect(() => {
    if (!workspaceId || !selectedActorId || !dirty) return

    const currentWorkspaceId = workspaceId
    const currentActorId = selectedActorId
    const snapshot = assignedGroups.map((group, index) => ({
      ...group,
      priority: index,
    }))
    const snapshotSignature = assignmentSignature(snapshot)

    const timer = setTimeout(async () => {
      setSaving(true)
      try {
        const response = await api.setActorModelGroups(
          currentWorkspaceId,
          currentActorId,
          snapshot.map((group, index) => ({
            groupId: group.groupId,
            priority: index,
          }))
        )
        const nextAssigned = response.map(normalizeAssignedGroup)

        if (
          workspaceIdRef.current !== currentWorkspaceId ||
          selectedActorIdRef.current !== currentActorId
        ) {
          return
        }

        setPersistedGroups(nextAssigned)
        if (
          assignmentSignature(latestAssignedRef.current) === snapshotSignature
        ) {
          setAssignedGroups(nextAssigned)
        }
      } catch (error) {
        clientLog.error("Failed to save actor model assignment:", error)
      } finally {
        if (
          workspaceIdRef.current === currentWorkspaceId &&
          selectedActorIdRef.current === currentActorId
        ) {
          setSaving(false)
        }
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [assignedGroups, dirty, selectedActorId, workspaceId])

  function reorderAssigned(next: AssignedGroupRecord[]) {
    setAssignedGroups(
      next.map((group, index) => ({ ...group, priority: index }))
    )
  }

  function handleDrop(targetIndex: number) {
    if (!dragState || !selectedActor) return

    if (dragState.source === "available") {
      if (assignedGroups.some((group) => group.groupId === dragState.group.id))
        return

      const next = [...assignedGroups]
      next.splice(targetIndex, 0, {
        actorId: selectedActor.id,
        groupId: dragState.group.id,
        priority: targetIndex,
        groupName: dragState.group.name,
        routingStrategy: dragState.group.routingStrategy,
        isDefault: dragState.group.isDefault,
        workspaceId: null,
        ownerType: dragState.group.scope || dragState.group.ownerType,
      })
      reorderAssigned(next)
    } else {
      const next = [...assignedGroups]
      const [moved] = next.splice(dragState.index, 1)
      let insertIndex = targetIndex
      if (dragState.index < targetIndex) {
        insertIndex -= 1
      }
      next.splice(insertIndex, 0, moved)
      reorderAssigned(next)
    }

    setDropIndex(null)
    setDragState(null)
  }

  async function handleReload() {
    if (!workspaceId || !selectedActorId) return
    setLoadingDetail(true)
    try {
      const [assignedResponse, visibleResponse] = await Promise.all([
        api.getActorModelGroups(workspaceId, selectedActorId),
        api.getVisibleActorModelGroups(workspaceId, selectedActorId),
      ])
      const nextAssigned = assignedResponse.map(normalizeAssignedGroup)
      const nextVisible = visibleResponse.map(normalizeVisibleGroup)
      setAssignedGroups(nextAssigned)
      setPersistedGroups(nextAssigned)
      setVisibleGroups(nextVisible)
    } catch (error) {
      clientLog.error("Failed to reload actor model assignment:", error)
    } finally {
      setLoadingDetail(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search actors..."
              className="pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loadingActors ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
              <Skeleton className="h-16 rounded-2xl" />
            </div>
          ) : filteredActors.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredActors.map((actor) => (
                <button
                  key={actor.id}
                  type="button"
                  onClick={() => setSelectedActorId(actor.id)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                    selectedActorId === actor.id
                      ? "border-primary bg-accent"
                      : "border-transparent hover:bg-accent/60"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Bot className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {actor.displayName}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {actor.title || actor.role}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={actorRoleTone(actor.role)}
                    >
                      {actor.role}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Bot className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">
                    No actors found
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Create actors before assigning model groups.
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col">
          <div className="border-b border-border px-6 py-5">
            {selectedActor ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-xl font-semibold text-foreground">
                      {selectedActor.displayName}
                    </h1>
                    <Badge
                      variant="outline"
                      className={actorRoleTone(selectedActor.role)}
                    >
                      {selectedActor.role}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Drag visible groups into the left column. Changes save
                    automatically.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void handleReload()}>
                    <RefreshCw data-icon="inline-start" />
                    Reload
                  </Button>
                  {saving ? (
                    <div className="text-sm text-muted-foreground">
                      Saving...
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-xl font-semibold text-foreground">
                  Actor Assignment
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Select an actor from the left to manage its model chain.
                </p>
              </div>
            )}
          </div>

          <div className="flex-1 p-6">
            {loadingDetail ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Skeleton className="h-[420px] rounded-3xl" />
                <Skeleton className="h-[420px] rounded-3xl" />
              </div>
            ) : selectedActor ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Assigned Order</CardTitle>
                    <CardDescription>
                      Top to bottom is the failover order used for this actor.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    <DropSlot
                      active={dropIndex === 0}
                      onDragOver={() => setDropIndex(0)}
                      onDrop={() => handleDrop(0)}
                    />

                    {assignedGroups.length > 0 ? (
                      assignedGroups.map((group, index) => (
                        <div
                          key={group.groupId}
                          className="flex flex-col gap-2"
                        >
                          <AssignedCard
                            group={group}
                            index={index}
                            onRemove={() =>
                              reorderAssigned(
                                assignedGroups.filter(
                                  (item) => item.groupId !== group.groupId
                                )
                              )
                            }
                            onDragStart={() =>
                              setDragState({ source: "assigned", group, index })
                            }
                          />
                          <DropSlot
                            active={dropIndex === index + 1}
                            onDragOver={() => setDropIndex(index + 1)}
                            onDrop={() => handleDrop(index + 1)}
                          />
                        </div>
                      ))
                    ) : (
                      <div
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault()
                          handleDrop(0)
                        }}
                        className="rounded-2xl border border-dashed border-border px-4 py-12 text-center"
                      >
                        <div className="font-medium text-foreground">
                          No assigned groups
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          Drag visible groups here to build the actor chain.
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Visible Groups</CardTitle>
                    <CardDescription>
                      Drag any visible group into the assigned column.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {availableGroups.length > 0 ? (
                      availableGroups.map((group) => (
                        <div
                          key={group.id}
                          draggable
                          onDragStart={() =>
                            setDragState({ source: "available", group })
                          }
                          className="flex items-start gap-3 rounded-2xl border border-border bg-background px-3 py-3"
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <GripVertical className="size-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate font-medium text-foreground">
                                {group.name}
                              </span>
                              <Badge variant="outline">
                                {groupScopeLabel(group)}
                              </Badge>
                              {group.isDefault ? (
                                <Badge variant="outline">Default</Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 text-sm text-muted-foreground">
                              {group.routingStrategy.replaceAll("_", " ")}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (!selectedActor) return
                              reorderAssigned([
                                ...assignedGroups,
                                {
                                  actorId: selectedActor.id,
                                  groupId: group.id,
                                  priority: assignedGroups.length,
                                  groupName: group.name,
                                  routingStrategy: group.routingStrategy,
                                  isDefault: group.isDefault,
                                  workspaceId: null,
                                  ownerType: group.scope || group.ownerType,
                                },
                              ])
                            }}
                          >
                            <Plus className="size-4" />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-dashed border-border px-4 py-12 text-center">
                        <div className="font-medium text-foreground">
                          No more visible groups
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          Everything currently visible is already assigned.
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              <Card className="max-w-xl">
                <CardHeader>
                  <CardTitle>Select an actor</CardTitle>
                  <CardDescription>
                    Choose an actor on the left to edit its assignment board.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
