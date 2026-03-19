import {
  ArrowRightLeft,
  Blocks,
  Cable,
  CircleAlert,
  Link2,
  LayoutDashboard,
  Logs,
  Settings2,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from './components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog'
import { useRelayDesktop } from './hooks/use-relay-desktop'
import { useSystemTheme } from './hooks/use-system-theme'
import { cn } from './lib/utils'
import { LogsPanel } from './views/logs-panel'
import { AppsPanel, type AppsPanelHandle } from './views/apps-panel'
import { PairingPanel } from './views/pairing-panel'
import { ServersPanel } from './views/servers-panel'
import { SettingsPanel } from './views/settings-panel'
import { StatusPanel } from './views/status-panel'
import { SyncPanel } from './views/sync-panel'

type View = 'status' | 'logs' | 'pairing' | 'apps' | 'servers' | 'sync' | 'settings'

const navItems: Array<{
  value: View
  label: string
  icon: typeof LayoutDashboard
}> = [
  {
    value: 'status',
    label: 'Start',
    icon: LayoutDashboard,
  },
  {
    value: 'pairing',
    label: 'Pair',
    icon: Link2,
  },
  {
    value: 'apps',
    label: 'Apps',
    icon: Blocks,
  },
  {
    value: 'servers',
    label: 'MCP',
    icon: Cable,
  },
  {
    value: 'sync',
    label: 'Sync',
    icon: ArrowRightLeft,
  },
  {
    value: 'logs',
    label: 'Logs',
    icon: Logs,
  },
  {
    value: 'settings',
    label: 'Settings',
    icon: Settings2,
  },
]

function recommendedView(deviceId?: string, serverCount = 0): View {
  if (!deviceId) return 'pairing'
  if (serverCount === 0) return 'apps'
  return 'status'
}

export default function App() {
  useSystemTheme()

  const {
    config,
    status,
    logs,
    sources,
    banner,
    setBanner,
    ready,
    actions,
  } = useRelayDesktop()

  const [view, setView] = useState<View>('pairing')
  const [busy, setBusy] = useState<'starting' | 'stopping' | 'restarting' | null>(null)
  const [pendingView, setPendingView] = useState<View | null>(null)
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false)
  const [savingBeforeNavigate, setSavingBeforeNavigate] = useState(false)
  const didInitializeView = useRef(false)
  const appsPanelRef = useRef<AppsPanelHandle>(null)

  useEffect(() => {
    if (!ready) {
      return
    }

    setView((current) => {
      const next = recommendedView(config.relay?.deviceId, (config.servers || []).filter((server) => server.enabled !== false).length)
      if (!didInitializeView.current) {
        didInitializeView.current = true
        return next
      }
      return current || next
    })
  }, [config.relay?.deviceId, config.servers, ready])

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

  function closeUnsavedDialog() {
    setShowUnsavedDialog(false)
    setPendingView(null)
  }

  function handleNavigate(nextView: View) {
    if (nextView === view) {
      return
    }

    if (view === 'apps' && appsPanelRef.current?.hasUnsavedChanges()) {
      setPendingView(nextView)
      setShowUnsavedDialog(true)
      return
    }

    setView(nextView)
  }

  async function handleSaveAndContinue() {
    if (!pendingView || !appsPanelRef.current) {
      closeUnsavedDialog()
      return
    }

    setSavingBeforeNavigate(true)
    const saved = await appsPanelRef.current.saveChanges()
    setSavingBeforeNavigate(false)
    if (!saved) {
      return
    }

    setView(pendingView)
    closeUnsavedDialog()
  }

  function handleDiscardAndContinue() {
    if (pendingView) {
      setView(pendingView)
    }
    closeUnsavedDialog()
  }

  return (
    <div className="h-screen overflow-hidden text-foreground">
      <div className="relay-shell">
        <aside className="relay-sidebar">
          <nav className="relay-sidebar__nav" aria-label="Desktop sections">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = view === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  className={cn('relay-sidebar__item', active && 'relay-sidebar__item--active')}
                  onClick={() => handleNavigate(item.value)}
                >
                  <Icon strokeWidth={1.8} />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="relay-main">
          {banner ? (
            <div className="relay-banner">
              <div className="min-w-0 flex-1">
                <CircleAlert className="relay-banner__icon" />
                <span>{banner}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setBanner('')}>
                Dismiss
              </Button>
            </div>
          ) : null}

          <section className="relay-main__content">
            {view === 'status' ? (
              <StatusPanel
                config={config}
                status={status}
                busy={busy}
                onOpenPairing={() => handleNavigate('pairing')}
                onOpenServers={() => handleNavigate('servers')}
                onStart={() => void handleStart()}
                onStop={() => void handleStop()}
                onRestart={() => void handleRestart()}
              />
            ) : null}

            {view === 'logs' ? (
              <LogsPanel logs={logs} />
            ) : null}

            {view === 'pairing' ? (
              <PairingPanel
                onClaimPairing={(serverBaseUrl, pairingCode) => actions.claimPairing(serverBaseUrl, pairingCode, '')}
              />
            ) : null}

            {view === 'servers' ? (
              <ServersPanel
                config={config}
                onAddServer={(server) => actions.addServer(server)}
                onRemoveServer={(name) => actions.removeServer(name)}
              />
            ) : null}

            {view === 'apps' ? (
              <AppsPanel
                ref={appsPanelRef}
                config={config}
                onGetSuggestedFilesystemRoots={() => actions.getSuggestedFilesystemRoots()}
                onSave={(nextConfig) => actions.saveConfig(nextConfig)}
              />
            ) : null}

            {view === 'sync' ? (
              <SyncPanel
                config={config}
                sources={sources}
                onDetectSources={() => actions.detectSources()}
                onAddSyncSource={(source, syncMode) => actions.addSyncSource(source, syncMode)}
                onImportServer={(server) => actions.importServers([server])}
                onRemoveSyncSource={(sourceKey) => actions.removeSyncSource(sourceKey)}
                onSetSyncSourceMode={(source, syncMode) => actions.setSyncSourceMode(source, syncMode)}
              />
            ) : null}

            {view === 'settings' ? (
              <SettingsPanel
                config={config}
                onSave={(nextConfig) => actions.saveConfig(nextConfig)}
              />
            ) : null}
          </section>
        </main>
      </div>

      <Dialog open={showUnsavedDialog} onOpenChange={(open) => {
        if (!open) {
          closeUnsavedDialog()
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save changes before leaving?</DialogTitle>
            <DialogDescription>
              You have unsaved built-in app changes. Save them before switching menus, or discard them and continue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={closeUnsavedDialog} disabled={savingBeforeNavigate}>
              Stay
            </Button>
            <Button variant="outline" onClick={handleDiscardAndContinue} disabled={savingBeforeNavigate}>
              Discard
            </Button>
            <Button onClick={() => void handleSaveAndContinue()} disabled={savingBeforeNavigate}>
              {savingBeforeNavigate ? 'Saving...' : 'Save and Continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
