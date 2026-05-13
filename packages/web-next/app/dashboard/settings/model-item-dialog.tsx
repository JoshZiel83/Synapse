"use client"

import { useState, useEffect } from "react"
import {
  getDefaultModelBaseUrl,
  getDefaultModelEngineKind,
  getDefaultModelName,
  getModelProviderEngineDefinitions,
  listModelProviderDefinitions,
  providerSupportsBuiltinTools,
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

interface ModelItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  scope?: "workspace" | "platform" | "workspace_member"
  item: any | null
  onSaved: () => void
}

const ANTHROPIC_BUILTIN_TOOLS = [
  {
    key: "web_search",
    label: "Web Search",
    description: "Allow the model to search the web for real-time information",
    icon: Globe,
  },
  {
    key: "web_fetch",
    label: "Web Fetch",
    description: "Allow the model to fetch and read full web page content",
    icon: FileText,
  },
]

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

const PROVIDER_OPTIONS = listModelProviderDefinitions()

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
  const [providerType, setProviderType] = useState("anthropic")
  const [engineKind, setEngineKind] = useState("anthropic.messages")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [modelName, setModelName] = useState("")
  const [maxTokens, setMaxTokens] = useState("4096")
  const [priority, setPriority] = useState("0")
  const [weight, setWeight] = useState("100")
  const [builtinTools, setBuiltinTools] = useState<string[]>([])
  const [multimodalTypes, setMultimodalTypes] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const knownModels = getKnownModelOptions(providerType, engineKind)
  const maxTokensLimit = getEffectiveMaxTokensLimit(
    providerType,
    engineKind,
    modelName
  )
  const modelConfigError = getModelConfigValidationMessage({
    providerType,
    engineKind,
    modelName,
    maxTokens,
  })
  const modelDatalistId = `model-options-${providerType}-${engineKind}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-"
  )

  useEffect(() => {
    if (item) {
      const resolvedProviderType = item.provider_type || "anthropic"
      const resolvedEngineKind =
        item.engine_kind ||
        item.extra_config?.engine_kind ||
        getDefaultModelEngineKind(resolvedProviderType)
      setDisplayName(item.display_name || "")
      setProviderType(resolvedProviderType)
      setEngineKind(resolvedEngineKind)
      setApiKey("") // Never pre-fill API key for security
      setBaseUrl(item.base_url || "")
      setModelName(item.model_name || "")
      setMaxTokens(String(item.max_tokens || 4096))
      setPriority(String(item.priority ?? 0))
      setWeight(String(item.weight ?? 100))
      // Load builtin_tools and multimodal from extra_config
      const ec = item.extra_config || {}
      setBuiltinTools(Array.isArray(ec.builtin_tools) ? ec.builtin_tools : [])
      setMultimodalTypes(
        ec.multimodal?.supported && Array.isArray(ec.multimodal.types)
          ? ec.multimodal.types
          : []
      )
    } else {
      setDisplayName("")
      setProviderType("anthropic")
      setEngineKind("anthropic.messages")
      setApiKey("")
      setBaseUrl(getDefaultModelBaseUrl("anthropic"))
      setModelName(getDefaultModelName("anthropic", "anthropic.messages"))
      setMaxTokens("4096")
      setPriority("0")
      setWeight("100")
      setBuiltinTools([])
      setMultimodalTypes([])
    }
  }, [item, open])

  const toggleBuiltinTool = (tool: string) => {
    setBuiltinTools((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]
    )
  }

  const toggleMultimodalType = (type: string) => {
    setMultimodalTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    )
  }

  const handleSave = async () => {
    if ((!workspaceId && scope === "workspace") || !displayName.trim()) return
    setSaving(true)
    try {
      if (modelConfigError) {
        toast.error(modelConfigError)
        return
      }

      // Build extraConfig with builtin_tools and multimodal
      const extraConfig: Record<string, unknown> = {}
      if (
        providerSupportsBuiltinTools(providerType) &&
        builtinTools.length > 0
      ) {
        extraConfig.builtin_tools = builtinTools
      }
      if (multimodalTypes.length > 0) {
        extraConfig.multimodal = { supported: true, types: multimodalTypes }
      }

      if (item) {
        // Update - only send config fields if they changed
        const updateData: any = {
          displayName: displayName.trim(),
          priority: parseInt(priority),
          weight: parseInt(weight),
          extraConfig,
        }
        // Only add config fields if user provided new values
        if (modelName.trim()) updateData.modelName = modelName.trim()
        if (baseUrl.trim()) updateData.baseUrl = baseUrl.trim()
        if (apiKey.trim()) updateData.apiKey = apiKey.trim()
        if (providerType) updateData.providerType = providerType
        updateData.engineKind = engineKind
        updateData.maxTokens = parseInt(maxTokens)

        if (scope === "platform") {
          await api.updatePlatformModelItem(groupId, item.id, updateData)
        } else if (scope === "workspace_member") {
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
          providerType,
          engineKind,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          modelName: modelName.trim(),
          maxTokens: parseInt(maxTokens),
          extraConfig,
        }
        if (scope === "platform") {
          await api.addPlatformModelItem(groupId, payload)
        } else if (scope === "workspace_member") {
          await api.addWorkspaceMemberModelItem(workspaceId!, groupId, payload)
        } else {
          await api.addModelItem(workspaceId!, groupId, payload)
        }
      }
      onSaved()
    } catch (err) {
      console.error("Failed to save model item:", err)
      toast.error(getSaveErrorMessage(err, "Failed to save model item."))
    } finally {
      setSaving(false)
    }
  }

  const isValid =
    displayName.trim() &&
    !modelConfigError &&
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
              <Label>Provider</Label>
              <select
                value={providerType}
                onChange={(e) => {
                  const nextProviderType = e.target.value
                  const nextEngineKind =
                    getDefaultModelEngineKind(nextProviderType)
                  setProviderType(nextProviderType)
                  setEngineKind(nextEngineKind)
                  setBaseUrl(getDefaultModelBaseUrl(nextProviderType))
                  setModelName(
                    getDefaultModelName(nextProviderType, nextEngineKind)
                  )
                  if (!providerSupportsBuiltinTools(nextProviderType))
                    setBuiltinTools([])
                }}
                className="h-10 w-full rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-foreground outline-none focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.providerType} value={option.providerType}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Protocol</Label>
              <select
                value={engineKind}
                onChange={(e) => {
                  const nextEngineKind = e.target.value
                  setEngineKind(nextEngineKind)
                  setModelName(
                    getDefaultModelName(providerType, nextEngineKind)
                  )
                }}
                className="h-10 w-full rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-foreground outline-none focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
              >
                {getModelProviderEngineDefinitions(providerType).map(
                  (option) => (
                    <option key={option.engineKind} value={option.engineKind}>
                      {option.label}
                    </option>
                  )
                )}
              </select>
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
                getDefaultModelBaseUrl(providerType) ||
                "https://api.example.com"
              }
              className="border-gray-200 bg-gray-50 focus:border-blue-500/40 dark:border-white/10 dark:bg-white/5"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Max Tokens</Label>
              <Input
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
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

          {/* Provider Built-in Tools */}
          {providerSupportsBuiltinTools(providerType) && (
            <div className="space-y-3 pt-1">
              <Label className="text-sm">Built-in Tools</Label>
              <div className="space-y-2">
                {ANTHROPIC_BUILTIN_TOOLS.map((tool) => {
                  const Icon = tool.icon
                  const checked = builtinTools.includes(tool.key)
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
                        onChange={() => toggleBuiltinTool(tool.key)}
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
                These tools run on the selected provider&apos;s servers when
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
