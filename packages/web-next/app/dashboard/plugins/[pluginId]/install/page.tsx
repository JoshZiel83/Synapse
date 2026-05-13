"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import {
  AppCard,
  AppCardContent,
  AppCardDescription,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import InstallDialog from "../../install-dialog"
import PluginHeroCard from "../../plugin-hero-card"

export default function PluginInstallPage() {
  const params = useParams<{ pluginId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { workspaceId } = useWorkspace()
  const [plugin, setPlugin] = useState<any>(null)
  const [installation, setInstallation] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const pluginId = params.pluginId
  const reconfigureInstallationId = searchParams.get("reconfigure")

  useEffect(() => {
    if (!workspaceId || !pluginId) return
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        const [pluginData, installationData] = await Promise.all([
          api.getMarketplacePlugin(pluginId),
          reconfigureInstallationId
            ? api.getInstallation(workspaceId, reconfigureInstallationId)
            : Promise.resolve(null),
        ])
        if (cancelled) return
        setPlugin(pluginData)
        setInstallation(installationData?.installation || null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [pluginId, reconfigureInstallationId, workspaceId])

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Loading install flow...
      </div>
    )
  }

  if (!plugin) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Plugin not found.
      </div>
    )
  }

  const isBuiltinInitialInstall = Boolean(plugin.is_builtin && !installation)

  return (
    <div className="flex flex-col gap-6 px-4 pt-6 pb-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => router.push(`/dashboard/plugins/${plugin.id}`)}
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <PluginHeroCard
        plugin={plugin}
        eyebrow={installation ? "Setup" : "New configuration"}
      />

      <AppCard variant="panel">
        <AppCardHeader className="px-6 py-6">
          <AppCardTitle>
            {installation ? "Update setup" : "Create configuration"}
          </AppCardTitle>
          <AppCardDescription>
            {installation
              ? "Adjust setup before returning to configuration management."
              : "Follow the guided setup below to create a new configuration for this plugin."}
          </AppCardDescription>
        </AppCardHeader>
        <AppCardContent className="min-h-0 px-6 pt-0 pb-6">
          <InstallDialog
            plugin={plugin}
            initialInstallation={installation}
            presentation="page"
            showPluginHeader={false}
            pageChrome="tab"
            includePlacementSteps={!isBuiltinInitialInstall}
            includeAccessStep={false}
            defaultAttachmentType={
              isBuiltinInitialInstall ? "workspace_member" : undefined
            }
            createDefaultWorkspaceAccess={isBuiltinInitialInstall}
            onClose={() =>
              router.push(
                installation
                  ? `/dashboard/plugins/installations/${installation.id}`
                  : `/dashboard/plugins/${plugin.id}`
              )
            }
            onSuccess={(savedInstallation) =>
              router.push(
                `/dashboard/plugins/installations/${savedInstallation.id}`
              )
            }
          />
        </AppCardContent>
      </AppCard>
    </div>
  )
}
