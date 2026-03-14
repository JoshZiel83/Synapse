import { Download, Eye, RefreshCw, ScanSearch, ShieldCheck, Workflow } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import type { ImportServer, ImportSource } from '../types'

interface SyncPanelProps {
  sources: ImportSource[]
  onDetectSources: () => Promise<unknown>
  onImportServers: (servers: ImportServer[]) => Promise<void>
  onSetSyncSourceMode: (source: ImportSource, syncMode: 'import_only' | 'observe' | 'mirror' | 'managed' | 'detached') => Promise<void>
}

export function SyncPanel({
  sources,
  onDetectSources,
  onImportServers,
  onSetSyncSourceMode,
}: SyncPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')

  const availableServers = sources.flatMap((source) => source.available ? source.servers.map((server) => ({ source, server })) : [])
  const syncModes: Array<{
    value: 'import_only' | 'observe' | 'mirror' | 'managed' | 'detached'
    label: string
    icon: typeof Eye
  }> = [
    { value: 'import_only', label: 'Import Only', icon: Download },
    { value: 'observe', label: 'Observe', icon: Eye },
    { value: 'mirror', label: 'Mirror', icon: Workflow },
    { value: 'managed', label: 'Managed', icon: ShieldCheck },
    { value: 'detached', label: 'Detached', icon: ScanSearch },
  ]

  function toggleServer(key: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  async function handleDetect() {
    setLoading(true)
    setMessage('')
    try {
      await onDetectSources()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    const servers = availableServers
      .filter(({ source, server }) => selected.has(`${source.name}::${server.name}`))
      .map(({ server }) => server)

    if (servers.length === 0) return

    setImporting(true)
    setMessage('')
    try {
      await onImportServers(servers)
      setMessage(`Imported ${servers.length} server(s) into the relay config.`)
      setSelected(new Set())
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Sync Sources</CardTitle>
              <CardDescription>
                Current client behavior is import-first. Detected configs can be pulled into relay-managed MCP definitions.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleDetect} disabled={loading}>
                <RefreshCw data-icon="inline-start" />
                {loading ? 'Scanning...' : 'Rescan'}
              </Button>
              <Button onClick={handleImport} disabled={importing || selected.size === 0}>
                <Download data-icon="inline-start" />
                {importing ? 'Importing...' : `Import ${selected.size || ''}`.trim()}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {sources.map((source) => (
              <div key={source.name} className="rounded-2xl border border-border/60 bg-background/25 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{source.name}</div>
                  <Badge variant={source.available ? 'success' : source.error ? 'destructive' : 'secondary'}>
                    {source.available ? 'ready' : source.error ? 'error' : 'missing'}
                  </Badge>
                </div>
                <div className="mt-2 break-all text-xs text-muted-foreground">{source.configPath}</div>
                <div className="mt-3 text-sm text-muted-foreground">
                  {source.available
                    ? `${source.servers.length} server(s) found`
                    : source.error || 'Config not found'}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {source.linkedMcps ? <Badge variant="outline">{source.linkedMcps} linked MCPs</Badge> : null}
                  {source.syncMode ? <Badge variant="secondary">{source.syncMode}</Badge> : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {syncModes.map((mode) => {
                    const Icon = mode.icon
                    return (
                      <Button
                        key={mode.value}
                        type="button"
                        size="sm"
                        variant={source.syncMode === mode.value ? 'default' : 'outline'}
                        onClick={() => void onSetSyncSourceMode(source, mode.value)}
                      >
                        <Icon data-icon="inline-start" />
                        {mode.label}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Detected Servers</CardTitle>
              <CardDescription>
                Select import candidates from Claude, Codex, Gemini, OpenCode, or other local tool configurations.
              </CardDescription>
            </div>
            <Badge variant="secondary">{availableServers.length} detected</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {availableServers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
              <div className="flex justify-center">
                <ScanSearch className="size-5" />
              </div>
              <div className="mt-3">No MCP servers detected from known tools.</div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {availableServers.map(({ source, server }) => {
                const key = `${source.name}::${server.name}`
                const active = selected.has(key)

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleServer(key)}
                    className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border/60 bg-background/25 hover:bg-background/35'
                    }`}
                  >
                    <div className={`flex size-5 items-center justify-center rounded-full border text-[11px] ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-transparent'}`}>
                      ✓
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium">{server.name}</div>
                        <Badge variant="secondary">{source.name}</Badge>
                        <Badge variant="secondary">{server.transport}</Badge>
                      </div>
                      <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                        {server.transport === 'stdio'
                          ? `${server.command || ''} ${(server.args || []).join(' ')}`
                          : server.endpoint}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {message ? (
            <div className="mt-4 rounded-2xl border border-border/60 bg-background/25 px-4 py-3 text-sm text-foreground">
              {message}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
