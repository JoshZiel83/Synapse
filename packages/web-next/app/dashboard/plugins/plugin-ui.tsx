"use client"

import { BadgeCheck, Globe, Code, Puzzle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { resolveFileUrl } from "@/lib/utils"

export function getLocale(defaultLocale?: string) {
  if (typeof navigator !== "undefined") {
    return (
      navigator.languages?.[0] || navigator.language || defaultLocale || "en"
    )
  }
  return defaultLocale || "en"
}

export function translate(
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

export const attachmentScopeLabels: Record<string, string> = {
  workspace: "Workspace",
  conversation: "Conversation",
  actor: "Actor",
  workspace_member: "Workspace Member",
}

export const attachmentScopeColors: Record<string, string> = {
  workspace: "border-blue-500/30 text-blue-500 dark:text-blue-300",
  conversation: "border-orange-500/30 text-orange-500 dark:text-orange-300",
  actor: "border-green-500/30 text-green-500 dark:text-green-300",
  workspace_member:
    "border-fuchsia-500/30 text-fuchsia-500 dark:text-fuchsia-300",
}

export const transportLabels: Record<string, string> = {
  http: "Remote MCP",
  builtin: "Built-in",
  stdio: "Local",
}

type PluginInstallationSummaryShape = {
  ownerWorkspaceMemberId?: string | null
  lifecycle_scope?: string | null
  is_enabled?: boolean | null
}

const lifecycleSummaryByScope: Record<string, string> = {
  turn: "fresh for every run",
  session: "reused per actor in each conversation",
  workspace: "reused across the workspace",
  conversation: "reused per conversation",
  actor: "reused per actor",
}

export function getPluginInstallationTitle(
  _installation: PluginInstallationSummaryShape
) {
  return "Plugin configuration"
}

export function getPluginInstallationDetails(
  installation: PluginInstallationSummaryShape
) {
  const ownershipSummary = installation.ownerWorkspaceMemberId
    ? "Owned by one workspace member"
    : "Owned by the workspace"
  const lifecycleSummary =
    lifecycleSummaryByScope[installation.lifecycle_scope || ""] ||
    `reuse: ${installation.lifecycle_scope || "turn"}`
  const statusSummary = installation.is_enabled ? "enabled" : "disabled"
  return `${ownershipSummary}, ${lifecycleSummary}, ${statusSummary}.`
}

export function PluginIcon({
  iconUrl,
  title,
  transport,
  verified = false,
  className = "h-7 w-7",
  containerClassName = "h-[60px] w-[60px] rounded-[18px]",
}: {
  iconUrl?: string | null
  title: string
  transport?: string
  verified?: boolean
  className?: string
  containerClassName?: string
}) {
  const Icon =
    transport === "http" ? Globe : transport === "builtin" ? Code : Puzzle
  const resolvedIconUrl = resolveFileUrl(iconUrl)

  return (
    <div className="relative flex-shrink-0">
      <div
        className={`flex items-center justify-center overflow-hidden border border-slate-200 bg-slate-100 text-slate-700 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-200 ${containerClassName}`}
      >
        {resolvedIconUrl ? (
          <img
            src={resolvedIconUrl}
            alt={title}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon className={className} />
        )}
      </div>
      {verified ? (
        <div className="absolute -right-1 -bottom-1 rounded-full bg-background p-0.5 shadow-sm ring-1 ring-border/80">
          <BadgeCheck className="size-4 fill-sky-500 text-sky-500" />
          <span className="sr-only">Verified official plugin</span>
        </div>
      ) : null}
    </div>
  )
}

export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <Badge
      variant="outline"
      className={
        attachmentScopeColors[scope] ||
        "border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300"
      }
    >
      {attachmentScopeLabels[scope] || scope}
    </Badge>
  )
}
