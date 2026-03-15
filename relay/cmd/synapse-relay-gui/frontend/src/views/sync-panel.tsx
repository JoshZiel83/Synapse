import { ChevronDown, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { Separator } from '../components/ui/separator'
import { cn } from '../lib/utils'
import type { ImportServer, ImportSource, RelayConfig, SyncSourceConfig } from '../types'

interface SyncPanelProps {
  config: RelayConfig
  sources: ImportSource[]
  onDetectSources: () => Promise<unknown>
  onAddSyncSource: (source: ImportSource, syncMode: SyncSourceConfig['syncMode']) => Promise<void>
  onImportServer: (server: ImportServer) => Promise<void>
  onRemoveSyncSource: (sourceKey: string) => Promise<void>
  onSetSyncSourceMode: (source: ImportSource, syncMode: SyncSourceConfig['syncMode']) => Promise<void>
}

const syncModes: Array<{
  value: SyncSourceConfig['syncMode']
  label: string
}> = [
  { value: 'observe', label: 'Observe' },
  { value: 'mirror', label: 'Mirror' },
  { value: 'managed', label: 'Managed' },
  { value: 'import_only', label: 'Import Only' },
]

function metadataDisplayName(metadata?: Record<string, unknown>) {
  const displayName = metadata?.displayName
  return typeof displayName === 'string' ? displayName : ''
}

export function SyncPanel({
  config,
  sources,
  onDetectSources,
  onAddSyncSource,
  onImportServer,
  onRemoveSyncSource,
  onSetSyncSourceMode,
}: SyncPanelProps) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedSourceKey, setSelectedSourceKey] = useState('')
  const [selectedMode, setSelectedMode] = useState<SyncSourceConfig['syncMode']>('observe')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const detectedByKey = new Map(sources.map((source) => [source.sourceKey, source]))
  const configuredTargets = (config.syncSources || []).map((syncSource) => {
    const detected = detectedByKey.get(syncSource.sourceKey)
    return {
      sourceKey: syncSource.sourceKey,
      name: detected?.name || metadataDisplayName(syncSource.metadata) || syncSource.sourceKind,
      configPath: detected?.configPath || syncSource.configPath || '',
      available: detected?.available || false,
      status: detected?.status || syncSource.status,
      error: detected?.error || syncSource.lastError,
      servers: detected?.servers || [],
      syncMode: syncSource.syncMode,
      linkedMcps: detected?.linkedMcps || (config.servers || []).filter((server) => server.syncSourceKey === syncSource.sourceKey).length,
      detectedSource: detected,
    }
  })

  const configuredKeys = new Set(configuredTargets.map((target) => target.sourceKey))
  const addableSources = sources.filter((source) => !configuredKeys.has(source.sourceKey))
  const selectedSource = addableSources.find((source) => source.sourceKey === selectedSourceKey) || null
  const importedKeys = new Set(
    (config.servers || [])
      .filter((server) => server.syncSourceKey)
      .map((server) => `${server.syncSourceKey}::${server.name}`),
  )

  function toggleExpanded(sourceKey: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(sourceKey)) {
        next.delete(sourceKey)
      } else {
        next.add(sourceKey)
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

  async function handleAddTarget() {
    if (!selectedSource) {
      return
    }
    setMessage('')
    try {
      await onAddSyncSource(selectedSource, selectedMode)
      setExpanded((current) => new Set(current).add(selectedSource.sourceKey))
      setSelectedSourceKey('')
      setSelectedMode('observe')
      setOpen(false)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleImportServer(server: ImportServer) {
    setMessage('')
    try {
      await onImportServer(server)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleRemoveTarget(sourceKey: string) {
    setMessage('')
    try {
      await onRemoveSyncSource(sourceKey)
      setExpanded((current) => {
        const next = new Set(current)
        next.delete(sourceKey)
        return next
      })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <section className="flex flex-col gap-4">
        <div>
          <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">Sync</h1>
          <div className="mt-3 text-sm text-muted-foreground">Add a target first, then choose which MCP to bring in.</div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div />
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleDetect} disabled={loading}>
              <RefreshCw data-icon="inline-start" />
              {loading ? 'Scanning...' : 'Rescan'}
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus data-icon="inline-start" />
              Add
            </Button>
          </div>
        </div>

        {message ? (
          <div className="rounded-2xl border border-border/60 bg-background/25 px-4 py-3 text-sm text-foreground">
            {message}
          </div>
        ) : null}

        {configuredTargets.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            No sync target added yet.
          </div>
        ) : (
          <div className="flex flex-col">
            {configuredTargets.map((target, index) => {
              const isExpanded = expanded.has(target.sourceKey)

              return (
                <div key={target.sourceKey}>
                  {index > 0 ? <Separator className="my-4" /> : null}
                  <div className="flex items-start justify-between gap-4">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      onClick={() => toggleExpanded(target.sourceKey)}
                    >
                      <ChevronDown className={cn('mt-0.5 size-4 shrink-0 transition-transform', isExpanded && 'rotate-180')} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium">{target.name}</div>
                          <Badge variant="secondary">{target.syncMode}</Badge>
                          <Badge variant={target.available ? 'success' : target.error ? 'destructive' : 'secondary'}>
                            {target.available ? 'Ready' : target.error ? 'Missing' : 'Idle'}
                          </Badge>
                        </div>
                        {target.configPath ? (
                          <div className="mt-2 break-all text-xs text-muted-foreground">{target.configPath}</div>
                        ) : null}
                      </div>
                    </button>

                    <Button variant="ghost" onClick={() => void handleRemoveTarget(target.sourceKey)}>
                      <Trash2 data-icon="inline-start" />
                      Remove
                    </Button>
                  </div>

                  {isExpanded ? (
                    <div className="ml-7 mt-4 flex flex-col gap-4">
                      <div className="flex flex-wrap gap-2">
                        {syncModes.map((mode) => (
                          <Button
                            key={mode.value}
                            size="sm"
                            variant={target.syncMode === mode.value ? 'default' : 'outline'}
                            onClick={() => {
                              if (target.detectedSource) {
                                void onSetSyncSourceMode(target.detectedSource, mode.value)
                              }
                            }}
                            disabled={!target.detectedSource}
                          >
                            {mode.label}
                          </Button>
                        ))}
                      </div>

                      {!target.available ? (
                        <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                          {target.error || 'This target is not available right now.'}
                        </div>
                      ) : target.servers.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-sm text-muted-foreground">
                          No MCP detected from this target.
                        </div>
                      ) : (
                        <div className="flex flex-col">
                          {target.servers.map((server, serverIndex) => {
                            const imported = importedKeys.has(`${target.sourceKey}::${server.name}`)
                            return (
                              <div key={`${target.sourceKey}::${server.name}`}>
                                {serverIndex > 0 ? <Separator className="my-3" /> : null}
                                <div className="flex items-start justify-between gap-4">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="font-medium">{server.name}</div>
                                      <Badge variant="secondary">{server.transport}</Badge>
                                    </div>
                                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                                      {server.transport === 'stdio'
                                        ? `${server.command || ''} ${(server.args || []).join(' ')}`
                                        : server.endpoint}
                                    </div>
                                  </div>
                                  <Button
                                    variant={imported ? 'secondary' : 'outline'}
                                    disabled={imported}
                                    onClick={() => void handleImportServer(server)}
                                  >
                                    {imported ? 'Added' : 'Add'}
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Sync Target</DialogTitle>
            <DialogDescription>Choose one target and one mode.</DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex flex-col gap-5">
            {addableSources.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                No new target found.
              </div>
            ) : (
              <>
                <div className="flex flex-col rounded-2xl border border-border/70">
                  {addableSources.map((source) => (
                    <button
                      key={source.sourceKey}
                      type="button"
                      className={cn(
                        'flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-background/50',
                        selectedSourceKey === source.sourceKey && 'bg-primary/10',
                      )}
                      onClick={() => setSelectedSourceKey(source.sourceKey)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{source.name}</div>
                        <div className="mt-1 break-all text-xs text-muted-foreground">{source.configPath}</div>
                      </div>
                      <Badge variant={source.available ? 'success' : source.error ? 'destructive' : 'secondary'}>
                        {source.available ? 'Ready' : source.error ? 'Missing' : 'Idle'}
                      </Badge>
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2">
                  {syncModes.map((mode) => (
                    <Button
                      key={mode.value}
                      variant={selectedMode === mode.value ? 'default' : 'outline'}
                      onClick={() => setSelectedMode(mode.value)}
                    >
                      {mode.label}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <X data-icon="inline-start" />
              Cancel
            </Button>
            <Button onClick={handleAddTarget} disabled={!selectedSource || !selectedSource.available}>
              <Plus data-icon="inline-start" />
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
