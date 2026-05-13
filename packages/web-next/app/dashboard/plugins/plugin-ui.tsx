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

export const attachmentTypeLabels: Record<string, string> = {
  workspace: "Workspace",
  conversation: "Conversation",
  actor: "Actor",
  actor_in_conversation: "Actor in Conversation",
  workspace_member: "Workspace Member",
}

export const attachmentTypeColors: Record<string, string> = {
  workspace: "border-blue-500/30 text-blue-500 dark:text-blue-300",
  conversation: "border-orange-500/30 text-orange-500 dark:text-orange-300",
  actor: "border-green-500/30 text-green-500 dark:text-green-300",
  actor_in_conversation:
    "border-amber-500/30 text-amber-500 dark:text-amber-300",
  workspace_member:
    "border-fuchsia-500/30 text-fuchsia-500 dark:text-fuchsia-300",
}

export const transportLabels: Record<string, string> = {
  http: "Remote MCP",
  builtin: "Built-in",
  relay: "Relay",
  stdio: "Local",
}

type PluginInstallationSummaryShape = {
  attachment_target?: {
    type?: string | null
  } | null
  lifecycle_scope?: string | null
  is_enabled?: boolean | null
}

const ownershipSummaryByAttachmentType: Record<string, string> = {
  workspace: "Owned by this workspace",
  conversation: "Owned by one conversation",
  actor: "Owned by one actor",
  actor_in_conversation: "Owned by one actor in one conversation",
  workspace_member: "Owned by one workspace user",
}

const lifecycleSummaryByScope: Record<string, string> = {
  turn: "fresh for every run",
  session: "reused per actor in each conversation",
  workspace: "reused across the workspace",
  conversation: "reused per conversation",
  actor: "reused per actor",
}

export function getPluginInstallationTitle(
  installation: PluginInstallationSummaryShape
) {
  const attachmentType = installation.attachment_target?.type
  if (attachmentType === "workspace") {
    return "Workspace configuration"
  }
  if (attachmentType === "conversation") {
    return "Conversation configuration"
  }
  if (attachmentType === "actor") {
    return "Actor configuration"
  }
  if (attachmentType === "actor_in_conversation") {
    return "Actor + conversation configuration"
  }
  if (attachmentType === "workspace_member") {
    return "Workspace user configuration"
  }
  return `${attachmentTypeLabels[attachmentType || ""] || attachmentType || "Plugin"} configuration`
}

export function getPluginInstallationDetails(
  installation: PluginInstallationSummaryShape
) {
  const attachmentType = installation.attachment_target?.type || ""
  const ownershipSummary =
    ownershipSummaryByAttachmentType[attachmentType] ||
    `Owned by ${attachmentTypeLabels[attachmentType] || attachmentType || "this scope"}`
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
        attachmentTypeColors[scope] ||
        "border-gray-200 text-gray-600 dark:border-white/10 dark:text-gray-300"
      }
    >
      {attachmentTypeLabels[scope] || scope}
    </Badge>
  )
}
