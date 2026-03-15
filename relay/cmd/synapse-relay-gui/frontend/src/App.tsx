import {
  ArrowRightLeft,
  Cable,
  CircleAlert,
  Link2,
  LayoutDashboard,
  Logs,
  Settings2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from './components/ui/button'
import { useRelayDesktop } from './hooks/use-relay-desktop'
import { useSystemTheme } from './hooks/use-system-theme'
import { cn } from './lib/utils'
import { LogsPanel } from './views/logs-panel'
import { PairingPanel } from './views/pairing-panel'
import { ServersPanel } from './views/servers-panel'
import { SettingsPanel } from './views/settings-panel'
import { StatusPanel } from './views/status-panel'
import { SyncPanel } from './views/sync-panel'

type View = 'status' | 'logs' | 'pairing' | 'servers' | 'sync' | 'settings'

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
  if (serverCount === 0) return 'servers'
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
    actions,
  } = useRelayDesktop()

  const [view, setView] = useState<View>('pairing')
  const [busy, setBusy] = useState<'starting' | 'stopping' | 'restarting' | null>(null)

  useEffect(() => {
    setView((current) => {
      const next = recommendedView(config.relay?.deviceId, config.servers?.length || 0)
      if (current === 'pairing' && config.relay?.deviceId) return next
      if (current === 'status' && !config.relay?.deviceId) return 'pairing'
      return current || next
    })
  }, [config.relay?.deviceId, config.servers?.length])

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
                  onClick={() => setView(item.value)}
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
    </div>
  )
}
