"use client"

import { useEffect, useMemo, useState } from "react"
import type { PluginInstallationDetailView, ReuseScope } from "@synapse/shared"
import { REUSE_SCOPES } from "@synapse/shared"
import { Layers3, Save } from "lucide-react"

import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { AccessReuseScopeStep } from "@/app/dashboard/access/attachment-visuals"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { toast } from "sonner"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.dashboard.plugins.plugin-advanced-step")

type PluginReuseScope = ReuseScope

function normalizeSupportedReuseScopes(value: unknown): PluginReuseScope[] {
  const supported = Array.isArray(value)
    ? value.filter(
        (scope): scope is PluginReuseScope =>
          typeof scope === "string" &&
          REUSE_SCOPES.includes(scope as PluginReuseScope)
      )
    : []
  return supported.length > 0 ? supported : [...REUSE_SCOPES]
}

export default function PluginAdvancedStep({
  installation,
  onSaved,
}: {
  installation: PluginInstallationDetailView | null
  onSaved?: (installation: PluginInstallationDetailView) => void | Promise<void>
}) {
  const { workspaceId } = useWorkspace()

  const [lifecycleScope, setLifecycleScope] = useState<PluginReuseScope>("turn")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!installation) return

    setLifecycleScope(
      (installation.lifecycleScope || "turn") as PluginReuseScope
    )
  }, [installation])

  const allowedReuseScopes = useMemo(
    () =>
      normalizeSupportedReuseScopes(
        installation?.supportedReuseScopes ||
          installation?.pluginSupportedReuseScopes
      ),
    [
      installation?.pluginSupportedReuseScopes,
      installation?.supportedReuseScopes,
    ]
  )

  useEffect(() => {
    if (allowedReuseScopes.includes(lifecycleScope)) return
    setLifecycleScope(allowedReuseScopes[0] || "turn")
  }, [allowedReuseScopes, lifecycleScope])

  async function saveAdvancedSettings() {
    if (!workspaceId || !installation?.id) return
    setSaving(true)
    try {
      const result = await api.updateInstallation(
        workspaceId,
        installation.id,
        {
          lifecycleScope,
        }
      )
      await onSaved?.(result)
      toast.success("Advanced settings updated")
    } catch (error) {
      clientLog.error("Failed to update advanced plugin settings:", error)
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update advanced settings"
      )
    } finally {
      setSaving(false)
    }
  }

  if (!installation?.id) {
    return (
      <Card className="rounded-[28px]">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Finish installation first. Advanced owner and lifecycle settings
          appear here after the installation exists.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="rounded-[28px]">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Layers3 className="size-5 text-muted-foreground" />
          <CardTitle>Advanced</CardTitle>
        </div>
        <CardDescription>
          Change how this installation runtime is reused. Access stays in the
          Access tab.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6 pb-6">
        <AccessReuseScopeStep
          attachmentScopeType="workspace"
          value={lifecycleScope}
          onChange={(value) => setLifecycleScope(value as PluginReuseScope)}
          actors={[]}
          conversations={[]}
          selectedActorId=""
          selectedConversationId=""
          allowedReuseScopes={allowedReuseScopes}
        />

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => void saveAdvancedSettings()}
            disabled={saving}
          >
            <Save data-icon="inline-start" />
            {saving ? "Saving..." : "Save Advanced Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
