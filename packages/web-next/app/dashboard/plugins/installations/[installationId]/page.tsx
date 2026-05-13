"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import PluginInstallationWorkbench from "../../plugin-installation-workbench"
import PluginHeroCard from "../../plugin-hero-card"

export default function PluginInstallationPage() {
  const params = useParams<{ installationId: string }>()
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const [plugin, setPlugin] = useState<any>(null)
  const [installations, setInstallations] = useState<any[]>([])
  const [installation, setInstallation] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const installationId = params.installationId

  useEffect(() => {
    if (!workspaceId || !installationId) return
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        const data = await api.getInstallation(workspaceId, installationId)
        if (cancelled) return

        const currentInstallation = data.installation
        const [pluginData, installData] = await Promise.all([
          api.getMarketplacePlugin(currentInstallation.plugin_id),
          api.getInstallations(
            workspaceId,
            new URLSearchParams({
              pluginId: currentInstallation.plugin_id,
            }).toString()
          ),
        ])

        if (!cancelled) {
          setInstallation(currentInstallation)
          setPlugin(pluginData)
          setInstallations(installData)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [installationId, workspaceId])

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Loading installation...
      </div>
    )
  }

  if (!installation || !plugin) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Installation not found.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 px-4 pt-6 pb-6 lg:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            router.push(
              `/dashboard/plugins/${installation.plugin_id}?installationId=${installation.id}`
            )
          }
        >
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
      </div>

      <PluginHeroCard plugin={plugin} eyebrow="Configuration" />

      <div>
        <PluginInstallationWorkbench
          plugin={plugin}
          installations={installations}
          selectedInstallationId={installation.id}
          initialInstallation={installation}
          onSelectInstallation={(nextInstallationId) =>
            router.replace(
              `/dashboard/plugins/installations/${nextInstallationId}`,
              { scroll: false }
            )
          }
          onCreateInstallation={() =>
            router.push(`/dashboard/plugins/${installation.plugin_id}/install`)
          }
          onInstallationsChanged={async (updatedInstallation) => {
            if (!workspaceId) return
            const [freshInstallation, freshInstallations] = await Promise.all([
              api.getInstallation(workspaceId, updatedInstallation.id),
              api.getInstallations(
                workspaceId,
                new URLSearchParams({
                  pluginId: installation.plugin_id,
                }).toString()
              ),
            ])
            setInstallation(freshInstallation.installation)
            setInstallations(freshInstallations)
          }}
        />
      </div>
    </div>
  )
}
