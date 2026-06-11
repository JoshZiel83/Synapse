"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import {
  MODEL_GROUP_OWNER_TYPE,
  type ModelGroupItemView,
  type ModelGroupOwnerType,
  type ModelGroupRoutingStrategy,
} from "@synapse/shared"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ArrowLeft,
  Plus,
  Cpu,
  Trash2,
  Power,
  PowerOff,
  History,
  RefreshCw,
} from "lucide-react"
import ModelItemDialog from "./model-item-dialog"
import ModelItemVersions from "./model-item-versions"
import {
  getModelGroupScopeMeta,
  getModelGroupScopeLabel,
  getModelGroupStrategyLabel,
  type ModelGroupScope,
  type ModelGroupScopeAuto,
} from "./model-group-shared"

type ModelItem = ModelGroupItemView

interface GroupDetail {
  id: string
  name: string
  description: string
  routingStrategy: ModelGroupRoutingStrategy
  isDefault: boolean
  workspaceId: string | null
  ownerType?: ModelGroupOwnerType
  ownerWorkspaceId?: string | null
  ownerWorkspaceMemberId?: string | null
  items: ModelItem[]
}

async function fetchGroupByScope(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.getPlatformModelGroup(groupId)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    if (!workspaceId) {
      throw new Error("Workspace is required")
    }
    return api.getWorkspaceMemberModelGroup(workspaceId, groupId)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.getModelGroup(workspaceId, groupId)
}

export default function ModelGroupDetail({
  groupId,
  scope = "auto",
  backHref,
  onBack,
}: {
  groupId: string
  scope?: ModelGroupScopeAuto
  backHref?: string
  onBack?: () => void
}) {
  const { workspaceId } = useWorkspace()
  const [group, setGroup] = useState<GroupDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [itemDialogOpen, setItemDialogOpen] = useState(false)
  const [editItem, setEditItem] = useState<ModelItem | null>(null)
  const [versionsItemId, setVersionsItemId] = useState<string | null>(null)
  const [resolvedScope, setResolvedScope] = useState<ModelGroupScope>(
    MODEL_GROUP_OWNER_TYPE.WORKSPACE
  )

  const loadGroup = async () => {
    setLoading(true)
    try {
      if (scope !== "auto") {
        const response = await fetchGroupByScope(scope, groupId, workspaceId)
        setGroup(response.group)
        setResolvedScope(scope)
        return
      }

      if (workspaceId) {
        try {
          const response = await fetchGroupByScope(
            MODEL_GROUP_OWNER_TYPE.WORKSPACE,
            groupId,
            workspaceId
          )
          setGroup(response.group)
          setResolvedScope(MODEL_GROUP_OWNER_TYPE.WORKSPACE)
          return
        } catch {}
      }

      try {
        const response = await fetchGroupByScope(
          MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER,
          groupId,
          workspaceId
        )
        setGroup(response.group)
        setResolvedScope(MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER)
        return
      } catch {}

      const response = await fetchGroupByScope(
        MODEL_GROUP_OWNER_TYPE.PLATFORM,
        groupId,
        workspaceId
      )
      setGroup(response.group)
      setResolvedScope(MODEL_GROUP_OWNER_TYPE.PLATFORM)
    } catch (err) {
      console.error("Failed to load model group:", err)
      setGroup(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadGroup()
  }, [workspaceId, groupId, scope])

  const handleToggleItem = async (item: ModelItem) => {
    try {
      if (resolvedScope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        await api.updatePlatformModelItem(groupId, item.id, {
          isEnabled: !item.isEnabled,
        })
      } else if (resolvedScope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        await api.updateWorkspaceMemberModelItem(
          workspaceId!,
          groupId,
          item.id,
          {
            isEnabled: !item.isEnabled,
          }
        )
      } else if (workspaceId) {
        await api.updateModelItem(workspaceId, groupId, item.id, {
          isEnabled: !item.isEnabled,
        })
      }
      await loadGroup()
    } catch (err) {
      console.error("Failed to toggle item:", err)
    }
  }

  const handleDeleteItem = async (itemId: string) => {
    try {
      if (resolvedScope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        await api.deletePlatformModelItem(groupId, itemId)
      } else if (resolvedScope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        await api.deleteWorkspaceMemberModelItem(workspaceId!, groupId, itemId)
      } else if (workspaceId) {
        await api.deleteModelItem(workspaceId, groupId, itemId)
      }
      await loadGroup()
    } catch (err) {
      console.error("Failed to delete item:", err)
    }
  }

  const handleItemSaved = () => {
    setItemDialogOpen(false)
    setEditItem(null)
    void loadGroup()
  }

  if (versionsItemId) {
    return (
      <ModelItemVersions
        groupId={groupId}
        itemId={versionsItemId}
        scope={resolvedScope}
        onBack={() => setVersionsItemId(null)}
      />
    )
  }

  const scopeMeta = getModelGroupScopeMeta(resolvedScope)
  const ScopeIcon = scopeMeta.icon

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4">
        {onBack ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Button>
        ) : backHref ? (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
          >
            <Link href={backHref}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Link>
          </Button>
        ) : null}
        {group && (
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              {group.name}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-blue-500/20 bg-blue-500/10 text-xs text-blue-400">
                {getModelGroupStrategyLabel(group.routingStrategy)}
              </Badge>
              <Badge variant="outline" className="text-xs">
                <ScopeIcon className="mr-1 h-3 w-3" />
                {getModelGroupScopeLabel(resolvedScope)}
              </Badge>
              {group.isDefault ? (
                <Badge className="border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
                  Default
                </Badge>
              ) : null}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      ) : !group ? (
        <p className="text-muted-foreground">Group not found</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {group.items.length} model{group.items.length !== 1 ? "s" : ""}{" "}
              configured
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadGroup()}
                className="border-gray-200 hover:bg-gray-50 dark:border-white/10 dark:hover:bg-white/5"
              >
                <RefreshCw className="mr-1 h-4 w-4" /> Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditItem(null)
                  setItemDialogOpen(true)
                }}
                className="bg-primary hover:bg-primary/80"
              >
                <Plus className="mr-1 h-4 w-4" /> Add Model
              </Button>
            </div>
          </div>

          {group.items.length === 0 ? (
            <Card className="border-gray-200 bg-white ring-1 ring-gray-200 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
              <CardContent className="flex flex-col items-center py-12">
                <Cpu className="mb-4 h-12 w-12 text-muted-foreground/50" />
                <p className="text-muted-foreground">No models in this group</p>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Add a model to start using this group
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3">
              {group.items.map((item) => (
                <Card
                  key={item.id}
                  className={`border-gray-200 bg-white ring-1 ring-gray-200 transition-all dark:border-white/10 dark:bg-gray-900 dark:ring-white/10 ${!item.isEnabled ? "opacity-50" : ""}`}
                >
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-4">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-lg border ${
                          item.isEnabled
                            ? "border-emerald-500/10 bg-gradient-to-br from-emerald-500/20 to-blue-500/20"
                            : "border-red-500/10 bg-red-500/10"
                        }`}
                      >
                        <Cpu
                          className={`h-5 w-5 ${item.isEnabled ? "text-emerald-400" : "text-red-400"}`}
                        />
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">
                            {item.displayName}
                          </span>
                          <Badge className="border-violet-500/20 bg-violet-500/10 text-xs text-violet-400">
                            v{item.version || 1}
                          </Badge>
                          {item.vendor ? (
                            <Badge className="border-blue-500/20 bg-blue-500/10 text-xs text-blue-400">
                              {item.vendor}
                            </Badge>
                          ) : null}
                          {item.providerKind ? (
                            <Badge className="border-slate-500/20 bg-slate-500/10 text-xs text-slate-300">
                              {item.providerKind}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{item.modelName || "No model configured"}</span>
                          <span>Priority: {item.priority}</span>
                          <span>Weight: {item.weight}</span>
                          {item.maxOutputTokens ? (
                            <span>
                              Max output tokens: {item.maxOutputTokens}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setVersionsItemId(item.id)}
                        title="Version history"
                        className="text-muted-foreground hover:text-primary"
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setEditItem(item)
                          setItemDialogOpen(true)
                        }}
                        title="Edit"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Cpu className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleToggleItem(item)}
                        title={item.isEnabled ? "Disable" : "Enable"}
                        className={
                          item.isEnabled
                            ? "text-emerald-400 hover:text-red-400"
                            : "text-red-400 hover:text-emerald-400"
                        }
                      >
                        {item.isEnabled ? (
                          <Power className="h-4 w-4" />
                        ) : (
                          <PowerOff className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleDeleteItem(item.id)}
                        title="Remove"
                        className="text-muted-foreground hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <ModelItemDialog
        open={itemDialogOpen}
        onOpenChange={(open) => {
          setItemDialogOpen(open)
          if (!open) setEditItem(null)
        }}
        groupId={groupId}
        scope={resolvedScope}
        item={editItem}
        onSaved={handleItemSaved}
      />
    </div>
  )
}
