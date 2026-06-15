"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  MODEL_API_STYLE,
  MODEL_GROUP_GRANT_SCOPE,
  MODEL_GROUP_GRANT_STATUS,
  MODEL_GROUP_OWNER_TYPE,
  MODEL_SERVER_TOOL,
  getDefaultModelBaseUrl,
  getDefaultModelName,
  getProviderKindForVendor,
  listModelVendorDefinitions,
  vendorSupportsServerTools,
  type ModelApiStyle,
  type ModelGroupGrantScope,
  type ModelGroupGrantStatus,
  type ModelGroupOwnerType,
  type ModelGroupRoutingStrategy,
  type ModelServerTool,
  type ProviderKind,
  type Timestamp,
} from "@synapse/shared"
import {
  ChevronDown,
  Cpu,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { useWorkspace } from "../workspace-provider"
import { useAuthStore } from "@/stores/auth-store"
import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import ModelGroupDialog from "./model-group-dialog"
import {
  getEffectiveMaxTokensLimit,
  getKnownModelOptions,
  getModelConfigValidationMessage,
  getSaveErrorMessage,
} from "./model-config-utils"
import {
  MODEL_GROUP_ROUTING_OPTIONS,
  getModelGroupGrantScopeLabel,
  resolveModelGroupScope,
  type ModelGroupScope,
} from "./model-group-shared"
import type {
  ActorModelGroupSetInput,
  ModelBindingFeaturesInput,
  ModelGroupGrantIssueInput,
  ModelGroupItemCreateInput,
  ModelGroupItemUpdateInput,
  ModelGroupUpdateInput,
} from "@synapse/shared/schemas"

type GrantScope = ModelGroupGrantScope

type ModelGroupSummary = {
  id: string
  workspaceId: string | null
  ownerType?: ModelGroupOwnerType
  ownerWorkspaceId?: string | null
  ownerWorkspaceMemberId?: string | null
  name: string
  description: string
  routingStrategy: ModelGroupRoutingStrategy
  isDefault: boolean
  isActive?: boolean
  createdAt: Timestamp
}

type ModelGroupGrant = {
  id: string
  groupId: string
  grantScope: ModelGroupGrantScope
  workspaceId: string | null
  workspaceMemberId: string | null
  actorId: string | null
  status: ModelGroupGrantStatus
  grantedByWorkspaceMemberId?: string | null
  reason?: string | null
  createdAt?: Timestamp | null
  revokedAt?: Timestamp | null
}

type ModelItem = {
  id: string
  groupId: string | null
  bindingId: string
  currentVersionId: string | null
  displayName: string
  priority: number
  weight: number
  isEnabled: boolean
  version: number | null
  providerKind: ProviderKind
  vendor: string | null
  baseUrl: string | null
  modelName: string | null
  maxOutputTokens: number | null
  capabilityTags: string[]
  features?: Record<string, unknown>
  providerOptions?: Record<string, unknown>
}

type GroupDetail = ModelGroupSummary & {
  grants: ModelGroupGrant[]
  items: ModelItem[]
}

type WorkspaceMember = {
  id: string
  userId: string
  userName?: string
  userEmail?: string
}

type WorkspaceActor = {
  id: string
  displayName?: string
  definition?: {
    title?: string
  }
}

type WorkbenchUser = {
  id?: string
  name?: string
  email?: string
}

type ConfigDraft = {
  displayName: string
  vendor: string
  apiKey: string
  baseUrl: string
  modelName: string
  maxOutputTokens: string
  priority: string
  weight: string
  isEnabled: boolean
  apiStyle: ModelApiStyle
  serverTools: ModelServerTool[]
  multimodalTypes: NonNullable<
    NonNullable<ModelBindingFeaturesInput["multimodal"]>["types"]
  >
  crossTurnToolHistory: boolean
  providerOptionsText: string
}

const SERVER_TOOLS = [
  { key: MODEL_SERVER_TOOL.WEB_SEARCH, label: "Web Search" },
  { key: MODEL_SERVER_TOOL.WEB_FETCH, label: "Web Fetch" },
] as const

const MULTIMODAL_TYPES = [
  { key: "image", label: "Images" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
  { key: "document", label: "Documents" },
] as const

const VENDOR_OPTIONS = listModelVendorDefinitions()
const DEFAULT_VENDOR = VENDOR_OPTIONS[0]?.vendor || "anthropic"
const API_STYLE_OPTIONS = [
  { value: MODEL_API_STYLE.CHAT, label: "Chat Completions" },
  { value: MODEL_API_STYLE.RESPONSES, label: "Responses API" },
] as const

function createDraft(item?: ModelItem | null): ConfigDraft {
  const features = (item?.features || {}) as Record<string, any>
  const multimodal = features.multimodal || {}
  const vendor = item?.vendor || DEFAULT_VENDOR
  const serverTools = new Set<ModelServerTool>(
    SERVER_TOOLS.map((tool) => tool.key)
  )
  const multimodalTypes = new Set(MULTIMODAL_TYPES.map((type) => type.key))

  return {
    displayName: item?.displayName || "",
    vendor,
    apiKey: "",
    baseUrl: item?.baseUrl || getDefaultModelBaseUrl(vendor),
    modelName: item?.modelName || getDefaultModelName(vendor),
    maxOutputTokens: String(item?.maxOutputTokens || 4096),
    priority: String(item?.priority ?? 0),
    weight: String(item?.weight ?? 100),
    isEnabled: item ? Boolean(item.isEnabled) : true,
    apiStyle:
      features.apiStyle === MODEL_API_STYLE.RESPONSES
        ? MODEL_API_STYLE.RESPONSES
        : MODEL_API_STYLE.CHAT,
    serverTools: Array.isArray(features.serverTools)
      ? features.serverTools.filter(
          (value: unknown): value is ModelServerTool =>
            typeof value === "string" &&
            serverTools.has(value as ModelServerTool)
        )
      : [],
    multimodalTypes:
      multimodal.supported && Array.isArray(multimodal.types)
        ? multimodal.types.filter(
            (
              value: unknown
            ): value is NonNullable<
              NonNullable<ModelBindingFeaturesInput["multimodal"]>["types"]
            >[number] =>
              typeof value === "string" &&
              multimodalTypes.has(
                value as (typeof MULTIMODAL_TYPES)[number]["key"]
              )
          )
        : [],
    crossTurnToolHistory: Boolean(features.crossTurnToolHistory),
    providerOptionsText:
      item?.providerOptions && Object.keys(item.providerOptions).length > 0
        ? JSON.stringify(item.providerOptions, null, 2)
        : "",
  }
}

async function fetchGroupsForScope(
  scope: ModelGroupScope,
  workspaceId: string | null
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.getPlatformModelGroups()
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.getWorkspaceMemberModelGroups(workspaceId!)
  }
  if (!workspaceId) {
    return []
  }
  const groups = await api.getModelGroups(workspaceId)
  return groups.filter(
    (group) =>
      resolveModelGroupScope(group) === MODEL_GROUP_OWNER_TYPE.WORKSPACE
  )
}

async function fetchGroupDetail(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.getPlatformModelGroup(groupId)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.getWorkspaceMemberModelGroup(workspaceId!, groupId)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.getModelGroup(workspaceId, groupId)
}

async function updateGroupForScope(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  data: ModelGroupUpdateInput
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.updatePlatformModelGroup(groupId, data)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.updateWorkspaceMemberModelGroup(workspaceId!, groupId, data)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.updateModelGroup(workspaceId, groupId, data)
}

async function issueGrantForGroup(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  data: ModelGroupGrantIssueInput
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.issuePlatformModelGroupGrant(groupId, data)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.issueWorkspaceMemberModelGroupGrant(workspaceId!, groupId, data)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.issueModelGroupGrant(workspaceId, groupId, data)
}

async function revokeGrantForGroup(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  grantId: string
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.revokePlatformModelGroupGrant(groupId, grantId)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.revokeWorkspaceMemberModelGroupGrant(
      workspaceId!,
      groupId,
      grantId
    )
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.revokeModelGroupGrant(workspaceId, groupId, grantId)
}

async function saveItemForGroup(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  itemId: string | null,
  payload: ModelGroupItemCreateInput | ModelGroupItemUpdateInput
) {
  if (itemId) {
    const updatePayload = payload as ModelGroupItemUpdateInput
    if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
      return api.updatePlatformModelItem(groupId, itemId, updatePayload)
    }
    if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
      return api.updateWorkspaceMemberModelItem(
        workspaceId!,
        groupId,
        itemId,
        updatePayload
      )
    }
    if (!workspaceId) {
      throw new Error("Workspace is required")
    }
    return api.updateModelItem(workspaceId, groupId, itemId, updatePayload)
  }

  const createPayload = payload as ModelGroupItemCreateInput
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.addPlatformModelItem(groupId, createPayload)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.addWorkspaceMemberModelItem(workspaceId!, groupId, createPayload)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.addModelItem(workspaceId, groupId, createPayload)
}

async function deleteItemForGroup(
  scope: ModelGroupScope,
  groupId: string,
  workspaceId: string | null,
  itemId: string
) {
  if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
    return api.deletePlatformModelItem(groupId, itemId)
  }
  if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
    return api.deleteWorkspaceMemberModelItem(workspaceId!, groupId, itemId)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.deleteModelItem(workspaceId, groupId, itemId)
}

function grantTargetLabel(
  grant: ModelGroupGrant,
  workspaces: Array<{ id: string; name: string }>,
  members: WorkspaceMember[],
  actors: WorkspaceActor[],
  currentWorkspaceMemberId: string | null,
  currentUser: WorkbenchUser | null
) {
  switch (grant.grantScope) {
    case MODEL_GROUP_GRANT_SCOPE.PLATFORM:
      return "Platform"
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE:
      return (
        workspaces.find((workspace) => workspace.id === grant.workspaceId)
          ?.name || "Workspace"
      )
    case MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER: {
      if (
        grant.workspaceMemberId &&
        currentWorkspaceMemberId === grant.workspaceMemberId
      ) {
        return currentUser?.name || currentUser?.email || "Current member"
      }
      const member = members.find((item) => item.id === grant.workspaceMemberId)
      return (
        member?.userName ||
        member?.userEmail ||
        grant.workspaceMemberId ||
        "Member"
      )
    }
    case MODEL_GROUP_GRANT_SCOPE.ACTOR: {
      const actor = actors.find((item) => item.id === grant.actorId)
      return (
        actor?.displayName ||
        actor?.definition?.title ||
        grant.actorId ||
        "Actor"
      )
    }
    default:
      return "Target"
  }
}

function GrantDialog({
  open,
  onOpenChange,
  onSubmit,
  groupScope,
  workspaces,
  members,
  actors,
  currentWorkspaceMemberId,
  currentUser,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: ModelGroupGrantIssueInput) => Promise<void>
  groupScope: ModelGroupScope
  workspaces: Array<{ id: string; name: string }>
  members: WorkspaceMember[]
  actors: WorkspaceActor[]
  currentWorkspaceMemberId: string | null
  currentUser: WorkbenchUser | null
}) {
  const [grantScope, setGrantScope] = useState<GrantScope>(
    MODEL_GROUP_GRANT_SCOPE.WORKSPACE
  )
  const [workspaceId, setWorkspaceId] = useState("")
  const [workspaceMemberId, setWorkspaceMemberId] = useState("")
  const [actorId, setActorId] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setGrantScope(
      groupScope === MODEL_GROUP_OWNER_TYPE.PLATFORM
        ? MODEL_GROUP_GRANT_SCOPE.PLATFORM
        : MODEL_GROUP_GRANT_SCOPE.WORKSPACE
    )
    setWorkspaceId(workspaces[0]?.id || "")
    setWorkspaceMemberId(currentWorkspaceMemberId || members[0]?.id || "")
    setActorId(actors[0]?.id || "")
    setReason("")
  }, [actors, currentWorkspaceMemberId, groupScope, members, open, workspaces])

  const grantScopeOptions: Array<{ value: GrantScope; label: string }> = [
    ...(groupScope === MODEL_GROUP_OWNER_TYPE.PLATFORM
      ? [{ value: MODEL_GROUP_GRANT_SCOPE.PLATFORM, label: "Platform" }]
      : []),
    { value: MODEL_GROUP_GRANT_SCOPE.WORKSPACE, label: "Workspace" },
    {
      value: MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER,
      label: "Workspace Member",
    },
    ...(actors.length > 0
      ? [{ value: MODEL_GROUP_GRANT_SCOPE.ACTOR, label: "Actor" }]
      : []),
  ]

  const canSubmit =
    grantScope === MODEL_GROUP_GRANT_SCOPE.PLATFORM
      ? true
      : grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE
        ? Boolean(workspaceId)
        : grantScope === MODEL_GROUP_GRANT_SCOPE.ACTOR
          ? Boolean(workspaceId && actorId)
          : Boolean(workspaceMemberId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Grant</DialogTitle>
          <DialogDescription>
            Grant this model group to a workspace, user, or actor target.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label>Grant Scope</Label>
            <select
              value={grantScope}
              onChange={(event) =>
                setGrantScope(event.target.value as GrantScope)
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
            >
              {grantScopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {(grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE ||
            grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER ||
            grantScope === MODEL_GROUP_GRANT_SCOPE.ACTOR) && (
            <div className="space-y-2">
              <Label>Workspace</Label>
              <select
                value={workspaceId}
                onChange={(event) => setWorkspaceId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER && (
            <div className="space-y-2">
              <Label>Workspace Member</Label>
              <select
                value={workspaceMemberId}
                onChange={(event) => setWorkspaceMemberId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.userName || member.userEmail || member.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          {grantScope === MODEL_GROUP_GRANT_SCOPE.ACTOR && (
            <div className="space-y-2">
              <Label>Actor</Label>
              <select
                value={actorId}
                onChange={(event) => setActorId(event.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.displayName || actor.definition?.title || actor.id}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional rationale for this grant"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit || saving}
            onClick={async () => {
              setSaving(true)
              try {
                await onSubmit({
                  grantScope,
                  workspaceId:
                    grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE ||
                    grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER ||
                    grantScope === MODEL_GROUP_GRANT_SCOPE.ACTOR
                      ? workspaceId
                      : undefined,
                  workspaceMemberId:
                    grantScope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER
                      ? workspaceMemberId
                      : undefined,
                  actorId:
                    grantScope === MODEL_GROUP_GRANT_SCOPE.ACTOR
                      ? actorId
                      : undefined,
                  reason: reason.trim() || undefined,
                })
                onOpenChange(false)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? "Saving..." : "Create Grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConfigEditor({
  draft,
  onChange,
  onSave,
  onDelete,
  onCancel,
  saving,
  isNew,
}: {
  draft: ConfigDraft
  onChange: (draft: ConfigDraft) => void
  onSave: () => void
  onDelete?: () => void
  onCancel: () => void
  saving: boolean
  isNew: boolean
}) {
  const providerKind = getProviderKindForVendor(draft.vendor)
  const knownModels = getKnownModelOptions(draft.vendor)
  const maxTokensLimit = getEffectiveMaxTokensLimit(
    draft.vendor,
    draft.modelName
  )
  const modelConfigError = getModelConfigValidationMessage({
    vendor: draft.vendor,
    modelName: draft.modelName,
    maxOutputTokens: draft.maxOutputTokens,
  })
  const providerOptionsError = (() => {
    if (!draft.providerOptionsText.trim()) return ""
    try {
      const parsed = JSON.parse(draft.providerOptionsText)
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        return "Provider options must be a JSON object."
      return ""
    } catch {
      return "Provider options must be valid JSON."
    }
  })()
  const modelDatalistId = `workbench-model-options-${draft.vendor}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  )

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="space-y-2">
            <Label>Display Name</Label>
            <Input
              value={draft.displayName}
              onChange={(event) =>
                onChange({ ...draft, displayName: event.target.value })
              }
              placeholder="e.g. Claude Sonnet"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <select
                value={draft.vendor}
                onChange={(event) => {
                  const nextVendor = event.target.value
                  onChange({
                    ...draft,
                    vendor: nextVendor,
                    baseUrl: getDefaultModelBaseUrl(nextVendor),
                    modelName: getDefaultModelName(nextVendor),
                    serverTools: vendorSupportsServerTools(nextVendor)
                      ? draft.serverTools
                      : [],
                  })
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {VENDOR_OPTIONS.map((option) => (
                  <option key={option.vendor} value={option.vendor}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Provider Kind</Label>
              <Input value={providerKind} readOnly disabled />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Model Name</Label>
              <Input
                value={draft.modelName}
                onChange={(event) =>
                  onChange({ ...draft, modelName: event.target.value })
                }
                list={knownModels.length > 0 ? modelDatalistId : undefined}
                placeholder="claude-sonnet-4-20250514"
              />
              {knownModels.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Suggested models:{" "}
                  {knownModels
                    .slice(0, 6)
                    .map((model) => model.modelName)
                    .join(", ")}
                  {knownModels.length > 6 ? "..." : ""}
                </p>
              ) : null}
              {modelConfigError ? (
                <p className="text-xs text-red-500">{modelConfigError}</p>
              ) : null}
              {knownModels.length > 0 ? (
                <datalist id={modelDatalistId}>
                  {knownModels.map((model) => (
                    <option key={model.modelName} value={model.modelName}>
                      {model.label}
                    </option>
                  ))}
                </datalist>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={draft.apiKey}
              onChange={(event) =>
                onChange({ ...draft, apiKey: event.target.value })
              }
              placeholder={isNew ? "sk-..." : "(leave blank to keep current)"}
            />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input
              value={draft.baseUrl}
              onChange={(event) =>
                onChange({ ...draft, baseUrl: event.target.value })
              }
              placeholder={
                getDefaultModelBaseUrl(draft.vendor) ||
                "https://api.example.com"
              }
            />
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label>Max Output Tokens</Label>
              <Input
                type="number"
                value={draft.maxOutputTokens}
                onChange={(event) =>
                  onChange({ ...draft, maxOutputTokens: event.target.value })
                }
                max={maxTokensLimit}
              />
              {maxTokensLimit ? (
                <p className="text-xs text-muted-foreground">
                  This model supports up to {maxTokensLimit} output tokens.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={draft.priority}
                onChange={(event) =>
                  onChange({ ...draft, priority: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Weight</Label>
              <Input
                type="number"
                value={draft.weight}
                onChange={(event) =>
                  onChange({ ...draft, weight: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <select
                value={draft.isEnabled ? "enabled" : "disabled"}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    isEnabled: event.target.value === "enabled",
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {providerKind === "openai" ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Style</CardTitle>
            </CardHeader>
            <CardContent>
              <select
                value={draft.apiStyle}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    apiStyle:
                      event.target.value === MODEL_API_STYLE.RESPONSES
                        ? MODEL_API_STYLE.RESPONSES
                        : MODEL_API_STYLE.CHAT,
                  })
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none"
              >
                {API_STYLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </CardContent>
          </Card>
        ) : null}

        {vendorSupportsServerTools(draft.vendor) ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Server Tools</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {SERVER_TOOLS.map((tool) => {
                const checked = draft.serverTools.includes(tool.key)
                return (
                  <label
                    key={tool.key}
                    className="flex items-center gap-3 rounded-2xl border border-border p-3"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        onChange({
                          ...draft,
                          serverTools: checked
                            ? draft.serverTools.filter(
                                (value) => value !== tool.key
                              )
                            : [...draft.serverTools, tool.key],
                        })
                      }
                      className="accent-primary"
                    />
                    <span className="font-medium text-foreground">
                      {tool.label}
                    </span>
                  </label>
                )
              })}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Multimodal</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {MULTIMODAL_TYPES.map((type) => {
              const checked = draft.multimodalTypes.includes(type.key)
              return (
                <label
                  key={type.key}
                  className="flex items-center gap-3 rounded-2xl border border-border p-3"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      onChange({
                        ...draft,
                        multimodalTypes: checked
                          ? draft.multimodalTypes.filter(
                              (value) => value !== type.key
                            )
                          : [...draft.multimodalTypes, type.key],
                      })
                    }
                    className="accent-primary"
                  />
                  <span className="font-medium text-foreground">
                    {type.label}
                  </span>
                </label>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Behavior</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <label className="flex items-start gap-3 rounded-2xl border border-border p-3">
              <input
                type="checkbox"
                checked={draft.crossTurnToolHistory}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    crossTurnToolHistory: event.target.checked,
                  })
                }
                className="mt-1 accent-primary"
              />
              <div>
                <div className="font-medium text-foreground">
                  Cross-turn tool history
                </div>
                <div className="text-sm text-muted-foreground">
                  Replay prior tool calls/results across turns.
                </div>
              </div>
            </label>
            <div className="space-y-2">
              <Label>Advanced Provider Options (JSON)</Label>
              <textarea
                value={draft.providerOptionsText}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    providerOptionsText: event.target.value,
                  })
                }
                rows={4}
                spellCheck={false}
                placeholder='{ "reasoning_effort": "high" }'
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none"
              />
              {providerOptionsError ? (
                <p className="text-xs text-red-500">{providerOptionsError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Opaque, vendor-specific options passed through to the
                  provider.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Button
            onClick={onSave}
            disabled={saving || !!modelConfigError || !!providerOptionsError}
          >
            <Save data-icon="inline-start" />
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {!isNew && onDelete ? (
            <Button variant="outline" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              Delete
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default function ModelSettingsWorkbench() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { workspaceId, currentWorkspaceMemberId } = useWorkspace()
  const { user } = useAuthStore()
  const [groups, setGroups] = useState<ModelGroupSummary[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null)
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<"configs" | "grants">(
    "configs"
  )
  const [groupSearch, setGroupSearch] = useState("")
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ModelGroupSummary | null>(
    null
  )
  const [grantDialogOpen, setGrantDialogOpen] = useState(false)
  const [expandedItemId, setExpandedItemId] = useState<string | "new" | null>(
    null
  )
  const [draft, setDraft] = useState<ConfigDraft>(createDraft())
  const [savingConfig, setSavingConfig] = useState(false)
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>(
    []
  )
  const [workspaceActors, setWorkspaceActors] = useState<WorkspaceActor[]>([])
  const [availableWorkspaces, setAvailableWorkspaces] = useState<
    Array<{ id: string; name: string }>
  >([])
  const [creatableScopes, setCreatableScopes] = useState<ModelGroupScope[]>([
    MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER,
  ])
  const [editingField, setEditingField] = useState<
    "name" | "description" | null
  >(null)
  const [groupNameDraft, setGroupNameDraft] = useState("")
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState("")
  const [savingGroupField, setSavingGroupField] = useState<
    "name" | "description" | null
  >(null)
  const [savingGroupSettings, setSavingGroupSettings] = useState<
    "routing" | "default" | null
  >(null)
  const deferredGroupSearch = useDeferredValue(groupSearch)

  async function loadGroups() {
    setGroupsLoading(true)
    try {
      const [workspaceResult, userResult, platformResult, workspacesResult] =
        await Promise.allSettled([
          fetchGroupsForScope(MODEL_GROUP_OWNER_TYPE.WORKSPACE, workspaceId),
          fetchGroupsForScope(
            MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER,
            workspaceId
          ),
          fetchGroupsForScope(MODEL_GROUP_OWNER_TYPE.PLATFORM, workspaceId),
          api.getWorkspaces(),
        ])

      const nextGroups = [
        ...(workspaceResult.status === "fulfilled"
          ? workspaceResult.value
          : []),
        ...(userResult.status === "fulfilled" ? userResult.value : []),
        ...(platformResult.status === "fulfilled" ? platformResult.value : []),
      ].sort((left, right) => {
        const rank = (group: ModelGroupSummary) => {
          const scope = resolveModelGroupScope(group)
          return scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE
            ? 0
            : scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER
              ? 1
              : 2
        }
        return (
          rank(left) - rank(right) ||
          Number(right.isDefault) - Number(left.isDefault) ||
          left.name.localeCompare(right.name)
        )
      })

      setGroups(nextGroups)
      setCreatableScopes([
        ...(workspaceResult.status === "fulfilled"
          ? ([MODEL_GROUP_OWNER_TYPE.WORKSPACE] as ModelGroupScope[])
          : []),
        MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER,
        ...(platformResult.status === "fulfilled"
          ? ([MODEL_GROUP_OWNER_TYPE.PLATFORM] as ModelGroupScope[])
          : []),
      ])

      if (workspacesResult.status === "fulfilled") {
        setAvailableWorkspaces(
          workspacesResult.value.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
          }))
        )
      }

      setSelectedGroupId((current) => {
        const requestedGroupId = searchParams.get("groupId")
        if (
          requestedGroupId &&
          nextGroups.some((group) => group.id === requestedGroupId)
        ) {
          return requestedGroupId
        }
        if (current && nextGroups.some((group) => group.id === current)) {
          return current
        }
        return nextGroups[0]?.id || null
      })
    } catch (error) {
      console.error("Failed to load editable model groups:", error)
      setGroups([])
      setSelectedGroupId(null)
    } finally {
      setGroupsLoading(false)
    }
  }

  async function loadSelectedGroup(groupId: string) {
    const summary = groups.find((group) => group.id === groupId)
    if (!summary) {
      return
    }

    setDetailLoading(true)
    try {
      const response = await fetchGroupDetail(
        resolveModelGroupScope(summary),
        groupId,
        workspaceId
      )
      setSelectedGroup(response as GroupDetail)
      setExpandedItemId(null)
      setDraft(createDraft())
    } catch (error) {
      console.error("Failed to load model group detail:", error)
      setSelectedGroup(null)
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    void loadGroups()
  }, [workspaceId])

  useEffect(() => {
    if (!selectedGroupId) {
      setSelectedGroup(null)
      return
    }
    void loadSelectedGroup(selectedGroupId)
  }, [selectedGroupId, groups])

  useEffect(() => {
    if (!selectedGroupId) return
    if (searchParams.get("groupId") === selectedGroupId) return

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set("groupId", selectedGroupId)
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false })
  }, [pathname, router, searchParams, selectedGroupId])

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceMembers([])
      setWorkspaceActors([])
      return
    }

    Promise.allSettled([
      api.getWorkspaceMembers(workspaceId),
      api.getActors(workspaceId),
    ]).then(([membersResult, actorsResult]) => {
      if (membersResult.status === "fulfilled") {
        const members = membersResult.value ?? []
        setWorkspaceMembers(members as WorkspaceMember[])
      } else {
        setWorkspaceMembers([])
      }

      if (actorsResult.status === "fulfilled") {
        const actors = actorsResult.value ?? []
        setWorkspaceActors(actors as WorkspaceActor[])
      } else {
        setWorkspaceActors([])
      }
    })
  }, [workspaceId])

  useEffect(() => {
    setGroupNameDraft(selectedGroup?.name || "")
    setGroupDescriptionDraft(selectedGroup?.description || "")
    setEditingField(null)
  }, [selectedGroup?.description, selectedGroup?.id, selectedGroup?.name])

  const filteredGroups = useMemo(() => {
    const needle = deferredGroupSearch.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter((group) => {
      const haystack =
        `${group.name} ${group.description} ${group.routingStrategy}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [deferredGroupSearch, groups])

  const currentUser = (user || null) as WorkbenchUser | null

  async function reloadCurrentGroup() {
    if (selectedGroupId) {
      await loadSelectedGroup(selectedGroupId)
    }
  }

  async function handleIssueGrant(payload: ModelGroupGrantIssueInput) {
    if (!selectedGroup) return
    const scope = resolveModelGroupScope(selectedGroup)
    await issueGrantForGroup(scope, selectedGroup.id, workspaceId, payload)
    await reloadCurrentGroup()
  }

  async function handleRevokeGrant(grantId: string) {
    if (!selectedGroup) return
    const scope = resolveModelGroupScope(selectedGroup)
    await revokeGrantForGroup(scope, selectedGroup.id, workspaceId, grantId)
    await reloadCurrentGroup()
  }

  async function handleSaveConfig(itemId: string | null) {
    if (!selectedGroup) return
    if (!draft.displayName.trim()) return
    if (
      !itemId &&
      (!draft.apiKey.trim() || !draft.baseUrl.trim() || !draft.modelName.trim())
    )
      return
    const modelConfigError = getModelConfigValidationMessage({
      vendor: draft.vendor,
      modelName: draft.modelName,
      maxOutputTokens: draft.maxOutputTokens,
    })
    if (modelConfigError) {
      toast.error(modelConfigError)
      return
    }
    let providerOptions: Record<string, unknown> | undefined
    if (draft.providerOptionsText.trim()) {
      try {
        const parsed = JSON.parse(draft.providerOptionsText)
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          toast.error("Provider options must be a JSON object.")
          return
        }
        providerOptions = parsed as Record<string, unknown>
      } catch {
        toast.error("Provider options must be valid JSON.")
        return
      }
    }

    setSavingConfig(true)
    try {
      const providerKind = getProviderKindForVendor(draft.vendor)
      const features: ModelBindingFeaturesInput = {}
      if (providerKind === "openai") {
        features.apiStyle = draft.apiStyle
      }
      if (
        vendorSupportsServerTools(draft.vendor) &&
        draft.serverTools.length > 0
      ) {
        features.serverTools = draft.serverTools
      }
      if (draft.multimodalTypes.length > 0) {
        features.multimodal = {
          supported: true,
          types: draft.multimodalTypes,
        }
      }
      if (draft.crossTurnToolHistory) {
        features.crossTurnToolHistory = true
      }

      const payload: ModelGroupItemUpdateInput = {
        displayName: draft.displayName.trim(),
        priority: parseInt(draft.priority, 10),
        weight: parseInt(draft.weight, 10),
        vendor: draft.vendor,
        providerKind,
        maxOutputTokens: parseInt(draft.maxOutputTokens, 10),
        features,
      }
      if (providerOptions) payload.providerOptions = providerOptions

      if (draft.baseUrl.trim()) payload.baseUrl = draft.baseUrl.trim()
      if (draft.modelName.trim()) payload.modelName = draft.modelName.trim()
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim()
      if (itemId) payload.isEnabled = draft.isEnabled

      const requestPayload:
        | ModelGroupItemCreateInput
        | ModelGroupItemUpdateInput = itemId
        ? payload
        : {
            ...payload,
            apiKey: draft.apiKey.trim(),
            baseUrl: draft.baseUrl.trim(),
            modelName: draft.modelName.trim(),
          }

      const response = await saveItemForGroup(
        resolveModelGroupScope(selectedGroup),
        selectedGroup.id,
        workspaceId,
        itemId,
        requestPayload
      )
      await reloadCurrentGroup()
      setExpandedItemId(itemId || response?.id || null)
    } catch (error) {
      console.error("Failed to save model config:", error)
      toast.error(getSaveErrorMessage(error, "Failed to save model config."))
    } finally {
      setSavingConfig(false)
    }
  }

  async function handleDeleteConfig(itemId: string) {
    if (!selectedGroup) return
    try {
      await deleteItemForGroup(
        resolveModelGroupScope(selectedGroup),
        selectedGroup.id,
        workspaceId,
        itemId
      )
      await reloadCurrentGroup()
      setExpandedItemId(null)
      setDraft(createDraft())
    } catch (error) {
      console.error("Failed to delete model config:", error)
    }
  }

  async function handleUpdateGroupSettings(
    patch: ModelGroupUpdateInput,
    savingKey: "routing" | "default"
  ) {
    if (!selectedGroup) return

    setSavingGroupSettings(savingKey)
    try {
      await updateGroupForScope(
        resolveModelGroupScope(selectedGroup),
        selectedGroup.id,
        workspaceId,
        patch
      )
      await loadGroups()
      await reloadCurrentGroup()
    } catch (error) {
      console.error("Failed to update model group settings:", error)
    } finally {
      setSavingGroupSettings(null)
    }
  }

  async function handleSaveGroupField(field: "name" | "description") {
    if (!selectedGroup) return

    const nextValue =
      field === "name" ? groupNameDraft.trim() : groupDescriptionDraft.trim()
    const currentValue =
      field === "name" ? selectedGroup.name : selectedGroup.description || ""

    if (field === "name" && !nextValue) {
      setGroupNameDraft(selectedGroup.name)
      setEditingField(null)
      return
    }

    if (nextValue === currentValue) {
      setEditingField(null)
      return
    }

    setSavingGroupField(field)
    try {
      const patch: ModelGroupUpdateInput =
        field === "name" ? { name: nextValue } : { description: nextValue }
      await updateGroupForScope(
        resolveModelGroupScope(selectedGroup),
        selectedGroup.id,
        workspaceId,
        patch
      )
      setGroups((current) =>
        current.map((group) =>
          group.id === selectedGroup.id
            ? { ...group, [field]: nextValue }
            : group
        )
      )
      setSelectedGroup((current) =>
        current ? { ...current, [field]: nextValue } : current
      )
      setEditingField(null)
    } catch (error) {
      console.error(`Failed to update model group ${field}:`, error)
      setGroupNameDraft(selectedGroup.name)
      setGroupDescriptionDraft(selectedGroup.description || "")
    } finally {
      setSavingGroupField(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={groupSearch}
                onChange={(event) => setGroupSearch(event.target.value)}
                placeholder="Search groups..."
                className="pl-9"
              />
            </div>
            <Button
              size="icon"
              aria-label="Create model group"
              onClick={() => {
                setEditingGroup(null)
                setGroupDialogOpen(true)
              }}
            >
              <Plus />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {groupsLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
              <Skeleton className="h-24 rounded-2xl" />
            </div>
          ) : filteredGroups.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredGroups.map((group) => {
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setSelectedGroupId(group.id)}
                    className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
                      selectedGroupId === group.id
                        ? "border-primary bg-accent"
                        : "border-transparent hover:bg-accent/60"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {group.name}
                      </div>
                      {group.description ? (
                        <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                          {group.description}
                        </div>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">
                    No editable groups
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Create a group or switch workspace.
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
            {selectedGroup ? (
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {editingField === "name" ? (
                      <Input
                        autoFocus
                        value={groupNameDraft}
                        disabled={savingGroupField === "name"}
                        onChange={(event) =>
                          setGroupNameDraft(event.target.value)
                        }
                        onBlur={() => void handleSaveGroupField("name")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            event.currentTarget.blur()
                          }
                          if (event.key === "Escape") {
                            setGroupNameDraft(selectedGroup.name)
                            setEditingField(null)
                          }
                        }}
                        className="h-10 max-w-md text-base font-semibold"
                      />
                    ) : (
                      <>
                        <h1 className="text-xl font-semibold text-foreground">
                          {selectedGroup.name}
                        </h1>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditingField("name")}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>

                  <div className="flex max-w-2xl items-center gap-2 text-sm text-muted-foreground">
                    {editingField === "description" ? (
                      <Input
                        autoFocus
                        value={groupDescriptionDraft}
                        disabled={savingGroupField === "description"}
                        onChange={(event) =>
                          setGroupDescriptionDraft(event.target.value)
                        }
                        onBlur={() => void handleSaveGroupField("description")}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            event.currentTarget.blur()
                          }
                          if (event.key === "Escape") {
                            setGroupDescriptionDraft(
                              selectedGroup.description || ""
                            )
                            setEditingField(null)
                          }
                        }}
                        placeholder="Add a description"
                        className="h-9 max-w-xl"
                      />
                    ) : (
                      <>
                        <p>
                          {selectedGroup.description ||
                            "Add a description for this model group."}
                        </p>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditingField("description")}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void reloadCurrentGroup()}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Select
                    value={selectedGroup.routingStrategy}
                    onValueChange={(value) => {
                      const nextRouting = MODEL_GROUP_ROUTING_OPTIONS.find(
                        (strategy) => strategy.value === value
                      )?.value
                      if (
                        !nextRouting ||
                        nextRouting === selectedGroup.routingStrategy
                      ) {
                        return
                      }
                      void handleUpdateGroupSettings(
                        { routingStrategy: nextRouting },
                        "routing"
                      )
                    }}
                    disabled={savingGroupSettings !== null}
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="Routing Strategy" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_GROUP_ROUTING_OPTIONS.map((strategy) => (
                        <SelectItem key={strategy.value} value={strategy.value}>
                          {strategy.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedGroup.isDefault ? (
                    <Button variant="outline" disabled>
                      Default
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={savingGroupSettings !== null}
                      onClick={() =>
                        void handleUpdateGroupSettings(
                          { isDefault: true },
                          "default"
                        )
                      }
                    >
                      Set As Default
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-xl font-semibold text-foreground">
                  Model Groups
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  Select a group from the left to manage grants and configs.
                </p>
              </div>
            )}
          </div>

          <div className="flex-1 p-6">
            {detailLoading ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-12 rounded-2xl" />
                <Skeleton className="h-40 rounded-2xl" />
                <Skeleton className="h-56 rounded-2xl" />
              </div>
            ) : selectedGroup ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                  <Tabs
                    value={activeSection}
                    onValueChange={(value) =>
                      setActiveSection(value as "configs" | "grants")
                    }
                  >
                    <TabsList>
                      <TabsTrigger value="configs">
                        <Cpu />
                        Configs
                      </TabsTrigger>
                      <TabsTrigger value="grants">
                        <ShieldCheck />
                        Grants
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>

                  {activeSection === "configs" ? (
                    <Button
                      onClick={() => {
                        setExpandedItemId("new")
                        setDraft(createDraft())
                      }}
                    >
                      <Plus data-icon="inline-start" />
                      New Config
                    </Button>
                  ) : (
                    <Button onClick={() => setGrantDialogOpen(true)}>
                      <ShieldCheck data-icon="inline-start" />
                      New Grant
                    </Button>
                  )}
                </div>

                {activeSection === "configs" ? (
                  <>
                    {expandedItemId === "new" ? (
                      <ConfigEditor
                        draft={draft}
                        onChange={setDraft}
                        onSave={() => void handleSaveConfig(null)}
                        onCancel={() => {
                          setExpandedItemId(null)
                          setDraft(createDraft())
                        }}
                        saving={savingConfig}
                        isNew
                      />
                    ) : null}

                    <div className="flex flex-col gap-3">
                      {selectedGroup.items.map((item) => {
                        const expanded = expandedItemId === item.id
                        return (
                          <div
                            key={item.id}
                            className="rounded-2xl border border-border"
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (expanded) {
                                  setExpandedItemId(null)
                                  setDraft(createDraft())
                                } else {
                                  setExpandedItemId(item.id)
                                  setDraft(createDraft(item))
                                }
                              }}
                              className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left"
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <div
                                  className={`flex size-10 shrink-0 items-center justify-center rounded-2xl ${
                                    item.isEnabled
                                      ? "bg-emerald-500/10 text-emerald-500"
                                      : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  <Cpu className="size-4" />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate font-medium text-foreground">
                                      {item.displayName}
                                    </span>
                                    <Badge variant="secondary">
                                      v{item.version || 1}
                                    </Badge>
                                    {item.vendor ? (
                                      <Badge variant="outline">
                                        {item.vendor}
                                      </Badge>
                                    ) : null}
                                    {item.providerKind ? (
                                      <Badge variant="outline">
                                        {item.providerKind}
                                      </Badge>
                                    ) : null}
                                    {!item.isEnabled ? (
                                      <Badge variant="outline">Disabled</Badge>
                                    ) : null}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                                    <span>
                                      {item.modelName || "No model configured"}
                                    </span>
                                    <span>Priority {item.priority}</span>
                                    <span>Weight {item.weight}</span>
                                  </div>
                                </div>
                              </div>
                              <ChevronDown
                                className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                              />
                            </button>

                            {expanded ? (
                              <div className="border-t border-border px-4 py-4">
                                <ConfigEditor
                                  draft={draft}
                                  onChange={setDraft}
                                  onSave={() => void handleSaveConfig(item.id)}
                                  onDelete={() =>
                                    void handleDeleteConfig(item.id)
                                  }
                                  onCancel={() => {
                                    setExpandedItemId(null)
                                    setDraft(createDraft())
                                  }}
                                  saving={savingConfig}
                                  isNew={false}
                                />
                              </div>
                            ) : null}
                          </div>
                        )
                      })}

                      {selectedGroup.items.length === 0 &&
                      expandedItemId !== "new" ? (
                        <Card>
                          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                            <Cpu className="size-10 text-muted-foreground/60" />
                            <div>
                              <div className="font-medium text-foreground">
                                No configs yet
                              </div>
                              <div className="text-sm text-muted-foreground">
                                Create the first config for this group.
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-3">
                    {selectedGroup.grants
                      .filter(
                        (grant) =>
                          grant.status === MODEL_GROUP_GRANT_STATUS.ACTIVE
                      )
                      .map((grant) => (
                        <div
                          key={grant.id}
                          className="rounded-2xl border border-border px-4 py-4"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-foreground">
                                  {grantTargetLabel(
                                    grant,
                                    availableWorkspaces,
                                    workspaceMembers,
                                    workspaceActors,
                                    currentWorkspaceMemberId,
                                    currentUser
                                  )}
                                </span>
                                <Badge variant="outline">
                                  {getModelGroupGrantScopeLabel(
                                    grant.grantScope
                                  )}
                                </Badge>
                              </div>
                              <div className="mt-1 text-sm text-muted-foreground">
                                {grant.reason || "No explicit reason recorded."}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              onClick={() => void handleRevokeGrant(grant.id)}
                            >
                              Revoke
                            </Button>
                          </div>
                        </div>
                      ))}

                    {selectedGroup.grants.filter(
                      (grant) =>
                        grant.status === MODEL_GROUP_GRANT_STATUS.ACTIVE
                    ).length === 0 ? (
                      <Card>
                        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                          <ShieldCheck className="size-10 text-muted-foreground/60" />
                          <div>
                            <div className="font-medium text-foreground">
                              No explicit grants
                            </div>
                            <div className="text-sm text-muted-foreground">
                              Add a grant to share this group with a workspace,
                              member, or actor.
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ) : null}
                  </div>
                )}
              </div>
            ) : (
              <Card className="max-w-xl">
                <CardHeader>
                  <CardTitle>Select a model group</CardTitle>
                  <CardDescription>
                    Choose a group from the left to manage its grants and
                    configs.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
          </div>
        </div>
      </div>

      <ModelGroupDialog
        open={groupDialogOpen}
        onOpenChange={(open) => {
          setGroupDialogOpen(open)
          if (!open) setEditingGroup(null)
        }}
        scope={
          editingGroup
            ? resolveModelGroupScope(editingGroup)
            : MODEL_GROUP_OWNER_TYPE.WORKSPACE
        }
        availableScopes={creatableScopes}
        group={editingGroup}
        onSaved={() => {
          setGroupDialogOpen(false)
          setEditingGroup(null)
          void loadGroups()
        }}
      />

      <GrantDialog
        open={grantDialogOpen}
        onOpenChange={setGrantDialogOpen}
        groupScope={
          selectedGroup
            ? resolveModelGroupScope(selectedGroup)
            : MODEL_GROUP_OWNER_TYPE.WORKSPACE
        }
        workspaces={availableWorkspaces}
        members={workspaceMembers}
        actors={workspaceActors}
        currentWorkspaceMemberId={currentWorkspaceMemberId}
        currentUser={currentUser}
        onSubmit={handleIssueGrant}
      />
    </div>
  )
}
