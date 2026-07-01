"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { MarketplacePluginView } from "@synapse/shared"
import { Globe, Code, Puzzle, Wrench, Key } from "lucide-react"
import { PLUGIN_BRAND_ICONS } from "@/components/plugin-brand-icons"

function getLocale(defaultLocale?: string) {
  if (typeof navigator !== "undefined") {
    return (
      navigator.languages?.[0] || navigator.language || defaultLocale || "en"
    )
  }
  return defaultLocale || "en"
}

function translate(
  text: Record<string, string> | undefined,
  locale: string,
  fallback?: string
) {
  if (!text || Object.keys(text).length === 0) return fallback || ""
  return (
    text[locale] ||
    text[locale.split("-")[0]] ||
    text[fallback || ""] ||
    text.en ||
    Object.values(text)[0] ||
    fallback ||
    ""
  )
}

interface Props {
  plugin: MarketplacePluginView
  installedCount: number
  onInstall: () => void
  onClose: () => void
}

type PluginToolSummary = { name?: string; description?: string }

function asToolSummary(value: unknown): PluginToolSummary {
  return value && typeof value === "object" ? (value as PluginToolSummary) : {}
}

const transportLabels: Record<string, string> = {
  http: "Remote MCP (HTTP)",
  builtin: "Built-in",
  stdio: "Local (stdio)",
}

const reuseScopeLabels: Record<string, string> = {
  turn: "Turn",
  session: "Session",
  conversation: "Conversation",
  actor: "Actor",
  workspace: "Workspace",
}

export default function PluginDetailDialog({
  plugin,
  installedCount,
  onInstall,
  onClose,
}: Props) {
  const tools = plugin.toolsManifest || []
  const configFields = plugin.configFields || []
  const hasRequiredConfig = configFields.some((field) => field.required)
  const locale = getLocale(plugin.defaultLocale)
  const BrandIcon = plugin.orgSlug
    ? PLUGIN_BRAND_ICONS[plugin.orgSlug]
    : undefined

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto border-gray-200 bg-white ring-1 ring-gray-200 dark:border-white/10 dark:bg-gray-900 dark:ring-white/10">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white ring-1 ring-slate-200 dark:ring-white/10">
              {BrandIcon ? (
                <BrandIcon className="h-8 w-8" />
              ) : plugin.transport === "http" ? (
                <Globe className="h-6 w-6 text-blue-400" />
              ) : plugin.transport === "builtin" ? (
                <Code className="h-6 w-6 text-blue-400" />
              ) : (
                <Puzzle className="h-6 w-6 text-blue-400" />
              )}
            </div>
            <div>
              <DialogTitle>
                {translate(
                  plugin.displayNameI18n,
                  locale,
                  plugin.defaultLocale || "en"
                ) || plugin.displayName}
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                {plugin.orgDisplayName} · v{plugin.version}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          <p className="text-sm text-muted-foreground">
            {translate(
              plugin.longDescriptionI18n || plugin.descriptionI18n,
              locale,
              plugin.defaultLocale || "en"
            ) ||
              plugin.longDescription ||
              plugin.description}
          </p>

          <div className="flex flex-wrap gap-2">
            <Badge
              variant="outline"
              className="border-gray-200 dark:border-white/10"
            >
              {transportLabels[plugin.transport] || plugin.transport}
            </Badge>
            <Badge
              variant="outline"
              className="border-gray-200 dark:border-white/10"
            >
              Runtime:{" "}
              {reuseScopeLabels[plugin.lifecycleScope] || plugin.lifecycleScope}
            </Badge>
            {(plugin.categories || []).map((category) => (
              <Badge
                key={category.slug}
                variant="outline"
                className="border-blue-500/20 text-blue-500 dark:text-blue-300"
              >
                {translate(
                  category.displayNameI18n,
                  locale,
                  category.defaultLocale || "en"
                ) || category.displayName}
              </Badge>
            ))}
            {(plugin.tags || []).map((tag: string) => (
              <Badge
                key={tag}
                variant="secondary"
                className="bg-gray-50 dark:bg-white/5"
              >
                {tag}
              </Badge>
            ))}
          </div>

          {/* Config requirements notice */}
          {hasRequiredConfig ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="mb-1 flex items-center gap-2">
                <Key className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-medium text-amber-300">
                  Requires configuration
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                This plugin requires an API key or other configuration to
                function.
              </p>
            </div>
          ) : null}

          {tools.length > 0 ? (
            <div>
              <h4 className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Wrench className="h-4 w-4 text-blue-400" />
                Tools ({tools.length})
              </h4>
              <div className="space-y-2">
                {tools.map((rawTool) => {
                  const tool = asToolSummary(rawTool)
                  return (
                    <div
                      key={tool.name}
                      className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/5"
                    >
                      <p className="font-mono text-sm font-medium text-blue-400">
                        {tool.name}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tool.description}
                      </p>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="flex gap-2 pt-2">
            {installedCount > 0 ? (
              <Badge className="border-green-500/30 bg-green-500/20 text-green-400">
                Installed
                {installedCount > 1 ? ` (${installedCount} instances)` : ""}
              </Badge>
            ) : null}
            <Button onClick={onInstall} className="flex-1">
              {installedCount > 0 ? "Create Another Installation" : "Install"}
            </Button>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
