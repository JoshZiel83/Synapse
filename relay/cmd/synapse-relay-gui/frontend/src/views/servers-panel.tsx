import { Cable, Globe, Plus, Trash2 } from 'lucide-react'
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field'
import { Input } from '../components/ui/input'
import type { RelayConfig, ServerConfig } from '../types'

interface ServersPanelProps {
  config: RelayConfig
  onAddServer: (server: ServerConfig) => Promise<void>
  onRemoveServer: (name: string) => Promise<void>
}

export function ServersPanel({ config, onAddServer, onRemoveServer }: ServersPanelProps) {
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleAddServer() {
    const payload: ServerConfig = {
      name,
      transport,
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? args.split(' ').filter(Boolean) : [],
      env: {},
      endpoint: transport === 'http' ? endpoint : '',
    }

    setSubmitting(true)
    setError('')
    try {
      await onAddServer(payload)
      setName('')
      setCommand('')
      setArgs('')
      setEndpoint('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemoveServer(serverName: string) {
    try {
      await onRemoveServer(serverName)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.15fr]">
      <Card>
        <CardHeader>
          <CardTitle>Add MCP Server</CardTitle>
          <CardDescription>
            Relay runtime isolates MCP servers by stable exposure key, so each server should be declared explicitly.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-2">
            <Button variant={transport === 'stdio' ? 'default' : 'outline'} onClick={() => setTransport('stdio')}>
              <Cable data-icon="inline-start" />
              stdio
            </Button>
            <Button variant={transport === 'http' ? 'default' : 'outline'} onClick={() => setTransport('http')}>
              <Globe data-icon="inline-start" />
              http
            </Button>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="server-name">Name</FieldLabel>
              <FieldContent>
                <Input id="server-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" />
                <FieldDescription>Display name only. Runtime routing uses the stable key derived from this definition.</FieldDescription>
              </FieldContent>
            </Field>

            {transport === 'stdio' ? (
              <>
                <Field>
                  <FieldLabel htmlFor="server-command">Command</FieldLabel>
                  <FieldContent>
                    <Input id="server-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="server-args">Arguments</FieldLabel>
                  <FieldContent>
                    <Input
                      id="server-args"
                      value={args}
                      onChange={(event) => setArgs(event.target.value)}
                      placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
                    />
                    <FieldDescription>Windows starts stdio servers without an extra console window now.</FieldDescription>
                  </FieldContent>
                </Field>
              </>
            ) : (
              <Field>
                <FieldLabel htmlFor="server-endpoint">Endpoint</FieldLabel>
                <FieldContent>
                  <Input
                    id="server-endpoint"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="http://127.0.0.1:8080/mcp"
                  />
                </FieldContent>
              </Field>
            )}
          </FieldGroup>

          <div className="flex gap-3">
            <Button onClick={handleAddServer} disabled={submitting || !name || (transport === 'stdio' ? !command : !endpoint)}>
              <Plus data-icon="inline-start" />
              {submitting ? 'Adding...' : 'Add Server'}
            </Button>
          </div>

          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Configured Servers</CardTitle>
              <CardDescription>
                These definitions become exposures after the relay starts and the MCP handshake succeeds.
              </CardDescription>
            </div>
            <Badge variant="secondary">{config.servers?.length || 0} configured</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {(config.servers?.length || 0) === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
              No MCP servers configured yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {config.servers?.map((server) => (
                <div key={server.stableKey || server.name} className="rounded-2xl border border-border/60 bg-background/25 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium">{server.name}</div>
                        <Badge variant="secondary">{server.transport}</Badge>
                      </div>
                      <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                        {server.transport === 'stdio'
                          ? `${server.command || ''} ${(server.args || []).join(' ')}`
                          : server.endpoint}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{server.stableKey}</div>
                    </div>
                    <Button variant="ghost" onClick={() => void handleRemoveServer(server.name)}>
                      <Trash2 data-icon="inline-start" />
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
