"use client"

import { useState, useEffect } from "react"
import {
  MODEL_API_STYLE,
  MODEL_GROUP_GRANT_SCOPE,
  MODEL_SERVER_TOOL,
  getDefaultModelBaseUrl,
  getDefaultModelName,
  getProviderKindForVendor,
  listModelVendorDefinitions,
  vendorSupportsServerTools,
  type ModelApiStyle,
  type ModelGroupItemView,
  type ModelServerTool,
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
import { Globe, FileText, Image, Mic, Video, FileIcon } from "lucide-react"
import { toast } from "sonner"
import {
  getEffectiveMaxTokensLimit,
  getKnownModelOptions,
  getModelConfigValidationMessage,
  getSaveErrorMessage,
} from "./model-config-utils"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.settings.model-item-dialog")

interface ModelItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  scope?: "workspace" | "platform" | "workspace_member"
  item: ModelGroupItemView | null
  onSaved: () => void
}

const SERVER_TOOLS = [
  {
    key: MODEL_SERVER_TOOL.WEB_SEARCH,
    label: "Web Search",
    description: "Allow the model to search the web for real-time information",
    icon: Globe,
  },
  {
    key: MODEL_SERVER_TOOL.WEB_FETCH,
    label: "Web Fetch",
    description: "Allow the model to fetch and read full web page content",
    icon: FileText,
  },
] as const

const MULTIMODAL_TYPES = [
  {
    key: "image",
    label: "Images",
    description: "Send images (JPEG, PNG, GIF, WebP) to the model",
    icon: Image,
  },
  {
    key: "audio",
    label: "Audio",
    description: "Send audio files (MP3, WAV, etc.) to the model",
    icon: Mic,
  },
  {
    key: "video",
    label: "Video",
    description: "Send video files to the model",
    icon: Video,
  },
  {
    key: "document",
    label: "Documents",
    description: "Send PDF and document files to the model",
    icon: FileIcon,
  },
]

const VENDOR_OPTIONS = listModelVendorDefinitions()
const DEFAULT_VENDOR = VENDOR_OPTIONS[0]?.vendor || "anthropic"
const API_STYLE_OPTIONS = [
  { value: MODEL_API_STYLE.CHAT, label: "Chat Completions" },
  { value: MODEL_API_STYLE.RESPONSES, label: "Responses API" },
] as const

export default function ModelItemDialog({
  open,
  onOpenChange,
  groupId,
  scope = "workspace",
  item,
  onSaved,
}: ModelItemDialogProps) {
  const { workspaceId } = useWorkspace()
  const [displayName, setDisplayName] = useState("")
  const [vendor, setVendor] = useState(DEFAULT_VENDOR)
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [modelName, setModelName] = useState("")
  const [maxOutputTokens, setMaxOutputTokens] = useState("4096")
  const [priority, setPriority] = useState("0")
  const [weight, setWeight] = useState("100")
  const [apiStyle, setApiStyle] = useState<ModelApiStyle>(MODEL_API_STYLE.CHAT)
  const [serverTools, setServerTools] = useState<ModelServerTool[]>([])
  const [multimodalTypes, setMultimodalTypes] = useState<string[]>([])
  const [crossTurnToolHistory, setCrossTurnToolHistory] = useState(false)
  const [providerOptionsText, setProviderOptionsText] = useState("")
  const [saving, setSaving] = useState(false)
  const providerKind = getProviderKindForVendor(vendor)
  const knownModels = getKnownModelOptions(vendor)
  const maxTokensLimit = getEffectiveMaxTokensLimit(vendor, modelName)
  const modelConfigError = getModelConfigValidationMessage({
    vendor,
    modelName,
    maxOutputTokens,
  })
  const providerOptionsError = (() => {
    if (!providerOptionsText.trim()) return ""
    try {
      const parsed = JSON.parse(providerOptionsText)
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
  const modelDatalistId = `model-options-${vendor}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  )

  useEffect(() => {
    if (item) {
      const resolvedVendor = item.vendor || DEFAULT_VENDOR
      const features = item.features || {}
      setDisplayName(item.displayName || "")
      setVendor(resolvedVendor)
      setApiKey("") // Never pre-fill API key for security
      setBaseUrl(item.baseUrl || "")
      setModelName(item.modelName || "")
      setMaxOutputTokens(String(item.maxOutputTokens || 4096))
      setPriority(String(item.priority ?? 0))
      setWeight(String(item.weight ?? 100))
      setApiStyle(
        features.apiStyle === MODEL_API_STYLE.RESPONSES
          ? MODEL_API_STYLE.RESPONSES
          : MODEL_API_STYLE.CHAT
      )
      setServerTools(
        Array.isArray(features.serverTools)
          ? (features.serverTools.filter(
              (t: unknown): t is ModelServerTool =>
                t === MODEL_SERVER_TOOL.WEB_SEARCH ||
                t === MODEL_SERVER_TOOL.WEB_FETCH
            ) as ModelServerTool[])
          : []
      )
      setMultimodalTypes(
        features.multimodal?.supported &&
          Array.isArray(features.multimodal.types)
          ? features.multimodal.types
          : []
      )
      setCrossTurnToolHistory(Boolean(features.crossTurnToolHistory))
      setProviderOptionsText(
        item.providerOptions && Object.keys(item.providerOptions).length > 0
          ? JSON.stringify(item.providerOptions, null, 2)
          : ""
      )
    } else {
      setDisplayName("")
      setVendor(DEFAULT_VENDOR)
      setApiKey("")
      setBaseUrl(getDefaultModelBaseUrl(DEFAULT_VENDOR))
      setModelName(getDefaultModelName(DEFAULT_VENDOR))
      setMaxOutputTokens("4096")
      setPriority("0")
      setWeight("100")
      setApiStyle(MODEL_API_STYLE.CHAT)
      setServerTools([])
      setMultimodalTypes([])
      setCrossTurnToolHistory(false)
      setProviderOptionsText("")
    }
  }, [item, open])

  const toggleServerTool = (tool: ModelServerTool) => {
    setServerTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    )
  }

  const toggleMultimodalType = (type: string) => {
    setMultimodalTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  const handleSave = async () => {
    if (
      (!workspaceId && scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE) ||
      !displayName.trim()
    )
      return
    setSaving(true)
    try {
      if (modelConfigError) {
        toast.error(modelConfigError)
        return
      }
      if (providerOptionsError) {
        toast.error(providerOptionsError)
        return
      }

      // Build typed features bag.
      const features: Record<string, unknown> = {}
      if (providerKind === "openai") {
        features.apiStyle = apiStyle
      }
      if (vendorSupportsServerTools(vendor) && serverTools.length > 0) {
        features.serverTools = serverTools
      }
      if (multimodalTypes.length > 0) {
        features.multimodal = { supported: true, types: multimodalTypes }
      }
      if (crossTurnToolHistory) {
        features.crossTurnToolHistory = true
      }

      const providerOptions = providerOptionsText.trim()
        ? (JSON.parse(providerOptionsText) as Record<string, unknown>)
        : undefined

      if (item) {
        // Update - only send config fields if they changed
        const updateData: Record<string, unknown> = {
          displayName: displayName.trim(),
          priority: parseInt(priority),
          weight: parseInt(weight),
          features,
          vendor,
          providerKind,
        }
        if (providerOptions) updateData.providerOptions = providerOptions
        // Only add config fields if user provided new values
        if (modelName.trim()) updateData.modelName = modelName.trim()
        if (baseUrl.trim()) updateData.baseUrl = baseUrl.trim()
        if (apiKey.trim()) updateData.apiKey = apiKey.trim()
        updateData.maxOutputTokens = parseInt(maxOutputTokens)

        if (scope === MODEL_GROUP_GRANT_SCOPE.PLATFORM) {
          await api.updatePlatformModelItem(groupId, item.id, updateData)
        } else if (scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER) {
          await api.updateWorkspaceMemberModelItem(
            workspaceId!,
            groupId,
            item.id,
            updateData
          )
        } else {
          await api.updateModelItem(workspaceId!, groupId, item.id, updateData)
        }
      } else {
        // Create new
        const payload = {
          displayName: displayName.trim(),
          priority: parseInt(priority),
          weight: parseInt(weight),
          vendor,
          providerKind,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          modelName: modelName.trim(),
          maxOutputTokens: parseInt(maxOutputTokens),
          features,
          ...(providerOptions ? { providerOptions } : {}),
        }
        if (scope === MODEL_GROUP_GRANT_SCOPE.PLATFORM) {
          await api.addPlatformModelItem(groupId, payload)
        } else if (scope === MODEL_GROUP_GRANT_SCOPE.WORKSPACE_MEMBER) {
          await api.addWorkspaceMemberModelItem(workspaceId!, groupId, payload)
        } else {
          await api.addModelItem(workspaceId!, groupId, payload)
        }
      }
      onSaved()
    } catch (err) {
      clientLog.error("Failed to save model item:", err)
      toast.error(getSaveErrorMessage(err, "Failed to save model item."))
    } finally {
      setSaving(false)
    }
  }

  const isValid =
    displayName.trim() &&
    !modelConfigError &&
    !providerOptionsError &&
    (item || (apiKey.trim() && baseUrl.trim() && modelName.trim()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-gray-200 bg-white ring-1 ring-gray-200 sm:max-w-lg dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
        <DialogHeader>
          <DialogTitle>{item ? "Edit Model" : "Add Model"}</DialogTitle>
          <DialogDescription>
            {item
              ? "Update model configuration (creates new config version)"
              : "Add a new model to this group"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
          <div className="space-y-2">
            <Label>Display Name</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Claude Sonnet"
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <select
                value={vendor}
                onChange={(e) => {
                  const nextVendor = e.target.value
                  setVendor(nextVendor)
                  setBaseUrl(getDefaultModelBaseUrl(nextVendor))
                  setModelName(getDefaultModelName(nextVendor))
                  if (!vendorSupportsServerTools(nextVendor)) setServerTools([])
                }}
                className="h-10 w-full rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-foreground outline-none focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
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
              <Input
                value={providerKind}
                readOnly
                className="border-gray-200 bg-gray-100 text-muted-foreground dark:border-white/10 dark:bg-white/5"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Model Name</Label>
              <Input
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                list={knownModels.length > 0 ? modelDatalistId : undefined}
                placeholder="claude-sonnet-4-20250514"
                className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
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
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              type="password"
              placeholder={item ? "(leave blank to keep current)" : "sk-..."}
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                getDefaultModelBaseUrl(vendor) || "https://api.example.com"
              }
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Max Output Tokens</Label>
              <Input
                value={maxOutputTokens}
                onChange={(e) => setMaxOutputTokens(e.target.value)}
                type="number"
                max={maxTokensLimit}
                className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
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
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                type="number"
                className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
              />
              <p className="text-xs text-muted-foreground">
                Lower = higher priority
              </p>
            </div>
            <div className="space-y-2">
              <Label>Weight</Label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                type="number"
                min="0"
                max="1000"
                className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
              />
            </div>
          </div>

          {/* API Style (OpenAI providerKind only) */}
          {providerKind === "openai" && (
            <div className="space-y-2 pt-1">
              <Label className="text-sm">API Style</Label>
              <select
                value={apiStyle}
                onChange={(e) =>
                  setApiStyle(
                    e.target.value === MODEL_API_STYLE.RESPONSES
                      ? MODEL_API_STYLE.RESPONSES
                      : MODEL_API_STYLE.CHAT
                  )
                }
                className="h-10 w-full rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-foreground outline-none focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
              >
                {API_STYLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground/60">
                Wire format used when calling this OpenAI-style endpoint.
              </p>
            </div>
          )}

          {/* Server Tools */}
          {vendorSupportsServerTools(vendor) && (
            <div className="space-y-3 pt-1">
              <Label className="text-sm">Server Tools</Label>
              <div className="space-y-2">
                {SERVER_TOOLS.map((tool) => {
                  const Icon = tool.icon
                  const checked = serverTools.includes(tool.key)
                  return (
                    <label
                      key={tool.key}
                      className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-all duration-200 ${
                        checked
                          ? "border-blue-500/40 bg-blue-500/5"
                          : "border-gray-200 bg-background/30 hover:border-blue-500/20 dark:border-white/10"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleServerTool(tool.key)}
                        className="sr-only"
                      />
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                          checked
                            ? "bg-blue-500/20 text-blue-400"
                            : "bg-gray-50 text-muted-foreground dark:bg-white/5"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-sm font-medium ${checked ? "text-foreground" : "text-muted-foreground"}`}
                          >
                            {tool.label}
                          </span>
                          {checked && (
                            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400">
                              Enabled
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground/80">
                          {tool.description}
                        </p>
                      </div>
                      <div
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                          checked
                            ? "border-blue-500 bg-blue-500"
                            : "border-muted-foreground/30"
                        }`}
                      >
                        {checked && (
                          <svg
                            className="h-3 w-3 text-white"
                            viewBox="0 0 12 12"
                            fill="none"
                          >
                            <path
                              d="M2 6L5 9L10 3"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                    </label>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground/60">
                These tools run on the selected vendor&apos;s servers when
                supported.
              </p>
            </div>
          )}

          {/* Multimodal Capabilities */}
          <div className="space-y-3 pt-1">
            <Label className="text-sm">Multimodal Capabilities</Label>
            <div className="space-y-2">
              {MULTIMODAL_TYPES.map((type) => {
                const Icon = type.icon
                const checked = multimodalTypes.includes(type.key)
                return (
                  <label
                    key={type.key}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-all duration-200 ${
                      checked
                        ? "border-violet-500/40 bg-violet-500/5"
                        : "border-gray-200 bg-background/30 hover:border-blue-500/20 dark:border-white/10"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMultimodalType(type.key)}
                      className="sr-only"
                    />
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        checked
                          ? "bg-violet-500/20 text-violet-400"
                          : "bg-background/50 text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-sm font-medium ${checked ? "text-foreground" : "text-muted-foreground"}`}
                        >
                          {type.label}
                        </span>
                        {checked && (
                          <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-400">
                            Enabled
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground/80">
                        {type.description}
                      </p>
                    </div>
                    <div
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                        checked
                          ? "border-violet-500 bg-violet-500"
                          : "border-muted-foreground/30"
                      }`}
                    >
                      {checked && (
                        <svg
                          className="h-3 w-3 text-white"
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <path
                            d="M2 6L5 9L10 3"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground/60">
              Enable multimodal input types that this model supports.
              Attachments of unsupported types will be sent as text
              descriptions.
            </p>
          </div>

          {/* Cross-turn tool history */}
          <div className="space-y-2 pt-1">
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-background/30 p-3 dark:border-white/10">
              <input
                type="checkbox"
                checked={crossTurnToolHistory}
                onChange={(e) => setCrossTurnToolHistory(e.target.checked)}
                className="accent-primary"
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium text-foreground">
                  Cross-turn tool history
                </span>
                <p className="mt-0.5 text-xs text-muted-foreground/80">
                  Replay prior tool calls/results across turns for this model.
                </p>
              </div>
            </label>
          </div>

          {/* Advanced: provider options */}
          <div className="space-y-2 pt-1">
            <Label className="text-sm">Advanced Provider Options (JSON)</Label>
            <textarea
              value={providerOptionsText}
              onChange={(e) => setProviderOptionsText(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder='{ "reasoning_effort": "high" }'
              className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
            {providerOptionsError ? (
              <p className="text-xs text-red-500">{providerOptionsError}</p>
            ) : (
              <p className="text-xs text-muted-foreground/60">
                Opaque, vendor-specific options passed through to the provider.
              </p>
            )}
          </div>
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
            disabled={saving || !isValid}
            className="bg-primary hover:bg-primary/80"
          >
            {saving ? "Saving..." : item ? "Update" : "Add Model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
