import { Cable, ChevronDown, Shield, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Separator } from '../components/ui/separator'
import type { BuiltinCUAConfig, RelayConfig, ServerConfig } from '../types'
import { cn } from '../lib/utils'

interface AppsPanelProps {
  config: RelayConfig
  onSave: (nextConfig: RelayConfig) => Promise<void>
}

function defaultCUAServer(): ServerConfig {
  return {
    name: 'computer-use',
    enabled: false,
    transport: 'builtin',
    managementMode: 'builtin',
    builtin: {
      kind: 'cua',
      instanceId: 'cua_default',
      cua: {
        readOnly: false,
        imageSize: [1280, 800],
        relativeCoordinate: false,
        relativeSize: [1000, 1000],
        scrollMultiplier: 1,
        allowDisplayOverride: true,
        includeOverviewTool: true,
        displaySelector: {
          mode: 'main',
        },
      },
    },
    metadata: {
      category: 'desktop',
    },
  }
}

function cuaServerFromConfig(config: RelayConfig): ServerConfig | undefined {
  return (config.servers || []).find((server) => server.transport === 'builtin' && server.builtin?.kind === 'cua')
}

function normalizeCUAServer(input?: ServerConfig): ServerConfig {
  const defaults = defaultCUAServer()
  const current = input || defaults
  const defaultCUA = defaults.builtin?.cua || {}

  return {
    ...defaults,
    ...current,
    transport: 'builtin',
    managementMode: 'builtin',
    enabled: current.enabled !== false,
    metadata: {
      ...(defaults.metadata || {}),
      ...(current.metadata || {}),
    },
    builtin: {
      kind: 'cua',
      instanceId: current.builtin?.instanceId || defaults.builtin?.instanceId || 'cua_default',
      cua: {
        ...defaultCUA,
        ...(current.builtin?.cua || {}),
        displaySelector: {
          ...(defaultCUA.displaySelector || {}),
          ...(current.builtin?.cua?.displaySelector || {}),
        },
      },
    },
  }
}

function withCUAConfig(server: ServerConfig, update: (current: BuiltinCUAConfig) => BuiltinCUAConfig): ServerConfig {
  const next = normalizeCUAServer(server)
  return {
    ...next,
    builtin: {
      kind: 'cua',
      instanceId: next.builtin?.instanceId || 'cua_default',
      cua: update({
        ...(next.builtin?.cua || {}),
        displaySelector: {
          ...(next.builtin?.cua?.displaySelector || {}),
        },
      }),
    },
  }
}

export function AppsPanel({ config, onSave }: AppsPanelProps) {
  const [draft, setDraft] = useState<ServerConfig>(() => normalizeCUAServer(cuaServerFromConfig(config)))
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const cuaServer = cuaServerFromConfig(config)
  const cua = draft.builtin?.cua || defaultCUAServer().builtin?.cua || {}
  const enabled = draft.enabled !== false

  useEffect(() => {
    setDraft(normalizeCUAServer(cuaServer))
  }, [cuaServer])

  useEffect(() => {
    if (!enabled) {
      setExpanded(false)
    }
  }, [enabled])

  function updateDraft(update: (current: ServerConfig) => ServerConfig) {
    setDraft((current) => normalizeCUAServer(update(current)))
  }

  async function handleSave() {
    const nextServers = [...(config.servers || [])]
    const nextBuiltin = normalizeCUAServer(draft)
    const existingIndex = nextServers.findIndex((server) => server.transport === 'builtin' && server.builtin?.kind === 'cua')

    if (existingIndex >= 0) {
      nextServers[existingIndex] = nextBuiltin
    } else {
      nextServers.push(nextBuiltin)
    }

    setSaving(true)
    setError('')
    try {
      await onSave({
        ...config,
        servers: nextServers,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">Apps</h1>
        <div className="mt-3 text-sm text-muted-foreground">Built-in MCPs run inside relay. Enable them selectively and expand a card for detailed settings.</div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <section className="rounded-[28px] border border-border/70 bg-background/55 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium">Computer Use Automation</div>
              <Badge variant="secondary">builtin</Badge>
              <Badge variant={enabled ? 'success' : 'secondary'}>{enabled ? 'enabled' : 'disabled'}</Badge>
              {cua.readOnly ? <Badge variant="warning">read-only</Badge> : null}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Screenshots, display selection, pointer state, keyboard state, windows, and desktop control tools.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              <Cable data-icon="inline-start" />
              {saving ? 'Saving...' : 'Save'}
            </Button>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Enable</span>
              <input
                type="checkbox"
                className="size-4 accent-[color:var(--primary)]"
                checked={enabled}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
              />
            </label>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!enabled}
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
              Options
            </Button>
          </div>
        </div>

        {enabled && expanded ? (
          <div className="mt-5 border-t border-border/70 pt-5">
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Read-Only Mode</FieldLabel>
                  <FieldDescription>
                    Keep observation tools available but block pointer, keyboard, scrolling, drag, and typing actions until the user manually authorizes control in the client.
                  </FieldDescription>
                </FieldContent>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[color:var(--primary)]"
                  checked={Boolean(cua.readOnly)}
                  onChange={(event) =>
                    updateDraft((current) =>
                      withCUAConfig(current, (currentCUA) => ({
                        ...currentCUA,
                        readOnly: event.target.checked,
                      })),
                    )
                  }
                />
              </Field>

              <Separator />

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Relative Coordinate Mode</FieldLabel>
                  <FieldDescription>When on, CUA compatibility coordinates use the relative size instead of image size.</FieldDescription>
                </FieldContent>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[color:var(--primary)]"
                  checked={Boolean(cua.relativeCoordinate)}
                  onChange={(event) =>
                    updateDraft((current) =>
                      withCUAConfig(current, (currentCUA) => ({
                        ...currentCUA,
                        relativeCoordinate: event.target.checked,
                      })),
                    )
                  }
                />
              </Field>

              <Separator />

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Allow Per-call Display Override</FieldLabel>
                  <FieldDescription>Lets tool calls target a different display than the server default.</FieldDescription>
                </FieldContent>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[color:var(--primary)]"
                  checked={cua.allowDisplayOverride !== false}
                  onChange={(event) =>
                    updateDraft((current) =>
                      withCUAConfig(current, (currentCUA) => ({
                        ...currentCUA,
                        allowDisplayOverride: event.target.checked,
                      })),
                    )
                  }
                />
              </Field>

              <Separator />

              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Expose Overview Tool</FieldLabel>
                  <FieldDescription>Add the multi-display overview screenshot tool to the catalog.</FieldDescription>
                </FieldContent>
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-[color:var(--primary)]"
                  checked={cua.includeOverviewTool !== false}
                  onChange={(event) =>
                    updateDraft((current) =>
                      withCUAConfig(current, (currentCUA) => ({
                        ...currentCUA,
                        includeOverviewTool: event.target.checked,
                      })),
                    )
                  }
                />
              </Field>
            </FieldGroup>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="builtin-name">Server Name</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-name"
                    value={draft.name}
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                  <FieldDescription>Shown in the relay catalog and cloud exposure list.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-instance-id">Instance ID</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-instance-id"
                    value={draft.builtin?.instanceId || ''}
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        builtin: {
                          kind: 'cua',
                          instanceId: event.target.value,
                          cua: current.builtin?.cua || defaultCUAServer().builtin?.cua,
                        },
                      }))
                    }
                  />
                  <FieldDescription>Used for a stable built-in identity across restarts.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-display-mode">Default Display Mode</FieldLabel>
                <FieldContent>
                  <select
                    id="builtin-display-mode"
                    className="h-11 rounded-2xl border border-border/70 bg-background px-3 text-sm"
                    value={cua.displaySelector?.mode || 'main'}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          displaySelector: {
                            ...(currentCUA.displaySelector || {}),
                            mode: event.target.value as 'main' | 'mouse' | 'index' | 'id' | 'electron_id',
                          },
                        })),
                      )
                    }
                  >
                    <option value="main">Main display</option>
                    <option value="mouse">Display with pointer</option>
                    <option value="index">Display index</option>
                    <option value="id">Display ID</option>
                    <option value="electron_id">Electron ID</option>
                  </select>
                </FieldContent>
              </Field>

              {cua.displaySelector?.mode === 'index' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-display-index">Display Index</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-display-index"
                      type="number"
                      value={cua.displaySelector?.index ?? 0}
                      onChange={(event) =>
                        updateDraft((current) =>
                          withCUAConfig(current, (currentCUA) => ({
                            ...currentCUA,
                            displaySelector: {
                              ...(currentCUA.displaySelector || {}),
                              index: Number(event.target.value || 0),
                            },
                          })),
                        )
                      }
                    />
                  </FieldContent>
                </Field>
              ) : null}

              {cua.displaySelector?.mode === 'id' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-display-id">Display ID</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-display-id"
                      type="number"
                      value={cua.displaySelector?.id ?? 0}
                      onChange={(event) =>
                        updateDraft((current) =>
                          withCUAConfig(current, (currentCUA) => ({
                            ...currentCUA,
                            displaySelector: {
                              ...(currentCUA.displaySelector || {}),
                              id: Number(event.target.value || 0),
                            },
                          })),
                        )
                      }
                    />
                  </FieldContent>
                </Field>
              ) : null}

              {cua.displaySelector?.mode === 'electron_id' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-display-electron-id">Electron ID</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-display-electron-id"
                      type="number"
                      value={cua.displaySelector?.electronId ?? 0}
                      onChange={(event) =>
                        updateDraft((current) =>
                          withCUAConfig(current, (currentCUA) => ({
                            ...currentCUA,
                            displaySelector: {
                              ...(currentCUA.displaySelector || {}),
                              electronId: Number(event.target.value || 0),
                            },
                          })),
                        )
                      }
                    />
                  </FieldContent>
                </Field>
              ) : null}
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="builtin-image-width">Image Width</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-image-width"
                    type="number"
                    value={cua.imageSize?.[0] ?? 1280}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          imageSize: [Number(event.target.value || 0), currentCUA.imageSize?.[1] ?? 800],
                        })),
                      )
                    }
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-image-height">Image Height</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-image-height"
                    type="number"
                    value={cua.imageSize?.[1] ?? 800}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          imageSize: [currentCUA.imageSize?.[0] ?? 1280, Number(event.target.value || 0)],
                        })),
                      )
                    }
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-scroll-multiplier">Scroll Multiplier</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-scroll-multiplier"
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={cua.scrollMultiplier ?? 1}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          scrollMultiplier: Number(event.target.value || 0),
                        })),
                      )
                    }
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-relative-width">Relative Width</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-relative-width"
                    type="number"
                    value={cua.relativeSize?.[0] ?? 1000}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          relativeSize: [Number(event.target.value || 0), currentCUA.relativeSize?.[1] ?? 1000],
                        })),
                      )
                    }
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-relative-height">Relative Height</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-relative-height"
                    type="number"
                    value={cua.relativeSize?.[1] ?? 1000}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          relativeSize: [currentCUA.relativeSize?.[0] ?? 1000, Number(event.target.value || 0)],
                        })),
                      )
                    }
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-log-dir">Log Directory</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-log-dir"
                    value={cua.logDir || ''}
                    onChange={(event) =>
                      updateDraft((current) =>
                        withCUAConfig(current, (currentCUA) => ({
                          ...currentCUA,
                          logDir: event.target.value,
                        })),
                      )
                    }
                    placeholder="Optional screenshot/action log directory"
                  />
                </FieldContent>
              </Field>
            </div>

            <div className="mt-5 rounded-2xl border border-border/70 bg-background/35 px-4 py-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Shield className="size-4" />
                Read-only behavior
              </div>
              <div className="mt-2">
                The tool catalog is always exposed. When read-only mode is enabled, non-observation tool calls return a friendly MCP tool error instructing the model to ask the user for manual approval in the client.
              </div>
            </div>
          </div>
        ) : enabled ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            Expand to edit display targeting, screenshot sizing, overview exposure, and control permissions.
          </div>
        ) : null}
      </section>
    </section>
  )
}
