import { Cable, Globe, Plus, Trash2, X } from 'lucide-react'
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Separator } from '../components/ui/separator'
import type { RelayConfig, ServerConfig } from '../types'

interface ServersPanelProps {
  config: RelayConfig
  onAddServer: (server: ServerConfig) => Promise<void>
  onRemoveServer: (name: string) => Promise<void>
}

export function ServersPanel({ config, onAddServer, onRemoveServer }: ServersPanelProps) {
  const [open, setOpen] = useState(false)
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const externalServers = (config.servers || []).filter((server) => server.transport !== 'builtin')

  async function handleAddServer() {
    const payload: ServerConfig = {
      name: name.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() : '',
      args: transport === 'stdio' ? args.split(' ').filter(Boolean) : [],
      env: {},
      endpoint: transport === 'http' ? endpoint.trim() : '',
    }

    setSubmitting(true)
    setError('')
    try {
      await onAddServer(payload)
      setName('')
      setCommand('')
      setArgs('')
      setEndpoint('')
      setTransport('stdio')
      setOpen(false)
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
    <>
      <section className="flex flex-col gap-5">
        <div>
          <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">MCP</h1>
          <div className="mt-3 text-sm text-muted-foreground">External MCP processes and HTTP endpoints. Built-in apps are managed from the Apps section.</div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-muted-foreground">Add stdio or HTTP MCP targets exposed by other processes.</div>
          <Button onClick={() => setOpen(true)}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>

        {externalServers.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
            No external MCP configured yet.
          </div>
        ) : (
          <div className="flex flex-col">
            {externalServers.map((server, index) => (
              <div key={server.stableKey || server.name}>
                {index > 0 ? <Separator className="my-4" /> : null}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium">{server.name}</div>
                      <Badge variant="secondary">{server.transport}</Badge>
                      {server.enabled === false ? <Badge>disabled</Badge> : null}
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {server.transport === 'stdio'
                        ? `${server.command || ''} ${(server.args || []).join(' ')}`
                        : server.endpoint}
                    </div>
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
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add MCP</DialogTitle>
            <DialogDescription>Fill one target at a time.</DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex flex-col gap-5">
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
                      <FieldDescription>Space-separated command arguments.</FieldDescription>
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
          </div>

          <DialogFooter className="mt-6">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              <X data-icon="inline-start" />
              Cancel
            </Button>
            <Button onClick={handleAddServer} disabled={submitting || !name || (transport === 'stdio' ? !command : !endpoint)}>
              <Plus data-icon="inline-start" />
              {submitting ? 'Adding...' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
