"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Plus, Trash2 } from "lucide-react"
import {
  AppCard,
  AppCardContent,
  AppCardHeader,
  AppCardTitle,
} from "@/components/app-card"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { useWorkspace } from "@/app/dashboard/workspace-provider"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import InstallDialog from "./install-dialog"
import WorkspaceAppAccessStep from "./workspace-app-access-step"
import PluginAdvancedStep from "./plugin-advanced-step"
import {
  getPluginInstallationDetails,
  getPluginInstallationTitle,
} from "./plugin-ui"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

interface Props {
  plugin: any
  installations: any[]
  selectedInstallationId?: string | null
  initialInstallation?: any | null
  onSelectInstallation: (installationId: string) => void
  onCreateInstallation: () => void
  onInstallationsChanged?: (installation: any) => void | Promise<void>
}

export default function PluginInstallationWorkbench({
  plugin,
  installations,
  selectedInstallationId,
  initialInstallation,
  onSelectInstallation,
  onCreateInstallation,
  onInstallationsChanged,
}: Props) {
  const router = useRouter()
  const { workspaceId } = useWorkspace()
  const activeInstallationId = useMemo(() => {
    if (!installations.length) return null
    if (
      selectedInstallationId &&
      installations.some(
        (installation) => installation.id === selectedInstallationId
      )
    ) {
      return selectedInstallationId
    }
    return installations[0]?.id || null
  }, [installations, selectedInstallationId])

  const [selectedInstallation, setSelectedInstallation] = useState<any | null>(
    initialInstallation?.id === activeInstallationId
      ? initialInstallation
      : null
  )
  const [loadingInstallation, setLoadingInstallation] = useState(false)
  const [editorVersion, setEditorVersion] = useState(0)
  const [savingSettings, setSavingSettings] = useState(false)
  const [removingInstallation, setRemovingInstallation] = useState(false)

  useEffect(() => {
    if (initialInstallation?.id === activeInstallationId) {
      setSelectedInstallation(initialInstallation)
    }
  }, [activeInstallationId, initialInstallation])

  useEffect(() => {
    if (!workspaceId || !activeInstallationId) {
      setSelectedInstallation(null)
      return
    }

    if (initialInstallation?.id === activeInstallationId) {
      return
    }

    let cancelled = false

    const load = async () => {
      try {
        setLoadingInstallation(true)
        const data = await api.getInstallation(
          workspaceId,
          activeInstallationId
        )
        if (!cancelled) {
          setSelectedInstallation(data.installation)
        }
      } finally {
        if (!cancelled) {
          setLoadingInstallation(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [activeInstallationId, initialInstallation?.id, workspaceId])

  const resetSelectedInstallation = async () => {
    if (!workspaceId || !activeInstallationId) return
    const data = await api.getInstallation(workspaceId, activeInstallationId)
    setSelectedInstallation(data.installation)
    setEditorVersion((value) => value + 1)
  }

  const handleToggleInstallation = async (enabled: boolean) => {
    if (!workspaceId || !selectedInstallation || savingSettings) return
    try {
      setSavingSettings(true)
      const installation = await api.updateInstallation(
        workspaceId,
        selectedInstallation.id,
        {
          isEnabled: enabled,
        }
      )
      setSelectedInstallation(installation)
      await onInstallationsChanged?.(installation)
    } finally {
      setSavingSettings(false)
    }
  }

  const handleUninstallInstallation = async () => {
    if (!workspaceId || !selectedInstallation || removingInstallation) return
    if (!confirm("Are you sure you want to uninstall this configuration?"))
      return

    try {
      setRemovingInstallation(true)
      const removedId = selectedInstallation.id as string
      await api.uninstallPlugin(workspaceId, removedId)
      const remainingInstallations = await api.getInstallations(
        workspaceId,
        new URLSearchParams({ pluginId: plugin.id }).toString()
      )

      if (remainingInstallations.length > 0) {
        onSelectInstallation(remainingInstallations[0].id)
        return
      }

      router.push(`/dashboard/plugins/${plugin.id}`)
    } finally {
      setRemovingInstallation(false)
    }
  }

  return (
    <AppCard
      variant="panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <AppCardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 px-6 py-6">
        <div className="space-y-1">
          <AppCardTitle>Configurations</AppCardTitle>
          <div className="text-sm text-muted-foreground">
            Each installation is one configuration. Select one on the left, then
            manage setup, access, and advanced settings on the right.
          </div>
        </div>
        <div className="flex items-center gap-3">
          {selectedInstallation ? (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>
                  {selectedInstallation.isEnabled ? "Enabled" : "Disabled"}
                </span>
                <Switch
                  checked={Boolean(selectedInstallation.isEnabled)}
                  onCheckedChange={(checked) =>
                    void handleToggleInstallation(checked)
                  }
                  disabled={savingSettings || removingInstallation}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleUninstallInstallation()}
                disabled={savingSettings || removingInstallation}
              >
                <Trash2 data-icon="inline-start" />
                Remove
              </Button>
            </>
          ) : null}
          <Button size="sm" onClick={onCreateInstallation}>
            <Plus data-icon="inline-start" />
            New Configuration
          </Button>
        </div>
      </AppCardHeader>

      <AppCardContent className="min-h-0 flex-1 px-6 pt-0 pb-6">
        <div className="grid min-h-0 grid-rows-[16rem_minmax(0,1fr)] gap-4 xl:grid-cols-[320px_minmax(0,1fr)] xl:grid-rows-none">
          <Card className="min-h-0 rounded-[28px] py-0">
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-3 p-4">
                {installations.map((installation) => {
                  const selected = installation.id === activeInstallationId
                  return (
                    <button
                      key={installation.id}
                      type="button"
                      onClick={() => onSelectInstallation(installation.id)}
                      className={cn(
                        "flex flex-col gap-3 rounded-[22px] border px-4 py-4 text-left transition-all",
                        selected
                          ? "border-foreground/15 bg-accent/70 text-accent-foreground shadow-sm"
                          : "border-transparent bg-muted/30 hover:border-border hover:bg-muted/60"
                      )}
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="text-sm font-medium text-foreground">
                            {getPluginInstallationTitle(installation)}
                          </div>
                          <div
                            className={cn(
                              "inline-flex items-center gap-2 text-xs whitespace-nowrap",
                              installation.isEnabled
                                ? "text-emerald-600 dark:text-emerald-300"
                                : "text-muted-foreground"
                            )}
                          >
                            <span
                              className={cn(
                                "size-2 rounded-full",
                                installation.isEnabled
                                  ? "bg-emerald-500"
                                  : "bg-muted-foreground/35"
                              )}
                            />
                            {installation.isEnabled ? "Enabled" : "Disabled"}
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {getPluginInstallationDetails(installation)}
                        </p>
                        <p className="text-xs text-muted-foreground/80">
                          {installation.orgDisplayName
                            ? `${installation.orgDisplayName} · v${installation.pluginVersion}`
                            : `Version ${installation.pluginVersion}`}
                        </p>
                      </div>
                    </button>
                  )
                })}

                <button
                  type="button"
                  onClick={onCreateInstallation}
                  className="rounded-[22px] border border-dashed border-border bg-muted/15 px-4 py-4 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
                >
                  Create configuration
                </button>
              </div>
            </ScrollArea>
          </Card>

          <div className="min-h-0 min-w-0">
            {!activeInstallationId ? (
              <Card className="rounded-[28px]">
                <CardContent className="flex min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
                  Select a configuration from the left.
                </CardContent>
              </Card>
            ) : loadingInstallation || !selectedInstallation ? (
              <Card className="rounded-[28px]">
                <CardContent className="flex min-h-[18rem] items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 animate-spin" />
                  Loading configuration...
                </CardContent>
              </Card>
            ) : (
              <Tabs
                defaultValue="setup"
                className="flex h-full min-h-0 flex-col gap-4"
              >
                <TabsList>
                  <TabsTrigger value="setup">Setup</TabsTrigger>
                  <TabsTrigger value="access">Access</TabsTrigger>
                  <TabsTrigger value="advanced">Advanced</TabsTrigger>
                </TabsList>

                <TabsContent value="setup" className="mt-0 min-h-0 flex-1">
                  <Card className="flex h-full min-h-0 flex-1 flex-col rounded-[28px]">
                    <CardHeader>
                      <CardTitle>Setup</CardTitle>
                      <CardDescription>
                        Configure this plugin installation. Owner, runtime
                        lifecycle, and sharing are handled in their own tabs.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="min-h-0 flex-1 pb-6">
                      <div className="flex h-full min-h-0 flex-col">
                        <InstallDialog
                          key={`${selectedInstallation.id}:${editorVersion}`}
                          plugin={plugin}
                          initialInstallation={selectedInstallation}
                          presentation="page"
                          showPluginHeader={false}
                          pageChrome="tab"
                          includePlacementSteps={false}
                          includeAccessStep={false}
                          closeLabel="Reset"
                          onClose={() => {
                            void resetSelectedInstallation()
                          }}
                          onInstallationSaved={async (installation) => {
                            setSelectedInstallation(installation)
                            await onInstallationsChanged?.(installation)
                          }}
                          onSuccess={async (installation) => {
                            setSelectedInstallation(installation)
                            setEditorVersion((value) => value + 1)
                            await onInstallationsChanged?.(installation)
                          }}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="access" className="mt-0 min-h-0 flex-1">
                  <WorkspaceAppAccessStep installation={selectedInstallation} />
                </TabsContent>

                <TabsContent value="advanced" className="mt-0 min-h-0 flex-1">
                  <PluginAdvancedStep
                    installation={selectedInstallation}
                    onSaved={async (installation) => {
                      setSelectedInstallation(installation)
                      setEditorVersion((value) => value + 1)
                      await onInstallationsChanged?.(installation)
                    }}
                  />
                </TabsContent>
              </Tabs>
            )}
          </div>
        </div>
      </AppCardContent>
    </AppCard>
  )
}
