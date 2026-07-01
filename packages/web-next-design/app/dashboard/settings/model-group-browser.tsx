"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import {
  MODEL_API_STYLE,
  MODEL_GROUP_OWNER_TYPE,
  MODEL_SERVER_TOOL,
  getDefaultModelBaseUrl,
  getDefaultModelName,
  getProviderKindForVendor,
  listModelVendorDefinitions,
  vendorSupportsServerTools,
  type ModelApiStyle,
  type ModelGroupDetailView,
  type ModelGroupItemView,
  type ModelGroupView,
  type ModelServerTool,
} from "@synapse/shared"
import { Cpu, Plus, RefreshCw, Save, Search, Star, Trash2 } from "lucide-react"
import { ModelVendorIcon } from "@/components/model-vendor-icons"
import { toast } from "sonner"

import { useWorkspace } from "../workspace-provider"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import ModelGroupDialog from "./model-group-dialog"
import {
  getEffectiveMaxTokensLimit,
  getKnownModelOptions,
  getModelConfigValidationMessage,
  getSaveErrorMessage,
} from "./model-config-utils"
import {
  getModelGroupScopeMeta,
  getModelGroupStrategyLabel,
  resolveModelGroupScope,
  type ModelGroupScope,
} from "./model-group-shared"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.settings.model-group-browser")

// API contract types are single-sourced from @synapse/shared (zod-derived in
// packages/shared/src/schemas/model-groups.ts); these aliases keep call sites terse.
type ModelGroupSummary = ModelGroupView
type ModelItem = ModelGroupItemView
type GroupDetail = ModelGroupDetailView

type ModelItemFormState = {
  displayName: string
  vendor: string
  apiKey: string
  baseUrl: string
  modelName: string
  maxOutputTokens: string
  priority: string
  weight: string
  apiStyle: ModelApiStyle
  serverTools: ModelServerTool[]
  multimodalTypes: string[]
  crossTurnToolHistory: boolean
  providerOptionsText: string
  isEnabled: boolean
}

const SERVER_TOOLS = [
  {
    key: MODEL_SERVER_TOOL.WEB_SEARCH,
    label: "Web Search",
    description: "Allow the model to search the web for real-time information",
  },
  {
    key: MODEL_SERVER_TOOL.WEB_FETCH,
    label: "Web Fetch",
    description: "Allow the model to fetch and read full web page content",
  },
]

const MULTIMODAL_TYPES = [
  { key: "image", label: "Images" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
  { key: "document", label: "Documents" },
]

const VENDOR_OPTIONS = listModelVendorDefinitions()
const DEFAULT_VENDOR = VENDOR_OPTIONS[0]?.vendor || "anthropic"
const API_STYLE_OPTIONS = [
  { value: MODEL_API_STYLE.CHAT, label: "Chat Completions" },
  { value: MODEL_API_STYLE.RESPONSES, label: "Responses API" },
] as const

function createFormState(item?: ModelItem | null): ModelItemFormState {
  const features = (item?.features || {}) as Record<string, any>
  const multimodal = features.multimodal || {}
  const vendor = item?.vendor || DEFAULT_VENDOR

  return {
    displayName: item?.displayName || "",
    vendor,
    apiKey: "",
    baseUrl: item?.baseUrl || getDefaultModelBaseUrl(vendor),
    modelName: item?.modelName || getDefaultModelName(vendor),
    maxOutputTokens: String(item?.maxOutputTokens || 4096),
    priority: String(item?.priority ?? 0),
    weight: String(item?.weight ?? 100),
    apiStyle:
      features.apiStyle === MODEL_API_STYLE.RESPONSES
        ? MODEL_API_STYLE.RESPONSES
        : MODEL_API_STYLE.CHAT,
    serverTools: Array.isArray(features.serverTools)
      ? features.serverTools.filter(
          (tool: unknown): tool is ModelServerTool =>
            tool === MODEL_SERVER_TOOL.WEB_SEARCH ||
            tool === MODEL_SERVER_TOOL.WEB_FETCH
        )
      : [],
    multimodalTypes:
      multimodal.supported && Array.isArray(multimodal.types)
        ? multimodal.types
        : [],
    crossTurnToolHistory: Boolean(features.crossTurnToolHistory),
    providerOptionsText:
      item?.providerOptions && Object.keys(item.providerOptions).length > 0
        ? JSON.stringify(item.providerOptions, null, 2)
        : "",
    isEnabled: item ? Boolean(item.isEnabled) : true,
  }
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
    if (!workspaceId) {
      throw new Error("Workspace is required")
    }
    return api.getWorkspaceMemberModelGroup(workspaceId!, groupId)
  }
  if (!workspaceId) {
    throw new Error("Workspace is required")
  }
  return api.getModelGroup(workspaceId, groupId)
}

function GroupListItem({
  group,
  selected,
  onSelect,
}: {
  group: ModelGroupSummary
  selected: boolean
  onSelect: () => void
}) {
  const resolvedScope = resolveModelGroupScope(group)
  const scopeMeta = getModelGroupScopeMeta(resolvedScope)
  const ScopeIcon = scopeMeta.icon

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        selected
          ? "border-primary bg-accent"
          : "border-transparent hover:bg-accent/60"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Cpu className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {group.name}
            </div>
            {group.isDefault ? (
              <Badge variant="outline">
                <Star className="mr-1 size-3" />
                Default
              </Badge>
            ) : null}
            <Badge className={scopeMeta.badgeClassName}>
              <ScopeIcon className="mr-1 size-3" />
              {scopeMeta.label}
            </Badge>
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {getModelGroupStrategyLabel(group.routingStrategy)}
          </div>
          {group.description ? (
            <div className="mt-1 truncate text-sm text-muted-foreground">
              {group.description}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  )
}

function ConfigListItem({
  item,
  selected,
  onSelect,
}: {
  item: ModelItem
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border px-3 py-3 text-left transition-colors ${
        selected
          ? "border-primary bg-accent"
          : "border-transparent hover:bg-accent/60"
      } ${item.isEnabled ? "" : "opacity-60"}`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl ${
            item.isEnabled
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <ModelVendorIcon vendor={item.vendor} className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {item.displayName}
            </div>
            <Badge variant="secondary">v{item.version || 1}</Badge>
            {item.vendor ? (
              <Badge variant="outline">{item.vendor}</Badge>
            ) : null}
            {item.providerKind ? (
              <Badge variant="outline">{item.providerKind}</Badge>
            ) : null}
            {!item.isEnabled ? <Badge variant="outline">Disabled</Badge> : null}
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground">
            {item.modelName || "No model configured"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Priority {item.priority}</span>
            <span>Weight {item.weight}</span>
            {item.maxOutputTokens ? (
              <span>{item.maxOutputTokens} tokens</span>
            ) : null}
          </div>
        </div>
      </div>
    </button>
  )
}

export default function ModelGroupBrowser({
  scope,
}: {
  scope: ModelGroupScope
}) {
  const { workspaceId } = useWorkspace()
  const [groups, setGroups] = useState<ModelGroupSummary[]>([])
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ModelGroupSummary | null>(
    null
  )
  const [itemDraft, setItemDraft] =
    useState<ModelItemFormState>(createFormState())
  const [savingItem, setSavingItem] = useState(false)
  const [groupSearch, setGroupSearch] = useState("")
  const deferredGroupSearch = useDeferredValue(groupSearch)
  const providerKind = getProviderKindForVendor(itemDraft.vendor)
  const knownModels = getKnownModelOptions(itemDraft.vendor)
  const maxTokensLimit = getEffectiveMaxTokensLimit(
    itemDraft.vendor,
    itemDraft.modelName
  )
  const itemConfigError = getModelConfigValidationMessage({
    vendor: itemDraft.vendor,
    modelName: itemDraft.modelName,
    maxOutputTokens: itemDraft.maxOutputTokens,
  })
  const providerOptionsError = (() => {
    if (!itemDraft.providerOptionsText.trim()) return ""
    try {
      const parsed = JSON.parse(itemDraft.providerOptionsText)
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
  const modelDatalistId = `browser-model-options-${itemDraft.vendor}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  )

  const currentItem = useMemo(
    () =>
      selectedGroup?.items.find((item) => item.id === selectedItemId) || null,
    [selectedGroup, selectedItemId]
  )

  async function loadGroups() {
    if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE && !workspaceId) {
      return
    }

    setGroupsLoading(true)
    try {
      let nextGroups: ModelGroupSummary[] = []

      if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        nextGroups = await api.getPlatformModelGroups()
      } else if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        nextGroups = await api.getWorkspaceMemberModelGroups(workspaceId!)
      } else {
        const groups = await api.getModelGroups(workspaceId!)
        nextGroups = groups.filter(
          (group: ModelGroupSummary) =>
            resolveModelGroupScope(group) === MODEL_GROUP_OWNER_TYPE.WORKSPACE
        )
      }

      setGroups(nextGroups)
      setSelectedGroupId((current) =>
        current && nextGroups.some((group) => group.id === current)
          ? current
          : nextGroups[0]?.id || null
      )
    } catch (error) {
      clientLog.error("Failed to load model groups:", error)
      setGroups([])
      setSelectedGroupId(null)
    } finally {
      setGroupsLoading(false)
    }
  }

  async function loadSelectedGroup(
    groupId: string,
    preferredItemId?: string | null
  ) {
    setDetailLoading(true)
    try {
      const nextGroup = (await fetchGroupDetail(
        scope,
        groupId,
        workspaceId
      )) as GroupDetail
      setSelectedGroup(nextGroup)
      setSelectedItemId((current) => {
        const nextSelectedId =
          preferredItemId &&
          nextGroup.items.some((item) => item.id === preferredItemId)
            ? preferredItemId
            : current && nextGroup.items.some((item) => item.id === current)
              ? current
              : nextGroup.items[0]?.id || null
        return nextSelectedId
      })
    } catch (error) {
      clientLog.error("Failed to load model group detail:", error)
      setSelectedGroup(null)
      setSelectedItemId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    void loadGroups()
  }, [scope, workspaceId])

  useEffect(() => {
    if (!selectedGroupId) {
      setSelectedGroup(null)
      setSelectedItemId(null)
      return
    }
    void loadSelectedGroup(selectedGroupId)
  }, [selectedGroupId])

  useEffect(() => {
    setItemDraft(createFormState(currentItem))
  }, [currentItem])

  const filteredGroups = useMemo(() => {
    const needle = deferredGroupSearch.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter((group) => {
      const haystack =
        `${group.name} ${group.description} ${group.routingStrategy}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [deferredGroupSearch, groups])

  const emptyLabel =
    scope === MODEL_GROUP_OWNER_TYPE.PLATFORM
      ? "No platform model groups configured"
      : scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER
        ? "No member model groups configured"
        : "No workspace model groups configured"

  const editorTitle = currentItem
    ? currentItem.displayName
    : selectedGroup
      ? "New Model Config"
      : "Select a model group"

  function handleNewItem() {
    setSelectedItemId(null)
    setItemDraft(createFormState())
  }

  async function handleDeleteItem() {
    if (!selectedGroup || !currentItem) return

    try {
      if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
        await api.deletePlatformModelItem(selectedGroup.id, currentItem.id)
      } else if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
        await api.deleteWorkspaceMemberModelItem(
          workspaceId!,
          selectedGroup.id,
          currentItem.id
        )
      } else if (workspaceId) {
        await api.deleteModelItem(workspaceId, selectedGroup.id, currentItem.id)
      }

      await loadSelectedGroup(selectedGroup.id)
    } catch (error) {
      clientLog.error("Failed to delete model config:", error)
    }
  }

  async function handleSaveItem() {
    if (!selectedGroup) return
    if (!itemDraft.displayName.trim()) return
    if (
      !currentItem &&
      (!itemDraft.apiKey.trim() ||
        !itemDraft.baseUrl.trim() ||
        !itemDraft.modelName.trim())
    )
      return
    if (itemConfigError) {
      toast.error(itemConfigError)
      return
    }
    if (providerOptionsError) {
      toast.error(providerOptionsError)
      return
    }

    setSavingItem(true)
    try {
      const features: Record<string, unknown> = {}
      if (providerKind === "openai") {
        features.apiStyle = itemDraft.apiStyle
      }
      if (
        vendorSupportsServerTools(itemDraft.vendor) &&
        itemDraft.serverTools.length > 0
      ) {
        features.serverTools = itemDraft.serverTools
      }
      if (itemDraft.multimodalTypes.length > 0) {
        features.multimodal = {
          supported: true,
          types: itemDraft.multimodalTypes,
        }
      }
      if (itemDraft.crossTurnToolHistory) {
        features.crossTurnToolHistory = true
      }

      const providerOptions = itemDraft.providerOptionsText.trim()
        ? (JSON.parse(itemDraft.providerOptionsText) as Record<string, unknown>)
        : undefined

      if (currentItem) {
        const payload: Record<string, unknown> = {
          displayName: itemDraft.displayName.trim(),
          priority: parseInt(itemDraft.priority, 10),
          weight: parseInt(itemDraft.weight, 10),
          features,
          isEnabled: itemDraft.isEnabled,
          maxOutputTokens: parseInt(itemDraft.maxOutputTokens, 10),
          vendor: itemDraft.vendor,
          providerKind,
        }
        if (providerOptions) payload.providerOptions = providerOptions
        if (itemDraft.modelName.trim())
          payload.modelName = itemDraft.modelName.trim()
        if (itemDraft.baseUrl.trim()) payload.baseUrl = itemDraft.baseUrl.trim()
        if (itemDraft.apiKey.trim()) payload.apiKey = itemDraft.apiKey.trim()

        if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
          await api.updatePlatformModelItem(
            selectedGroup.id,
            currentItem.id,
            payload
          )
        } else if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
          await api.updateWorkspaceMemberModelItem(
            workspaceId!,
            selectedGroup.id,
            currentItem.id,
            payload
          )
        } else if (workspaceId) {
          await api.updateModelItem(
            workspaceId,
            selectedGroup.id,
            currentItem.id,
            payload
          )
        }

        await loadSelectedGroup(selectedGroup.id, currentItem.id)
      } else {
        const payload = {
          displayName: itemDraft.displayName.trim(),
          priority: parseInt(itemDraft.priority, 10),
          weight: parseInt(itemDraft.weight, 10),
          vendor: itemDraft.vendor,
          providerKind,
          apiKey: itemDraft.apiKey.trim(),
          baseUrl: itemDraft.baseUrl.trim(),
          modelName: itemDraft.modelName.trim(),
          maxOutputTokens: parseInt(itemDraft.maxOutputTokens, 10),
          features,
          ...(providerOptions ? { providerOptions } : {}),
        }

        let response
        if (scope === MODEL_GROUP_OWNER_TYPE.PLATFORM) {
          response = await api.addPlatformModelItem(selectedGroup.id, payload)
        } else if (scope === MODEL_GROUP_OWNER_TYPE.WORKSPACE_MEMBER) {
          response = await api.addWorkspaceMemberModelItem(
            workspaceId!,
            selectedGroup.id,
            payload
          )
        } else {
          response = await api.addModelItem(
            workspaceId!,
            selectedGroup.id,
            payload
          )
        }

        await loadSelectedGroup(selectedGroup.id, response?.id || null)
      }
    } catch (error) {
      clientLog.error("Failed to save model config:", error)
      toast.error(getSaveErrorMessage(error, "Failed to save model config."))
    } finally {
      setSavingItem(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 w-[320px] shrink-0 flex-col border-r border-border bg-muted/20">
        <div className="border-b border-border px-4 py-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">
                Model Groups
              </div>
              <div className="text-sm text-muted-foreground">
                Select a group to inspect its configs.
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditingGroup(null)
                setGroupDialogOpen(true)
              }}
            >
              <Plus data-icon="inline-start" />
              New
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={groupSearch}
              onChange={(event) => setGroupSearch(event.target.value)}
              placeholder="Search groups..."
              className="pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {groupsLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          ) : filteredGroups.length > 0 ? (
            <div className="flex flex-col gap-2">
              {filteredGroups.map((group) => (
                <GroupListItem
                  key={group.id}
                  group={group}
                  selected={group.id === selectedGroupId}
                  onSelect={() => setSelectedGroupId(group.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">
                    {emptyLabel}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Create a model group to start managing routing.
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <div className="flex min-h-0 w-[360px] shrink-0 flex-col border-r border-border bg-background">
        <div className="border-b border-border px-4 py-4">
          {selectedGroup ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {selectedGroup.name}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {getModelGroupStrategyLabel(
                        selectedGroup.routingStrategy
                      )}
                    </Badge>
                    {selectedGroup.isDefault ? (
                      <Badge variant="outline">Default</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void loadSelectedGroup(selectedGroup.id, selectedItemId)
                    }
                  >
                    <RefreshCw data-icon="inline-start" />
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingGroup(selectedGroup)
                      setGroupDialogOpen(true)
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </div>
              {selectedGroup.description ? (
                <div className="text-sm text-muted-foreground">
                  {selectedGroup.description}
                </div>
              ) : null}
              <Button size="sm" onClick={handleNewItem}>
                <Plus data-icon="inline-start" />
                New Config
              </Button>
            </div>
          ) : (
            <div>
              <div className="text-sm font-medium text-foreground">Configs</div>
              <div className="text-sm text-muted-foreground">
                Select a model group first.
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {detailLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
              <Skeleton className="h-20 rounded-2xl" />
            </div>
          ) : !selectedGroup ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">
                    No group selected
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Pick a model group to browse its configs.
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : selectedGroup.items.length > 0 ? (
            <div className="flex flex-col gap-2">
              {selectedGroup.items.map((item) => (
                <ConfigListItem
                  key={item.id}
                  item={item}
                  selected={item.id === selectedItemId}
                  onSelect={() => setSelectedItemId(item.id)}
                />
              ))}
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Cpu className="size-10 text-muted-foreground/60" />
                <div>
                  <div className="font-medium text-foreground">
                    No configs yet
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Create the first model config for this group.
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
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  {editorTitle}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedGroup
                    ? currentItem
                      ? "Edit the selected config. Saving creates a new config revision."
                      : "Configure a new model for the selected group."
                    : "Select a group and a config from the left to start editing."}
                </p>
              </div>
              {selectedGroup ? (
                <div className="flex items-center gap-2">
                  {currentItem ? (
                    <Button
                      variant="outline"
                      onClick={() => void handleDeleteItem()}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => void handleSaveItem()}
                    disabled={
                      savingItem ||
                      !selectedGroup ||
                      !!itemConfigError ||
                      !!providerOptionsError
                    }
                  >
                    <Save data-icon="inline-start" />
                    {savingItem ? "Saving..." : "Save"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex-1 p-6">
            {selectedGroup ? (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle>Config</CardTitle>
                    <CardDescription>
                      Provider, endpoint, model name, limits, and runtime
                      toggles.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="space-y-2">
                      <Label>Display Name</Label>
                      <Input
                        value={itemDraft.displayName}
                        onChange={(event) =>
                          setItemDraft((current) => ({
                            ...current,
                            displayName: event.target.value,
                          }))
                        }
                        placeholder="e.g. Claude Sonnet"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Vendor</Label>
                        <select
                          value={itemDraft.vendor}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              vendor: event.target.value,
                              baseUrl: getDefaultModelBaseUrl(
                                event.target.value
                              ),
                              modelName: getDefaultModelName(
                                event.target.value
                              ),
                              serverTools: vendorSupportsServerTools(
                                event.target.value
                              )
                                ? current.serverTools
                                : [],
                            }))
                          }
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
                          value={itemDraft.modelName}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              modelName: event.target.value,
                            }))
                          }
                          list={
                            knownModels.length > 0 ? modelDatalistId : undefined
                          }
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
                        {itemConfigError ? (
                          <p className="text-xs text-red-500">
                            {itemConfigError}
                          </p>
                        ) : null}
                        {knownModels.length > 0 ? (
                          <datalist id={modelDatalistId}>
                            {knownModels.map((model) => (
                              <option
                                key={model.modelName}
                                value={model.modelName}
                              >
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
                        value={itemDraft.apiKey}
                        onChange={(event) =>
                          setItemDraft((current) => ({
                            ...current,
                            apiKey: event.target.value,
                          }))
                        }
                        placeholder={
                          currentItem
                            ? "(leave blank to keep current)"
                            : "sk-..."
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Base URL</Label>
                      <Input
                        value={itemDraft.baseUrl}
                        onChange={(event) =>
                          setItemDraft((current) => ({
                            ...current,
                            baseUrl: event.target.value,
                          }))
                        }
                        placeholder={
                          getDefaultModelBaseUrl(itemDraft.vendor) ||
                          "https://api.example.com"
                        }
                      />
                    </div>

                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-2">
                        <Label>Max Output Tokens</Label>
                        <Input
                          type="number"
                          value={itemDraft.maxOutputTokens}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              maxOutputTokens: event.target.value,
                            }))
                          }
                          max={maxTokensLimit}
                        />
                        {maxTokensLimit ? (
                          <p className="text-xs text-muted-foreground">
                            This model supports up to {maxTokensLimit} output
                            tokens.
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label>Priority</Label>
                        <Input
                          type="number"
                          value={itemDraft.priority}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              priority: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Weight</Label>
                        <Input
                          type="number"
                          value={itemDraft.weight}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              weight: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Status</Label>
                        <select
                          value={itemDraft.isEnabled ? "enabled" : "disabled"}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              isEnabled: event.target.value === "enabled",
                            }))
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

                <div className="flex flex-col gap-6">
                  {providerKind === "openai" ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>API Style</CardTitle>
                        <CardDescription>
                          Wire format used for this OpenAI-style endpoint.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <select
                          value={itemDraft.apiStyle}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              apiStyle:
                                event.target.value === MODEL_API_STYLE.RESPONSES
                                  ? MODEL_API_STYLE.RESPONSES
                                  : MODEL_API_STYLE.CHAT,
                            }))
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

                  {vendorSupportsServerTools(itemDraft.vendor) ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Server Tools</CardTitle>
                        <CardDescription>
                          Vendor-side tools exposed to this config.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3">
                        {SERVER_TOOLS.map((tool) => {
                          const checked = itemDraft.serverTools.includes(
                            tool.key
                          )
                          return (
                            <label
                              key={tool.key}
                              className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border p-3"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setItemDraft((current) => ({
                                    ...current,
                                    serverTools: checked
                                      ? current.serverTools.filter(
                                          (value) => value !== tool.key
                                        )
                                      : [...current.serverTools, tool.key],
                                  }))
                                }
                                className="mt-1 accent-primary"
                              />
                              <div>
                                <div className="font-medium text-foreground">
                                  {tool.label}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {tool.description}
                                </div>
                              </div>
                            </label>
                          )
                        })}
                      </CardContent>
                    </Card>
                  ) : null}

                  <Card>
                    <CardHeader>
                      <CardTitle>Multimodal</CardTitle>
                      <CardDescription>
                        Declare which input modalities this config supports.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      {MULTIMODAL_TYPES.map((type) => {
                        const checked = itemDraft.multimodalTypes.includes(
                          type.key
                        )
                        return (
                          <label
                            key={type.key}
                            className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border p-3"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setItemDraft((current) => ({
                                  ...current,
                                  multimodalTypes: checked
                                    ? current.multimodalTypes.filter(
                                        (value) => value !== type.key
                                      )
                                    : [...current.multimodalTypes, type.key],
                                }))
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
                      <CardTitle>Behavior</CardTitle>
                      <CardDescription>
                        Runtime feature toggles and opaque provider options.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border p-3">
                        <input
                          type="checkbox"
                          checked={itemDraft.crossTurnToolHistory}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              crossTurnToolHistory: event.target.checked,
                            }))
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
                          value={itemDraft.providerOptionsText}
                          onChange={(event) =>
                            setItemDraft((current) => ({
                              ...current,
                              providerOptionsText: event.target.value,
                            }))
                          }
                          rows={4}
                          spellCheck={false}
                          placeholder='{ "reasoning_effort": "high" }'
                          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs outline-none"
                        />
                        {providerOptionsError ? (
                          <p className="text-xs text-red-500">
                            {providerOptionsError}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Opaque, vendor-specific options passed through to
                            the provider.
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {selectedGroup ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Selected Group</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 text-sm">
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Group</span>
                          <span className="font-medium text-foreground">
                            {selectedGroup.name}
                          </span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            Strategy
                          </span>
                          <span className="font-medium text-foreground">
                            {getModelGroupStrategyLabel(
                              selectedGroup.routingStrategy
                            )}
                          </span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-muted-foreground">Configs</span>
                          <span className="font-medium text-foreground">
                            {selectedGroup.items.length}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}
                </div>
              </div>
            ) : (
              <Card className="max-w-xl">
                <CardHeader>
                  <CardTitle>Select a model group</CardTitle>
                  <CardDescription>
                    Pick a group on the left, then choose a config in the middle
                    column to edit it here.
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
        scope={scope}
        group={editingGroup}
        onSaved={() => {
          setGroupDialogOpen(false)
          setEditingGroup(null)
          void loadGroups()
        }}
      />
    </div>
  )
}
