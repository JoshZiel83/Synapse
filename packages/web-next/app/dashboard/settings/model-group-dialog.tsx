"use client"

import { useState, useEffect } from "react"
import {
  MODEL_GROUP_OWNER_TYPE,
  MODEL_GROUP_ROUTING_STRATEGY,
  type ModelGroupOwnerType,
  type ModelGroupRoutingStrategy,
} from "@synapse/shared"
import { useWorkspace } from "../workspace-provider"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  MODEL_GROUP_ROUTING_OPTIONS,
  type ModelGroupScope,
} from "./model-group-shared"

interface ModelGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope?: ModelGroupScope
  availableScopes?: ModelGroupScope[]
  group: any | null // null = create, object = edit
  onSaved: () => void
}

export default function ModelGroupDialog({
  open,
  onOpenChange,
  scope = MODEL_GROUP_OWNER_TYPE.WORKSPACE,
  availableScopes,
  group,
  onSaved,
}: ModelGroupDialogProps) {
  const { workspaceId } = useWorkspace()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [strategy, setStrategy] = useState<ModelGroupRoutingStrategy>(
    MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER
  )
  const [isDefault, setIsDefault] = useState(false)
  const [selectedScope, setSelectedScope] = useState<ModelGroupOwnerType>(scope)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (group) {
      setName(group.name || "")
      setDescription(group.description || "")
      setStrategy(
        group.routingStrategy || MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER
      )
      setIsDefault(group.isDefault || false)
      setSelectedScope(scope)
    } else {
      setName("")
      setDescription("")
      setStrategy(MODEL_GROUP_ROUTING_STRATEGY.PRIORITY_FAILOVER)
      setIsDefault(false)
      setSelectedScope(availableScopes?.[0] || scope)
    }
  }, [availableScopes, group, open, scope])

  const handleSave = async () => {
    const effectiveScope = group ? scope : selectedScope
    if (
      (!workspaceId && effectiveScope === MODEL_GROUP_OWNER_TYPE.WORKSPACE) ||
      !name.trim()
    ) {
      return
    }
    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        description: description.trim(),
        routingStrategy: strategy,
        isDefault,
      }
      if (effectiveScope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        if (group) {
          await api.updatePlatformModelGroup(group.id, data)
        } else {
          await api.createPlatformModelGroup(data)
        }
      } else if (effectiveScope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        if (group) {
          await api.updateWorkspaceMemberModelGroup(
            workspaceId!,
            group.id,
            data
          )
        } else {
          await api.createWorkspaceMemberModelGroup(workspaceId!, data)
        }
      } else if (group) {
        await api.updateModelGroup(workspaceId!, group.id, data)
      } else {
        await api.createModelGroup(workspaceId!, data)
      }
      onSaved()
    } catch (err) {
      console.error("Failed to save model group:", err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-gray-200 bg-white ring-1 ring-gray-200 sm:max-w-md dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
        <DialogHeader>
          <DialogTitle>
            {group ? "Edit Model Group" : "Create Model Group"}
          </DialogTitle>
          <DialogDescription>
            {group
              ? "Update group configuration"
              : "Create a new model group to manage AI routing"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!group && (availableScopes?.length || 0) > 1 ? (
            <div className="space-y-2">
              <Label>Scope</Label>
              <select
                value={selectedScope}
                onChange={(event) =>
                  setSelectedScope(event.target.value as ModelGroupOwnerType)
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {availableScopes?.map((option) => (
                  <option key={option} value={option}>
                    {option === MODEL_GROUP_OWNER_TYPE.WORKSPACE
                      ? "Workspace"
                      : option === MODEL_GROUP_OWNER_TYPE.PLATFORM
                        ? "Platform"
                        : "Member"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Primary Models"
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="space-y-2">
            <Label>Routing Strategy</Label>
            <div className="grid gap-2">
              {MODEL_GROUP_ROUTING_OPTIONS.map((s) => (
                <label
                  key={s.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-all ${
                    strategy === s.value
                      ? "border-blue-500/40 bg-blue-500/10"
                      : "border-gray-200 bg-background/30 hover:border-blue-500/20 dark:border-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={s.value}
                    checked={strategy === s.value}
                    onChange={() => setStrategy(s.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-sm">Set as default group for this scope</span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-gray-200 dark:border-white/10"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="bg-primary hover:bg-primary/80"
          >
            {saving ? "Saving..." : group ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
