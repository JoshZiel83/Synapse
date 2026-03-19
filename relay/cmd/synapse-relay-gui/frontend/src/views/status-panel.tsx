import { ArrowRight, Play, RefreshCw, Square } from 'lucide-react'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { getRelayUiStatus } from '../lib/relay-status'
import type { RelayConfig, StatusInfo } from '../types'

interface StatusPanelProps {
  config: RelayConfig
  status: StatusInfo
  busy: 'starting' | 'stopping' | 'restarting' | null
  onOpenPairing: () => void
  onOpenServers: () => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}

type GuideStep = {
  title: string
  detail: string
} & (
  | { state: 'done' }
  | { state: 'action'; actionLabel: string; onAction: () => void; disabled?: boolean }
  | { state: 'working'; workingLabel: string }
)

function statusNote(
  config: RelayConfig,
  status: StatusInfo,
  handlers: Pick<StatusPanelProps, 'onOpenPairing' | 'onOpenServers' | 'onStart'>,
): GuideStep[] {
  const canStart = Boolean(config.relay?.deviceId) && (config.servers?.length || 0) > 0

  const steps = [
    {
      title: 'Pair this device',
      detail: config.relay?.deviceId ? 'This device is already bound.' : 'Paste a pairing link in Pair.',
      ...(config.relay?.deviceId
        ? { state: 'done' as const }
        : { state: 'action' as const, actionLabel: 'Open Pair', onAction: handlers.onOpenPairing }),
    },
    {
      title: 'Add MCP',
      detail: (config.servers?.length || 0) > 0 ? 'At least one MCP is configured.' : 'Open MCP and add one server.',
      ...((config.servers?.length || 0) > 0
        ? { state: 'done' as const }
        : { state: 'action' as const, actionLabel: 'Open MCP', onAction: handlers.onOpenServers }),
    },
    {
      title: 'Start relay',
      detail: status.state === 'running' ? 'Relay is serving traffic now.' : 'Start when setup is ready.',
      ...(status.state === 'running'
        ? { state: 'done' as const }
        : status.state === 'starting'
          ? { state: 'working' as const, workingLabel: 'Starting' }
          : status.state === 'stopping'
            ? { state: 'working' as const, workingLabel: 'Stopping' }
            : {
                state: 'action' as const,
                actionLabel: 'Start Relay',
                onAction: handlers.onStart,
                disabled: !canStart,
              }),
    },
  ]

  return steps
}

export function StatusPanel({
  config,
  status,
  busy,
  onOpenPairing,
  onOpenServers,
  onStart,
  onStop,
  onRestart,
}: StatusPanelProps) {
  const uiStatus = getRelayUiStatus(config, status)
  const steps = statusNote(config, status, { onOpenPairing, onOpenServers, onStart })

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">Start</h1>
          <div className="mt-3 text-sm text-muted-foreground">{uiStatus.detail}</div>
        </div>
        <Badge variant={uiStatus.variant}>{uiStatus.label}</Badge>
      </div>

      <div className="grid items-start gap-8 xl:grid-cols-[1.15fr_0.85fr]">
      <section className="flex flex-col gap-5">
        <div>
          <div className="text-sm font-medium">Controls</div>
          <div className="mt-2 text-sm text-muted-foreground">Start, stop, or restart the relay here.</div>
        </div>
        <div className="flex flex-col gap-5">
          {status.error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {status.error}
            </div>
          ) : null}
          {!status.error && status.authFailureMessage ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {status.authFailureMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {(status.state === 'stopped' || status.state === 'error') ? (
              <Button onClick={onStart} disabled={busy === 'starting' || !config.relay?.deviceId || (config.servers?.length || 0) === 0}>
                <Play data-icon="inline-start" />
                {busy === 'starting' ? 'Starting...' : 'Start'}
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
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <div className="text-sm font-medium">Guide</div>
          <div className="mt-2 text-sm text-muted-foreground">Complete the next missing step.</div>
        </div>
        <div className="flex flex-col">
          {steps.map((step, index) => (
            <div key={step.title}>
              {index > 0 ? <Separator className="my-4" /> : null}
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{step.title}</div>
                {step.state === 'done' ? (
                  <Badge variant="success">Done</Badge>
                ) : null}
                {step.state === 'working' ? (
                  <Badge variant="warning">{step.workingLabel}</Badge>
                ) : null}
                {step.state === 'action' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={step.onAction}
                    disabled={step.disabled}
                  >
                    {step.actionLabel}
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                ) : null}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">{step.detail}</div>
            </div>
          ))}
        </div>
      </section>
      </div>
    </div>
  )
}
