import { Fingerprint, KeyRound, Link2, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field'
import { Input } from '../components/ui/input'
import type { RelayConfig } from '../types'

interface PairingPanelProps {
  config: RelayConfig
  onClaimPairing: (serverBaseUrl: string, pairingCode: string, displayName: string) => Promise<string>
}

export function PairingPanel({ config, onClaimPairing }: PairingPanelProps) {
  const [serverBaseUrl, setServerBaseUrl] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setServerBaseUrl(config.relay?.serverBaseUrl || '')
    setDisplayName(config.relay?.displayName || '')
  }, [config.relay?.displayName, config.relay?.serverBaseUrl])

  async function handleSubmit() {
    if (!serverBaseUrl || !pairingCode) return
    setSubmitting(true)
    setMessage('')
    setError('')
    try {
      const result = await onClaimPairing(serverBaseUrl, pairingCode, displayName)
      setMessage(result)
      setPairingCode('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
      <Card>
        <CardHeader>
          <CardTitle>Bind This Client</CardTitle>
          <CardDescription>
            Pair first. After the device is trusted by the server, MCP server configuration and sync become available.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="server-base-url">Server Base URL</FieldLabel>
              <FieldContent>
                <Input
                  id="server-base-url"
                  value={serverBaseUrl}
                  onChange={(event) => setServerBaseUrl(event.target.value)}
                  placeholder="https://your-synapse-server"
                />
                <FieldDescription>
                  This should be the same origin as the Synapse Web console that created the pairing code.
                </FieldDescription>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="pairing-code">Pairing Code</FieldLabel>
              <FieldContent>
                <Input
                  id="pairing-code"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder="ABCD1234"
                />
                <FieldDescription>
                  Use the code from the Web dashboard or from the browser detection flow.
                </FieldDescription>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="display-name">Display Name</FieldLabel>
              <FieldContent>
                <Input
                  id="display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Auto: OS@hostname"
                />
                <FieldDescription>
                  Leave blank to use the local default device name, like <code className="rounded bg-muted px-1 py-0.5 text-xs">Windows@hostname</code> or <code className="rounded bg-muted px-1 py-0.5 text-xs">macOS@hostname</code>.
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={handleSubmit} disabled={submitting || !serverBaseUrl || !pairingCode}>
              <ShieldCheck data-icon="inline-start" />
              {submitting ? 'Pairing...' : 'Pair Device'}
            </Button>
          </div>

          {message ? (
            <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Identity</CardTitle>
          <CardDescription>
            Device identity is local. The relay authenticates to the server using the generated key pair.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border/60 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
              <KeyRound className="size-4" />
              Device ID
            </div>
            <div className="mt-2 break-all text-sm">{config.relay?.deviceId || 'Not paired yet'}</div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
              <Fingerprint className="size-4" />
              Public Key Fingerprint
            </div>
            <div className="mt-2 break-all font-mono text-xs">{config.relay?.publicKeyFingerprint || 'Generated on first pairing claim'}</div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
              <Link2 className="size-4" />
              Relay Endpoint
            </div>
            <div className="mt-2 break-all text-sm">{config.relay?.websocketUrl || 'Unavailable until paired'}</div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-background/25 p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-muted-foreground">
              <ShieldCheck className="size-4" />
              Pinned Server Key
            </div>
            <div className="mt-2 break-all font-mono text-xs">
              {config.relay?.serverTlsPublicKeyPin || 'Captured automatically on secure pairing claim'}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
