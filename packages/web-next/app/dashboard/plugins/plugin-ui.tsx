"use client"

import { BadgeCheck, Globe, Code, Puzzle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { PLUGIN_BRAND_ICONS } from "@/components/plugin-brand-icons"

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
  lifecycleScope?: string | null
  isEnabled?: boolean | null
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
    lifecycleSummaryByScope[installation.lifecycleScope || ""] ||
    `reuse: ${installation.lifecycleScope || "turn"}`
  const statusSummary = installation.isEnabled ? "enabled" : "disabled"
  return `${ownershipSummary}, ${lifecycleSummary}, ${statusSummary}.`
}

export function PluginIcon({
  brandSlug,
  title,
  transport,
  verified = false,
  className = "h-7 w-7",
  containerClassName = "h-[60px] w-[60px] rounded-[18px]",
}: {
  /** Publisher org slug — keys the colored brand glyph (builtin plugins). */
  brandSlug?: string | null
  title: string
  transport?: string
  verified?: boolean
  className?: string
  containerClassName?: string
}) {
  const BrandIcon = brandSlug ? PLUGIN_BRAND_ICONS[brandSlug] : undefined
  const FallbackIcon =
    transport === "http" ? Globe : transport === "builtin" ? Code : Puzzle

  return (
    <div className="relative flex-shrink-0" title={title}>
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden border shadow-sm",
          // Brand marks (incl. near-black github/notion/z.ai) read on a white
          // tile in both themes; the generic fallback keeps the slate treatment.
          BrandIcon
            ? "border-slate-200 bg-white dark:border-white/10"
            : "border-slate-200 bg-slate-100 text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-200",
          containerClassName
        )}
      >
        {BrandIcon ? (
          <BrandIcon className={className} />
        ) : (
          <FallbackIcon className={className} />
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
