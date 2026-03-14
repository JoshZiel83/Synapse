import { Activity, Play, RefreshCw, Square, Unplug } from 'lucide-react'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { Separator } from '../components/ui/separator'
import type { LogEntry, RelayConfig, StatusInfo } from '../types'

function statusVariant(state: string) {
  switch (state) {
    case 'running':
      return 'success'
    case 'starting':
    case 'stopping':
      return 'warning'
    case 'error':
      return 'destructive'
    default:
      return 'secondary'
  }
}

function logTone(type: string) {
  if (type === 'error' || type === 'auth_failed') return 'text-destructive'
  if (type === 'connected' || type === 'servers_ready') return 'text-emerald-300'
  if (type === 'tool_call' || type === 'tool_result') return 'text-blue-300'
  return 'text-muted-foreground'
}

function authFailureHint(code?: string) {
  switch (code) {
    case 'server_identity_mismatch':
      return 'The stored server identity pin does not match the relay server. Re-pair this client only if you trust the new server certificate.'
    case 'server_identity_invalid':
      return 'The configured relay endpoint is insecure or missing a pinned server identity. Pair again against the correct HTTPS server.'
    case 'unknown_device':
      return 'This device is no longer registered on the server. Create a new pairing session and bind it again.'
    case 'device_revoked':
    case 'device_blocked':
      return 'This relay device has been revoked or blocked on the server. Re-authorize it in the Web console before reconnecting.'
    case 'public_key_fingerprint_mismatch':
    case 'invalid_auth_signature':
      return 'The local device key no longer matches the server record. Re-pair this client to generate a fresh trusted device binding.'
    default:
      return ''
  }
}

interface OverviewPanelProps {
  config: RelayConfig
  status: StatusInfo
  logs: LogEntry[]
  busy: 'starting' | 'stopping' | 'restarting' | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

export function OverviewPanel({
  config,
  status,
  logs,
  busy,
  onStart,
  onStop,
  onRestart,
}: OverviewPanelProps) {
  const paired = Boolean(config.relay?.deviceId)
  const serverCount = config.servers?.length || 0
  const runningServerCount = status.servers?.length || 0

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <CardHeader className="pb-0">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <Badge variant={statusVariant(status.state)}>
                <Activity data-icon="inline-start" />
                {status.state}
              </Badge>
              <div>
                <CardTitle>Relay Runtime</CardTitle>
                <CardDescription>
                  Start the relay only after the device is paired and local MCP servers are configured.
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(status.state === 'stopped' || status.state === 'error') ? (
                <Button onClick={onStart} disabled={busy === 'starting' || !paired}>
                  <Play data-icon="inline-start" />
                  {busy === 'starting' ? 'Starting...' : 'Start Relay'}
                </Button>
              ) : null}
              {status.state === 'running' ? (
                <>
                  <Button variant="outline" onClick={onRestart} disabled={busy === 'restarting'}>
                    <RefreshCw data-icon="inline-start" />
                    {busy === 'restarting' ? 'Restarting...' : 'Restart'}
                  </Button>
                  <Button variant="destructive" onClick={onStop} disabled={busy === 'stopping'}>
                    <Square data-icon="inline-start" />
                    {busy === 'stopping' ? 'Stopping...' : 'Stop'}
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4">
              <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Device</div>
              <div className="mt-2 text-lg font-medium">{config.relay?.displayName || 'Unpaired client'}</div>
              <div className="mt-1 text-sm text-muted-foreground">{config.relay?.deviceId || 'Pairing required'}</div>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4">
              <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Configured MCPs</div>
              <div className="mt-2 text-3xl font-medium">{serverCount}</div>
              <div className="mt-1 text-sm text-muted-foreground">{runningServerCount} currently active in runtime</div>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/30 p-4">
              <div className="text-xs uppercase tracking-[0.24em] text-muted-foreground">Connection</div>
              <div className="mt-2 text-lg font-medium">{config.relay?.serverBaseUrl || 'No server selected'}</div>
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <Unplug className="size-4" />
                {paired ? 'Paired and ready for websocket auth' : 'Waiting for pairing'}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {config.relay?.serverTlsPublicKeyPin ? 'Server identity pinned' : 'No server identity pin stored yet'}
              </div>
            </div>
          </div>
          {status.error ? (
            <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {status.error}
            </div>
          ) : null}
          {status.authFailureMessage ? (
            <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              <div className="font-medium">
                Authentication failed{status.authFailurePermanent ? ' permanently' : ''}
              </div>
              <div className="mt-1">{status.authFailureMessage}</div>
              {authFailureHint(status.authFailureCode) ? (
                <div className="mt-2 text-xs text-amber-700/90 dark:text-amber-200/80">
                  {authFailureHint(status.authFailureCode)}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1.8fr]">
        <Card>
          <CardHeader>
            <CardTitle>Runtime Exposures</CardTitle>
            <CardDescription>
              MCP servers that are currently registered into the relay session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(status.servers?.length || 0) === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                No runtime exposures yet. Pair the device, add MCP servers, then start the relay.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {status.servers?.map((server) => (
                  <div key={server.stableKey || server.name} className="rounded-2xl border border-border/60 bg-background/25 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-medium">{server.name}</div>
                        <div className="text-sm text-muted-foreground">{server.transport}</div>
                      </div>
                      <Badge variant="secondary">{server.tools?.length || 0} tools</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-h-[24rem]">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Diagnostics Log</CardTitle>
                <CardDescription>Recent runtime and pairing events from the desktop client.</CardDescription>
              </div>
              <Badge variant="secondary">{logs.length} entries</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col">
            {logs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                No logs yet.
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border/60 bg-black/20 px-3 py-3 font-mono text-xs">
                <div className="flex flex-col gap-1">
                  {logs.map((log, index) => (
                    <div key={`${log.time}-${index}`} className="flex gap-3 rounded-xl px-2 py-1.5 hover:bg-background/30">
                      <span className="shrink-0 text-muted-foreground">{log.time}</span>
                      <span className={`shrink-0 w-24 text-right ${logTone(log.type)}`}>[{log.type}]</span>
                      <span className="min-w-0 flex-1 break-all text-foreground/90">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Separator />
    </div>
  )
}
