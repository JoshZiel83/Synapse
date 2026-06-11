"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import type { PluginInstallationDetailView } from "@synapse/shared"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Settings, Trash2, AlertTriangle } from "lucide-react"
import { usePluginStore } from "@/stores/plugin-store"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import {
  PluginIcon,
  getLocale,
  getPluginInstallationDetails,
  getPluginInstallationTitle,
  translate,
} from "./plugin-ui"

export default function InstalledList() {
  const router = useRouter()
  const {
    installations,
    loadingInstalled,
    uninstallPlugin,
    updateInstallation,
  } = usePluginStore()
  const { workspaceId } = useWorkspace()
  const locale = getLocale()

  const handleToggle = async (
    install: PluginInstallationDetailView,
    enabled: boolean
  ) => {
    if (!workspaceId) return
    await updateInstallation(workspaceId, install.id, { isEnabled: enabled })
  }

  const handleUninstall = async (installId: string) => {
    if (!workspaceId) return
    if (!confirm("Are you sure you want to uninstall this plugin?")) return
    await uninstallPlugin(workspaceId, installId)
  }

  const hasRequiredConfigMissing = (
    install: PluginInstallationDetailView
  ): boolean => {
    const fields = install.configFields || []
    const required = fields.filter((field) => field.required)
    if (required.length === 0) return false
    const configData = install.configData || {}
    const configState = new Map(
      (install.configState || []).map((state) => [state.key, state])
    )
    return required.some((field) => {
      if (field.type === "auth_connection") {
        return !configState.get(field.key)?.isConfigured
      }
      if (field.secret || field.type === "secret") {
        return !configState.get(field.key)?.isConfigured
      }
      return !configData[field.key]
    })
  }

  if (loadingInstalled) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        Loading installed plugins...
      </div>
    )
  }

  if (installations.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">No plugins installed yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse the Marketplace to find plugins.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {installations.map((install) => {
        const configMissing = hasRequiredConfigMissing(install)
        return (
          <Card
            key={install.id}
            className={`bg-white ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-white/10 ${configMissing ? "border-amber-500/20" : "border-gray-200 dark:border-white/10"}`}
          >
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <PluginIcon
                  iconUrl={install.pluginIconUrl}
                  title={
                    translate(
                      install.pluginDisplayNameI18n,
                      locale,
                      install.defaultLocale || "en"
                    ) || install.pluginDisplayName
                  }
                  transport={install.transport}
                  containerClassName="h-10 w-10 rounded-lg bg-blue-500/10"
                  className="h-5 w-5"
                />
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/dashboard/plugins/${install.pluginId}`}
                      className="text-sm font-medium hover:text-blue-600"
                    >
                      {translate(
                        install.pluginDisplayNameI18n,
                        locale,
                        install.defaultLocale || "en"
                      ) || install.pluginDisplayName}
                    </Link>
                    {configMissing && (
                      <Badge
                        variant="outline"
                        className="gap-1 border-amber-500/30 text-xs text-amber-400"
                      >
                        <AlertTriangle className="h-3 w-3" />
                        Config Required
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {getPluginInstallationTitle(install)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {getPluginInstallationDetails(install)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {install.orgDisplayName
                      ? `${install.orgDisplayName} · v${install.pluginVersion}`
                      : `Version ${install.pluginVersion}`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  checked={install.isEnabled}
                  onCheckedChange={(checked) => handleToggle(install, checked)}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    router.push(
                      `/dashboard/plugins/installations/${install.id}`
                    )
                  }
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-red-400 hover:text-red-300"
                  onClick={() => handleUninstall(install.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
