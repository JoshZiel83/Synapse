import {
  ArrowRightLeft,
  Bot,
  Cable,
  LayoutDashboard,
  Link2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { useRelayDesktop } from './hooks/use-relay-desktop'
import { OverviewPanel } from './views/overview-panel'
import { PairingPanel } from './views/pairing-panel'
import { ServersPanel } from './views/servers-panel'
import { SyncPanel } from './views/sync-panel'

type View = 'overview' | 'pairing' | 'servers' | 'sync'

const navItems: Array<{
  value: View
  label: string
  description: string
  icon: typeof LayoutDashboard
}> = [
  {
    value: 'overview',
    label: 'Runtime',
    description: 'Status, logs, and exposure health',
    icon: LayoutDashboard,
  },
  {
    value: 'pairing',
    label: 'Bind Device',
    description: 'Authorize the relay client first',
    icon: Link2,
  },
  {
    value: 'servers',
    label: 'MCP Servers',
    description: 'Configure local relay exposures',
    icon: Cable,
  },
  {
    value: 'sync',
    label: 'Sync Sources',
    description: 'Import from other MCP clients',
    icon: ArrowRightLeft,
  },
]

function recommendedView(deviceId?: string, serverCount = 0): View {
  if (!deviceId) return 'pairing'
  if (serverCount === 0) return 'sync'
  return 'overview'
}

export default function App() {
  const {
    config,
    status,
    logs,
    sources,
    banner,
    setBanner,
    actions,
  } = useRelayDesktop()

  const [view, setView] = useState<View>('pairing')
  const [busy, setBusy] = useState<'starting' | 'stopping' | 'restarting' | null>(null)

  useEffect(() => {
    setView((current) => {
      const next = recommendedView(config.relay?.deviceId, config.servers?.length || 0)
      if (current === 'pairing' && config.relay?.deviceId) return next
      if (current === 'sync' && (config.servers?.length || 0) > 0) return 'overview'
      if (current === 'overview' && !config.relay?.deviceId) return 'pairing'
      return current || next
    })
  }, [config.relay?.deviceId, config.servers?.length])

  const paired = Boolean(config.relay?.deviceId)
  const configuredServers = config.servers?.length || 0

  async function handleStart() {
    setBusy('starting')
    try {
      await actions.startRelay()
    } catch (cause) {
      setBanner(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleStop() {
    setBusy('stopping')
    try {
      await actions.stopRelay()
    } catch (cause) {
      setBanner(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function handleRestart() {
    setBusy('restarting')
    try {
      await actions.restartRelay()
    } catch (cause) {
      setBanner(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen p-4 text-foreground sm:p-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <Card className="overflow-hidden">
          <CardContent className="px-0 py-0">
            <div className="grid gap-0 xl:grid-cols-[320px_1fr]">
              <div className="border-b border-sidebar-border/80 bg-sidebar px-6 py-6 xl:border-b-0 xl:border-r">
                <div className="flex flex-col gap-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Synapse Relay</div>
                      <div className="mt-2 text-2xl font-semibold tracking-tight">Desktop Control Plane</div>
                    </div>
                    <div className="rounded-2xl border border-sidebar-border/80 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                      v2
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-sidebar-border/80 bg-sidebar-accent/60 p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
                      <Bot className="size-4" />
                      Guided Flow
                    </div>
                    <div className="mt-3 flex flex-col gap-3 text-sm text-sidebar-foreground">
                      <div className="flex items-center justify-between">
                        <span>1. Bind device</span>
                        <Badge variant={paired ? 'success' : 'secondary'}>{paired ? 'done' : 'required'}</Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>2. Configure MCPs</span>
                        <Badge variant={configuredServers > 0 ? 'success' : 'secondary'}>
                          {configuredServers > 0 ? `${configuredServers} ready` : 'pending'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>3. Start relay</span>
                        <Badge variant={status.state === 'running' ? 'success' : status.state === 'error' ? 'destructive' : 'secondary'}>
                          {status.state}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  <Tabs value={view} onValueChange={(next) => setView(next as View)} orientation="vertical">
                    <TabsList className="w-full flex-col items-stretch bg-sidebar-accent/30 p-1" variant="default">
                      {navItems.map((item) => {
                        const Icon = item.icon
                        return (
                          <TabsTrigger key={item.value} value={item.value} className="w-full justify-start gap-3">
                            <Icon />
                            <div className="min-w-0 text-left">
                              <div>{item.label}</div>
                              <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.description}</div>
                            </div>
                          </TabsTrigger>
                        )
                      })}
                    </TabsList>
                  </Tabs>

                  {banner ? (
                    <div className="rounded-2xl border border-sidebar-border/70 bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      {banner}
                    </div>
                  ) : null}

                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setBanner('')}>
                      Clear Notice
                    </Button>
                  </div>
                </div>
              </div>

              <div className="min-h-[calc(100vh-3rem)] bg-gradient-to-br from-background/95 via-background to-background/80 p-5 sm:p-6">
                <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Workspace</div>
                    <div className="mt-1 text-2xl font-semibold tracking-tight">{config.relay?.displayName || 'Unpaired Relay Client'}</div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      {paired
                        ? `${config.relay?.serverBaseUrl || 'Server configured'} · ${config.relay?.deviceId}`
                        : 'Start with pairing, then configure MCP servers and sync sources.'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={paired ? 'success' : 'secondary'}>{paired ? 'paired' : 'unpaired'}</Badge>
                    <Badge variant="secondary">{configuredServers} MCPs</Badge>
                    <Badge variant={status.state === 'running' ? 'success' : status.state === 'error' ? 'destructive' : 'secondary'}>
                      {status.state}
                    </Badge>
                  </div>
                </div>

                <Tabs value={view} onValueChange={(next) => setView(next as View)} className="gap-4">
                  <TabsContent value="overview">
                    <OverviewPanel
                      config={config}
                      status={status}
                      logs={logs}
                      busy={busy}
                      onStart={() => void handleStart()}
                      onStop={() => void handleStop()}
                      onRestart={() => void handleRestart()}
                    />
                  </TabsContent>

                  <TabsContent value="pairing">
                    <PairingPanel
                      config={config}
                      onClaimPairing={(serverBaseUrl, pairingCode, displayName) =>
                        actions.claimPairing(serverBaseUrl, pairingCode, displayName)}
                    />
                  </TabsContent>

                  <TabsContent value="servers">
                    <ServersPanel
                      config={config}
                      onAddServer={(server) => actions.addServer(server)}
                      onRemoveServer={(name) => actions.removeServer(name)}
                    />
                  </TabsContent>

                  <TabsContent value="sync">
                    <SyncPanel
                      sources={sources}
                      onDetectSources={() => actions.detectSources()}
                      onImportServers={(servers) => actions.importServers(servers)}
                      onSetSyncSourceMode={(source, syncMode) => actions.setSyncSourceMode(source, syncMode)}
                    />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
