"use client"

// Plugin detail — a centered Dialog (not a drawer). Two states in one component:
// BROWSE (pre-install decision: 简介 · 工具 · 权限 · 配置项预览 · 安装) and MANAGE
// (post-install: the auto-generated config form + connect flow + enable switch +
// 卸载, with 工具/权限 kept below). Honest to the contract: real longDescription,
// real toolsManifest (with the "discovered live" state when []), real permissions,
// configFields-driven form, real auth drivers. No per-tool toggles, no ratings.
import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { ExternalLink, ShieldCheck, TriangleAlert, Wrench } from "lucide-react"
import { toast } from "sonner"
import type {
  MarketplacePluginView,
  PluginInstallationDetailView,
} from "@synapse/shared"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PluginIcon } from "./plugin-ui"
import { pluginHealth } from "./plugin-card"
import { PluginConfigForm } from "./plugin-config-form"
import {
  draftInstallation,
  pluginAuthLabel,
  pluginBrandSlug,
  regionLabel,
  transportLabel,
} from "@/lib/design/fixtures/mcp-plugins"

const FIELD_HINT: Record<string, string> = {
  secret: "密钥 · 保存后仅显示后 4 位",
  auth_connection: "账号授权",
  text: "文本",
  boolean: "开关",
  select: "选项",
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function Tools({ plugin }: { plugin: MarketplacePluginView }) {
  const tools = plugin.toolsManifest as Array<{
    name?: string
    description?: string
  }>
  return (
    <Section
      icon={<Wrench className="size-3.5 text-muted-foreground" />}
      title="工具"
    >
      {tools.length > 0 ? (
        <div className="divide-y rounded-lg border">
          {tools.map((t, i) => (
            <div key={i} className="px-3 py-2 text-sm">
              <code className="text-[13px]">{t.name}</code>
              {t.description && (
                <span className="ml-2 text-muted-foreground">
                  {t.description}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          工具由「{plugin.displayName}」服务在连接时实时下发，安装后可查看。
        </p>
      )}
    </Section>
  )
}

function Permissions({ plugin }: { plugin: MarketplacePluginView }) {
  return (
    <Section
      icon={<ShieldCheck className="size-3.5 text-muted-foreground" />}
      title="需要的权限"
    >
      <div className="flex flex-wrap gap-1.5">
        {plugin.authorization.requiredPermissions.map((p) => (
          <span
            key={p}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {p}
          </span>
        ))}
      </div>
      {plugin.authorization.reason && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {plugin.authorization.reason}
        </p>
      )}
    </Section>
  )
}

export function PluginDetailDialog({
  plugin,
  installation,
  open,
  onOpenChange,
  workspaceId,
}: {
  plugin: MarketplacePluginView | null
  installation: PluginInstallationDetailView | null
  open: boolean
  onOpenChange: (o: boolean) => void
  workspaceId: string
}) {
  const qc = useQueryClient()
  const [localInst, setLocalInst] =
    useState<PluginInstallationDetailView | null>(installation)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  useEffect(() => {
    setLocalInst(installation)
    setConfirmUninstall(false)
  }, [installation, plugin, open])

  if (!plugin) return null
  const managing = !!localInst
  const health = localInst ? pluginHealth(localInst) : null

  const install = async () => {
    setLocalInst(draftInstallation(plugin))
    void api
      .installPlugin(workspaceId, { pluginId: plugin.id } as Parameters<
        typeof api.installPlugin
      >[1])
      .catch(() => {})
    qc.invalidateQueries({ queryKey: ["plugin-installations", workspaceId] })
    toast.success("已安装 · 请完成配置")
  }
  const toggleEnable = () => {
    if (!localInst) return
    const next = !localInst.isEnabled
    setLocalInst({
      ...localInst,
      isEnabled: next,
      status: next ? "active" : "disabled",
    })
    void api
      .updateInstallation(workspaceId, localInst.id, {
        isEnabled: next,
      } as Parameters<typeof api.updateInstallation>[2])
      .catch(() => {})
    toast.message(next ? "已启用" : "已停用")
  }
  const uninstall = async () => {
    if (!localInst) return
    void api.uninstallPlugin(workspaceId, localInst.id).catch(() => {})
    qc.invalidateQueries({ queryKey: ["plugin-installations", workspaceId] })
    toast.success("已卸载")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="sr-only">{plugin.displayName}</DialogTitle>
        </DialogHeader>

        {/* header */}
        <div className="flex items-start gap-3">
          <PluginIcon
            brandSlug={pluginBrandSlug(plugin.slug)}
            title={plugin.displayName}
            transport={plugin.transport}
            className="size-7"
            containerClassName="size-12 rounded-2xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-lg font-semibold">
                {plugin.displayName}
              </h2>
              {plugin.isBuiltin && (
                <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground/70">
                  官方
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{plugin.categories[0]?.displayName}</span>
              <span>· {transportLabel(plugin.transport)}</span>
              <span>· {regionLabel(plugin.slug)}</span>
              <span>· {pluginAuthLabel(plugin)}</span>
            </div>
          </div>
          {health && (
            <span className="mr-7 flex shrink-0 items-center gap-1.5 text-xs">
              <span className={cn("size-1.5 rounded-full", health.dot)} />
              <span
                className={
                  health.danger ? "text-red-600" : "text-muted-foreground"
                }
              >
                {health.label}
              </span>
            </span>
          )}
        </div>

        <div className="mt-5 space-y-5">
          {managing && localInst ? (
            <>
              {plugin.configFields.length > 0 && (
                <Section title="配置">
                  <PluginConfigForm
                    plugin={plugin}
                    installation={localInst}
                    workspaceId={workspaceId}
                    onConfigStateChange={(next) =>
                      setLocalInst({ ...localInst, configState: next })
                    }
                  />
                </Section>
              )}

              <label className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <div className="text-sm">启用</div>
                  <div className="text-xs text-muted-foreground">
                    启用范围：
                    {localInst.defaultReuseScope === "conversation"
                      ? "会话"
                      : "工作区"}{" "}
                    · 对该范围内的所有会话生效
                  </div>
                </div>
                <Switch
                  checked={localInst.isEnabled}
                  onCheckedChange={toggleEnable}
                />
              </label>

              <Tools plugin={plugin} />
              <Permissions plugin={plugin} />
            </>
          ) : (
            <>
              <Section title="简介">
                <p className="text-sm leading-6 text-foreground/80">
                  {plugin.longDescription}
                </p>
              </Section>
              <Tools plugin={plugin} />
              <Permissions plugin={plugin} />
              {plugin.configFields.length > 0 && (
                <Section title="配置项">
                  <div className="space-y-1.5">
                    {plugin.configFields.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-baseline gap-2 text-sm"
                      >
                        <span className="min-w-24 shrink-0">
                          {f.titleI18n["zh-CN"] ?? f.key}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {FIELD_HINT[f.type] ?? f.type}
                          {f.required && " · 必填"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
              <p className="rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                插件仅在你授权的范围内调用外部服务，不会获得超出你自身权限的数据。
              </p>
            </>
          )}
        </div>

        {/* footer */}
        <div className="mt-5 flex items-center justify-between border-t pt-4">
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => toast.message("打开文档（示例）")}
          >
            <ExternalLink className="size-3.5" /> 查看文档
          </button>
          {managing ? (
            confirmUninstall ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="flex items-center gap-1 text-amber-600">
                  <TriangleAlert className="size-3.5" /> 确认卸载？
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmUninstall(false)}
                >
                  取消
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-600"
                  onClick={uninstall}
                >
                  卸载
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="text-red-600 hover:text-red-600"
                onClick={() => setConfirmUninstall(true)}
              >
                卸载
              </Button>
            )
          ) : (
            <Button onClick={install}>安装</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
