"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  MODEL_GROUP_OWNER_TYPE,
  type ModelGroupOwnerType,
  type ModelGroupRoutingStrategy,
} from "@synapse/shared"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Cpu, Plus, RefreshCw, ChevronRight, Star } from "lucide-react"
import ModelGroupDialog from "./model-group-dialog"
import {
  getModelGroupScopeMeta,
  getModelGroupStrategyLabel,
  resolveModelGroupScope,
  type ModelGroupScope,
  type ModelGroupScopeFilter,
} from "./model-group-shared"

interface ModelGroup {
  id: string
  workspace_id: string | null
  owner_type?: ModelGroupOwnerType
  owner_workspace_id?: string | null
  owner_workspace_member_id?: string | null
  name: string
  description: string
  routing_strategy: ModelGroupRoutingStrategy
  is_default: boolean
  is_active?: boolean
  created_at: string
}

export default function ModelGroupList({
  scope = "all",
  detailOrigin,
}: {
  scope?: ModelGroupScopeFilter
  detailOrigin?: ModelGroupScope | "workspace-member"
}) {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [groups, setGroups] = useState<ModelGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editGroup, setEditGroup] = useState<ModelGroup | null>(null)

  const loadGroups = async () => {
    if (
      scope !== MODEL_GROUP_OWNER_TYPE.PLATFORM &&
      scope !== MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER &&
      !workspaceId
    ) {
      return
    }
    setLoading(true)
    try {
      let nextGroups: ModelGroup[] = []

      if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        const response = await api.getPlatformModelGroups()
        nextGroups = response.groups || []
      } else if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        const response = await api.getWorkspaceMemberModelGroups(workspaceId!)
        nextGroups = response.groups || []
      } else {
        const response = await api.getModelGroups(workspaceId!)
        nextGroups = response.groups || []
      }

      if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE) {
        nextGroups = nextGroups.filter(
          (group) =>
            resolveModelGroupScope(group) === MODEL_GROUP_OWNER_TYPE.WORKSPACE
        )
      }

      setGroups(nextGroups)
    } catch (err) {
      console.error("Failed to load model groups:", err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadGroups()
  }, [workspaceId, scope])

  const handleCreated = () => {
    setDialogOpen(false)
    setEditGroup(null)
    void loadGroups()
  }

  const handleEdit = (group: ModelGroup) => {
    setEditGroup(group)
    setDialogOpen(true)
  }

  const emptyLabel =
    scope === MODEL_GROUP_OWNER_TYPE.PLATFORM
      ? "No platform model groups configured"
      : scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER
        ? "No member model groups configured"
        : "No workspace model groups configured"

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Configure model groups, routing strategies, and failover chains for
          this scope.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadGroups()}
            className="border-gray-200 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/5"
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditGroup(null)
              setDialogOpen(true)
            }}
            className="bg-primary hover:bg-primary/80"
          >
            <Plus className="mr-1 h-4 w-4" /> New Group
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      ) : groups.length === 0 ? (
        <Card className="border-gray-200 bg-white ring-1 ring-gray-200 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
          <CardContent className="flex flex-col items-center py-12">
            <Cpu className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <p className="text-muted-foreground">{emptyLabel}</p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Create a group to manage AI model routing.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onSelect={() => {
                const resolved = resolveModelGroupScope(group)
                const params = new URLSearchParams()
                if (resolved !== MODEL_GROUP_OWNER_TYPE.WORKSPACE) {
                  params.set("scope", resolved)
                }
                params.set(
                  "origin",
                  detailOrigin ||
                    (resolved === MODEL_GROUP_OWNER_TYPE.WORKSPACE
                      ? MODEL_GROUP_OWNER_TYPE.WORKSPACE
                      : resolved)
                )
                router.push(
                  `/models/group/${group.id}/setting?${params.toString()}`
                )
              }}
              detailOrigin={detailOrigin}
              onEdit={() => handleEdit(group)}
            />
          ))}
        </div>
      )}

      <ModelGroupDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditGroup(null)
        }}
        scope={scope === "all" ? MODEL_GROUP_OWNER_TYPE.WORKSPACE : scope}
        group={editGroup}
        onSaved={handleCreated}
      />
    </div>
  )
}

function GroupCard({
  group,
  detailOrigin,
  onSelect,
  onEdit,
}: {
  group: ModelGroup
  detailOrigin?: ModelGroupScope | "workspace-member"
  onSelect: () => void
  onEdit: () => void
}) {
  const resolvedScope = resolveModelGroupScope(group)
  const scopeMeta = getModelGroupScopeMeta(resolvedScope)
  const ScopeIcon = scopeMeta.icon
  const params = new URLSearchParams()

  if (resolvedScope !== MODEL_GROUP_OWNER_TYPE.WORKSPACE) {
    params.set("scope", resolvedScope)
  }
  params.set(
    "origin",
    detailOrigin ||
      (resolvedScope === MODEL_GROUP_OWNER_TYPE.WORKSPACE
        ? MODEL_GROUP_OWNER_TYPE.WORKSPACE
        : resolvedScope)
  )

  return (
    <Card className="group cursor-pointer border-gray-200 bg-white ring-1 ring-gray-200 transition-all hover:border-blue-500/25 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
      <CardContent className="flex items-center justify-between p-4">
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-4 text-left"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-gradient-to-br from-blue-500/20 to-violet-500/20 dark:border-white/10">
            <Cpu className="h-5 w-5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{group.name}</span>
              {group.is_default ? (
                <Badge className="border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
                  <Star className="mr-1 h-3 w-3" /> Default
                </Badge>
              ) : null}
              <Badge className={`${scopeMeta.badgeClassName} text-xs`}>
                <ScopeIcon className="mr-1 h-3 w-3" /> {scopeMeta.label}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {getModelGroupStrategyLabel(group.routing_strategy)}
              </span>
              {group.description ? (
                <span className="max-w-xs truncate text-xs text-muted-foreground/60">
                  {group.description}
                </span>
              ) : null}
            </div>
          </div>
        </button>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
          >
            Edit
          </Button>
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/50 hover:text-primary"
          >
            <Link
              href={`/models/group/${group.id}/setting?${params.toString()}`}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
