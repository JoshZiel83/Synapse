"use client"

// Plugin cards — one flat neutral card, two variants (marketplace / installed)
// differing only in the primary action + a health dot. The brand icon carries
// essentially the only saturated color (impeccable ~10% rule); meta is ≤3 quiet
// plain-text chips (category · transport-in-words · auth-requirement) + a muted
// region word. No ratings, no downloads, no colored scope badges.
import type {
  MarketplacePluginView,
  PluginInstallationDetailView,
} from "@synapse/shared"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PluginIcon } from "./plugin-ui"
import {
  pluginAuthLabel,
  pluginBrandSlug,
  regionLabel,
  transportLabel,
} from "@/lib/design/fixtures/mcp-plugins"

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border px-1.5 py-0 text-[11px] leading-5 text-muted-foreground">
      {children}
    </span>
  )
}

// derive one health enum from the real installed state
export function pluginHealth(inst: PluginInstallationDetailView): {
  label: string
  dot: string
  danger?: boolean
} {
  if (inst.status === "error")
    return { label: "异常", dot: "bg-red-500", danger: true }
  if (!inst.isEnabled)
    return { label: "已停用", dot: "border border-muted-foreground/40" }
  const authField = inst.configFields.find((f) => f.type === "auth_connection")
  const needsAuth =
    authField &&
    !inst.configState.find((s) => s.key === authField.key)?.authConnectionId
  if (needsAuth) return { label: "需授权", dot: "bg-muted-foreground/40" }
  const needsConfig = inst.configFields.some(
    (f) =>
      f.required &&
      f.type !== "auth_connection" &&
      !inst.configState.find((s) => s.key === f.key)?.isConfigured
  )
  if (needsConfig) return { label: "需配置", dot: "bg-muted-foreground/40" }
  return { label: "已启用", dot: "bg-emerald-500" }
}

function Shell({
  plugin,
  onOpen,
  chips,
  action,
}: {
  plugin: MarketplacePluginView
  onOpen: () => void
  chips: React.ReactNode
  action: React.ReactNode
}) {
  return (
    <div className="group relative flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-foreground/20">
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 rounded-xl"
        aria-label={plugin.displayName}
      />
      <PluginIcon
        brandSlug={pluginBrandSlug(plugin.slug)}
        title={plugin.displayName}
        transport={plugin.transport}
        className="size-6"
        containerClassName="size-10 rounded-xl"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {plugin.displayName}
          </span>
          {plugin.isBuiltin && (
            <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground/70">
              官方
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
          {plugin.description}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div>
      </div>
      <div className="relative z-10 shrink-0">{action}</div>
    </div>
  )
}

function MetaChips({ plugin }: { plugin: MarketplacePluginView }) {
  return (
    <>
      {plugin.categories[0] && <Chip>{plugin.categories[0].displayName}</Chip>}
      <Chip>{transportLabel(plugin.transport)}</Chip>
      <Chip>{pluginAuthLabel(plugin)}</Chip>
      <span className="text-[11px] text-muted-foreground/50">
        {regionLabel(plugin.slug)}
      </span>
    </>
  )
}

export function MarketPluginCard({
  plugin,
  installed,
  onOpen,
}: {
  plugin: MarketplacePluginView
  installed: boolean
  onOpen: () => void
}) {
  return (
    <Shell
      plugin={plugin}
      onOpen={onOpen}
      chips={<MetaChips plugin={plugin} />}
      action={
        installed ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={onOpen}
          >
            管理
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => toast.message("安装流程（Phase 2）")}
          >
            安装
          </Button>
        )
      }
    />
  )
}

export function InstalledPluginCard({
  inst,
  plugin,
  onOpen,
}: {
  inst: PluginInstallationDetailView
  plugin: MarketplacePluginView
  onOpen: () => void
}) {
  const health = pluginHealth(inst)
  return (
    <Shell
      plugin={plugin}
      onOpen={onOpen}
      chips={<MetaChips plugin={plugin} />}
      action={
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs">
            <span className={cn("size-1.5 rounded-full", health.dot)} />
            <span
              className={
                health.danger ? "text-red-600" : "text-muted-foreground"
              }
            >
              {health.label}
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={onOpen}
          >
            管理
          </Button>
        </div>
      }
    />
  )
}
