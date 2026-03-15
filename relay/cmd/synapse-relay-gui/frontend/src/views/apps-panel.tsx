import { Cable, ChevronDown, FolderTree, Globe, Plus, Search, Shield, SlidersHorizontal, Trash2 } from 'lucide-react'
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
import type {
  BuiltinChromeConfig,
  BuiltinCUAConfig,
  BuiltinFilesystemConfig,
  BuiltinFilesystemRootConfig,
  RelayConfig,
  ServerConfig,
} from '../types'
import { cn } from '../lib/utils'

interface AppsPanelProps {
  config: RelayConfig
  onSave: (nextConfig: RelayConfig) => Promise<void>
}

const defaultFilesystemFileTypes = [
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.tsv', '.xml', '.html', '.htm', '.go', '.js', '.jsx', '.ts',
  '.tsx', '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.rs', '.sh',
  '.sql', '.css', '.scss', '.less', '.vue', '.svelte', '.php', '.rb',
  '.swift', '.kt', '.kts', '.scala', '.dart', '.lua', '.r', '.pl', '.proto',
  'Dockerfile', 'Makefile', '.pdf', '.xlsx', '.xlsm', '.xltx', '.xltm',
  '.xls', '.doc', '.ppt', '.docx', '.pptx', '.odt', '.ods', '.odp',
]

function parseCommaSeparatedList(input: string): string[] {
  return input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

function defaultChromeServer(): ServerConfig {
  return {
    name: 'chrome-browser',
    enabled: false,
    transport: 'builtin',
    managementMode: 'builtin',
    builtin: {
      kind: 'chrome',
      instanceId: 'chrome_default',
      chrome: {
        connectionMode: 'managed',
        channel: 'stable',
        executablePath: '',
        userDataDir: '',
        browserUrl: '',
        wsEndpoint: '',
        wsHeaders: {},
        headless: false,
        isolated: false,
        acceptInsecureCerts: false,
        logFile: '',
        chromeArgs: [],
        ignoreDefaultChromeArgs: [],
        slim: true,
        usageStatistics: false,
        performanceCrux: false,
      },
    },
    metadata: {
      category: 'browser',
    },
  }
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

function defaultFilesystemServer(): ServerConfig {
  return {
    name: 'filesystem',
    enabled: false,
    transport: 'builtin',
    managementMode: 'builtin',
    builtin: {
      kind: 'filesystem',
      instanceId: 'filesystem_default',
      filesystem: {
        readOnly: false,
        scope: 'roots',
        globalAccess: 'ro',
        roots: [
          {
            path: '',
            access: 'ro',
          },
        ],
        index: {
          contentEnabled: false,
          fileTypes: defaultFilesystemFileTypes,
          maxFileSizeBytes: 8 * 1024 * 1024,
          parsePdf: true,
          parseOffice: true,
        },
      },
    },
    metadata: {
      category: 'filesystem',
    },
  }
}

function chromeServerFromConfig(config: RelayConfig): ServerConfig | undefined {
  return (config.servers || []).find((server) => server.transport === 'builtin' && server.builtin?.kind === 'chrome')
}

function cuaServerFromConfig(config: RelayConfig): ServerConfig | undefined {
  return (config.servers || []).find((server) => server.transport === 'builtin' && server.builtin?.kind === 'cua')
}

function filesystemServerFromConfig(config: RelayConfig): ServerConfig | undefined {
  return (config.servers || []).find((server) => server.transport === 'builtin' && server.builtin?.kind === 'filesystem')
}

function normalizeChromeServer(input?: ServerConfig): ServerConfig {
  const defaults = defaultChromeServer()
  const current = input || defaults
  const defaultChrome = defaults.builtin?.chrome || {}
  const currentChrome = current.builtin?.chrome || {}

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
      kind: 'chrome',
      instanceId: current.builtin?.instanceId || defaults.builtin?.instanceId || 'chrome_default',
      chrome: {
        ...defaultChrome,
        ...currentChrome,
        wsHeaders: {
          ...(defaultChrome.wsHeaders || {}),
          ...(currentChrome.wsHeaders || {}),
        },
        chromeArgs: [...(currentChrome.chromeArgs || defaultChrome.chromeArgs || [])],
        ignoreDefaultChromeArgs: [...(currentChrome.ignoreDefaultChromeArgs || defaultChrome.ignoreDefaultChromeArgs || [])],
      },
    },
  }
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

function normalizeFilesystemServer(input?: ServerConfig): ServerConfig {
  const defaults = defaultFilesystemServer()
  const current = input || defaults
  const defaultFilesystem = defaults.builtin?.filesystem || {}
  const defaultIndex = defaultFilesystem.index || {}
  const currentFilesystem = current.builtin?.filesystem || {}
  const currentIndex = currentFilesystem.index || {}

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
      kind: 'filesystem',
      instanceId: current.builtin?.instanceId || defaults.builtin?.instanceId || 'filesystem_default',
      filesystem: {
        ...defaultFilesystem,
        ...currentFilesystem,
        roots: (currentFilesystem.roots && currentFilesystem.roots.length > 0 ? currentFilesystem.roots : defaultFilesystem.roots || []).map((root) => ({
          path: root.path || '',
          access: root.access || 'ro',
        })),
        index: {
          ...defaultIndex,
          ...currentIndex,
          fileTypes: currentIndex.fileTypes && currentIndex.fileTypes.length > 0 ? currentIndex.fileTypes : defaultIndex.fileTypes || defaultFilesystemFileTypes,
        },
      },
    },
  }
}

function withChromeConfig(server: ServerConfig, update: (current: BuiltinChromeConfig) => BuiltinChromeConfig): ServerConfig {
  const next = normalizeChromeServer(server)
  return {
    ...next,
    builtin: {
      kind: 'chrome',
      instanceId: next.builtin?.instanceId || 'chrome_default',
      chrome: update({
        ...(next.builtin?.chrome || {}),
        wsHeaders: {
          ...(next.builtin?.chrome?.wsHeaders || {}),
        },
        chromeArgs: [...(next.builtin?.chrome?.chromeArgs || [])],
        ignoreDefaultChromeArgs: [...(next.builtin?.chrome?.ignoreDefaultChromeArgs || [])],
      }),
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

function withFilesystemConfig(server: ServerConfig, update: (current: BuiltinFilesystemConfig) => BuiltinFilesystemConfig): ServerConfig {
  const next = normalizeFilesystemServer(server)
  return {
    ...next,
    builtin: {
      kind: 'filesystem',
      instanceId: next.builtin?.instanceId || 'filesystem_default',
      filesystem: update({
        ...(next.builtin?.filesystem || {}),
        roots: (next.builtin?.filesystem?.roots || []).map((root) => ({ ...root })),
        index: {
          ...(next.builtin?.filesystem?.index || {}),
          fileTypes: [...(next.builtin?.filesystem?.index?.fileTypes || [])],
        },
      }),
    },
  }
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[color:var(--primary)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </Field>
  )
}

function ScopeButton({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button type="button" size="sm" variant={active ? 'default' : 'outline'} onClick={onClick}>
      {label}
    </Button>
  )
}

export function AppsPanel({ config, onSave }: AppsPanelProps) {
  const [chromeDraft, setChromeDraft] = useState<ServerConfig>(() => normalizeChromeServer(chromeServerFromConfig(config)))
  const [cuaDraft, setCuaDraft] = useState<ServerConfig>(() => normalizeCUAServer(cuaServerFromConfig(config)))
  const [filesystemDraft, setFilesystemDraft] = useState<ServerConfig>(() => normalizeFilesystemServer(filesystemServerFromConfig(config)))
  const [expanded, setExpanded] = useState<{ chrome: boolean; cua: boolean; filesystem: boolean }>({ chrome: false, cua: false, filesystem: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const chrome = chromeDraft.builtin?.chrome || defaultChromeServer().builtin?.chrome || {}
  const cua = cuaDraft.builtin?.cua || defaultCUAServer().builtin?.cua || {}
  const filesystem = filesystemDraft.builtin?.filesystem || defaultFilesystemServer().builtin?.filesystem || {}
  const filesystemIndex = filesystem.index || defaultFilesystemServer().builtin?.filesystem?.index || {}

  useEffect(() => {
    setChromeDraft(normalizeChromeServer(chromeServerFromConfig(config)))
    setCuaDraft(normalizeCUAServer(cuaServerFromConfig(config)))
    setFilesystemDraft(normalizeFilesystemServer(filesystemServerFromConfig(config)))
  }, [config])

  useEffect(() => {
    setExpanded((current) => ({
      chrome: chromeDraft.enabled !== false ? current.chrome : false,
      cua: cuaDraft.enabled !== false ? current.cua : false,
      filesystem: filesystemDraft.enabled !== false ? current.filesystem : false,
    }))
  }, [chromeDraft.enabled, cuaDraft.enabled, filesystemDraft.enabled])

  function updateChromeDraft(update: (current: ServerConfig) => ServerConfig) {
    setChromeDraft((current) => normalizeChromeServer(update(current)))
  }

  function updateCUADraft(update: (current: ServerConfig) => ServerConfig) {
    setCuaDraft((current) => normalizeCUAServer(update(current)))
  }

  function updateFilesystemDraft(update: (current: ServerConfig) => ServerConfig) {
    setFilesystemDraft((current) => normalizeFilesystemServer(update(current)))
  }

  async function handleSave() {
    const nextServers = (config.servers || []).filter((server) => !(server.transport === 'builtin' && (server.builtin?.kind === 'chrome' || server.builtin?.kind === 'cua' || server.builtin?.kind === 'filesystem')))
    nextServers.push(normalizeChromeServer(chromeDraft))
    nextServers.push(normalizeCUAServer(cuaDraft))
    nextServers.push(normalizeFilesystemServer(filesystemDraft))

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

  function updateFilesystemRoot(index: number, update: (current: BuiltinFilesystemRootConfig) => BuiltinFilesystemRootConfig) {
    updateFilesystemDraft((current) =>
      withFilesystemConfig(current, (currentFilesystem) => {
        const roots = [...(currentFilesystem.roots || [])]
        roots[index] = update(roots[index] || { path: '', access: 'ro' })
        return {
          ...currentFilesystem,
          roots,
        }
      }),
    )
  }

  function addFilesystemRoot() {
    updateFilesystemDraft((current) =>
      withFilesystemConfig(current, (currentFilesystem) => ({
        ...currentFilesystem,
        roots: [...(currentFilesystem.roots || []), { path: '', access: 'ro' }],
      })),
    )
  }

  function removeFilesystemRoot(index: number) {
    updateFilesystemDraft((current) =>
      withFilesystemConfig(current, (currentFilesystem) => {
        const roots = [...(currentFilesystem.roots || [])]
        roots.splice(index, 1)
        return {
          ...currentFilesystem,
          roots: roots.length > 0 ? roots : [{ path: '', access: 'ro' }],
        }
      }),
    )
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-none font-semibold tracking-tight text-foreground">Apps</h1>
          <div className="mt-3 text-sm text-muted-foreground">Built-in MCPs run inside relay. Enable them selectively and save once when you are done.</div>
        </div>
        <Button onClick={() => void handleSave()} disabled={saving}>
          <Cable data-icon="inline-start" />
          {saving ? 'Saving...' : 'Save Built-ins'}
        </Button>
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
              <div className="font-medium">Chrome Browser</div>
              <Badge variant="secondary">builtin</Badge>
              <Badge variant={chromeDraft.enabled !== false ? 'success' : 'secondary'}>{chromeDraft.enabled !== false ? 'enabled' : 'disabled'}</Badge>
              <Badge variant="secondary">{chrome.connectionMode || 'managed'}</Badge>
              {chrome.slim !== false ? <Badge variant="secondary">slim tools</Badge> : null}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Launches or attaches to Chrome and exposes the official Chrome DevTools MCP server. Managed mode opens a dedicated browser for AI tasks and keeps a persistent profile unless you opt into isolated sessions.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Enable</span>
              <input
                type="checkbox"
                className="size-4 accent-[color:var(--primary)]"
                checked={chromeDraft.enabled !== false}
                onChange={(event) =>
                  updateChromeDraft((current) => ({
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
              disabled={chromeDraft.enabled === false}
              onClick={() => setExpanded((current) => ({ ...current, chrome: !current.chrome }))}
            >
              <ChevronDown className={cn('transition-transform', expanded.chrome && 'rotate-180')} />
              Options
            </Button>
          </div>
        </div>

        {chromeDraft.enabled !== false && expanded.chrome ? (
          <div className="mt-5 border-t border-border/70 pt-5">
            <FieldGroup>
              <SettingToggle
                label="Slim Tool Catalog"
                description="Expose the smaller official tool set first. This keeps the browser app simpler and more predictable for general use."
                checked={chrome.slim !== false}
                onChange={(checked) =>
                  updateChromeDraft((current) =>
                    withChromeConfig(current, (currentChrome) => ({
                      ...currentChrome,
                      slim: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Accept Insecure Certificates"
                description="Allow pages with self-signed or otherwise invalid TLS certificates."
                checked={Boolean(chrome.acceptInsecureCerts)}
                onChange={(checked) =>
                  updateChromeDraft((current) =>
                    withChromeConfig(current, (currentChrome) => ({
                      ...currentChrome,
                      acceptInsecureCerts: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Usage Statistics"
                description="Enable upstream Chrome DevTools MCP usage statistics. Leave this off to preserve the current private default."
                checked={Boolean(chrome.usageStatistics)}
                onChange={(checked) =>
                  updateChromeDraft((current) =>
                    withChromeConfig(current, (currentChrome) => ({
                      ...currentChrome,
                      usageStatistics: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Performance CrUX Service"
                description="Allow Chrome DevTools MCP to call the CrUX performance service when upstream features require it."
                checked={Boolean(chrome.performanceCrux)}
                onChange={(checked) =>
                  updateChromeDraft((current) =>
                    withChromeConfig(current, (currentChrome) => ({
                      ...currentChrome,
                      performanceCrux: checked,
                    })),
                  )
                }
              />
              {chrome.connectionMode === 'managed' ? (
                <>
                  <Separator />
                  <SettingToggle
                    label="Headless Browser"
                    description="Run the dedicated managed Chrome without a visible window."
                    checked={Boolean(chrome.headless)}
                    onChange={(checked) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          headless: checked,
                        })),
                      )
                    }
                  />
                  <Separator />
                  <SettingToggle
                    label="Isolated Session"
                    description="Use a temporary profile instead of the persistent AI browser profile. When enabled, user data dir is ignored."
                    checked={Boolean(chrome.isolated)}
                    onChange={(checked) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          isolated: checked,
                        })),
                      )
                    }
                  />
                </>
              ) : null}
            </FieldGroup>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="builtin-chrome-name">Server Name</FieldLabel>
                <FieldContent>
                  <Input id="builtin-chrome-name" value={chromeDraft.name} onChange={(event) => updateChromeDraft((current) => ({ ...current, name: event.target.value }))} />
                  <FieldDescription>Shown in the relay tool catalog and cloud exposure list.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-chrome-instance-id">Instance ID</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-chrome-instance-id"
                    value={chromeDraft.builtin?.instanceId || ''}
                    onChange={(event) =>
                      updateChromeDraft((current) => ({
                        ...current,
                        builtin: {
                          kind: 'chrome',
                          instanceId: event.target.value,
                          chrome: current.builtin?.chrome || defaultChromeServer().builtin?.chrome,
                        },
                      }))
                    }
                  />
                  <FieldDescription>Used to keep the dedicated browser profile and app identity stable across restarts.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-chrome-mode">Connection Mode</FieldLabel>
                <FieldContent>
                  <select
                    id="builtin-chrome-mode"
                    className="h-11 rounded-2xl border border-border/70 bg-background px-3 text-sm"
                    value={chrome.connectionMode || 'managed'}
                    onChange={(event) =>
                      {
                        const connectionMode = event.target.value as 'managed' | 'attach_existing' | 'attach_url'
                        updateChromeDraft((current) =>
                          withChromeConfig(current, (currentChrome) => ({
                            ...currentChrome,
                            connectionMode,
                            browserUrl: connectionMode === 'attach_url' ? currentChrome.browserUrl : '',
                            wsEndpoint: connectionMode === 'attach_url' ? currentChrome.wsEndpoint : '',
                            wsHeaders: connectionMode === 'attach_url' ? currentChrome.wsHeaders : {},
                          })),
                        )
                      }
                    }
                  >
                    <option value="managed">Managed dedicated Chrome</option>
                    <option value="attach_existing">Attach existing Chrome</option>
                    <option value="attach_url">Manual DevTools endpoint</option>
                  </select>
                  <FieldDescription>Managed is the default one-click mode. The other modes are for advanced users who already control Chrome remote debugging.</FieldDescription>
                </FieldContent>
              </Field>

              {chrome.connectionMode !== 'attach_url' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-chrome-channel">Chrome Channel</FieldLabel>
                  <FieldContent>
                    <select
                      id="builtin-chrome-channel"
                      className="h-11 rounded-2xl border border-border/70 bg-background px-3 text-sm"
                      value={chrome.channel || 'stable'}
                      onChange={(event) =>
                        updateChromeDraft((current) =>
                          withChromeConfig(current, (currentChrome) => ({
                            ...currentChrome,
                            channel: event.target.value as 'stable' | 'beta' | 'dev' | 'canary',
                          })),
                        )
                      }
                    >
                      <option value="stable">Stable</option>
                      <option value="beta">Beta</option>
                      <option value="dev">Dev</option>
                      <option value="canary">Canary</option>
                    </select>
                  </FieldContent>
                </Field>
              ) : null}

              {chrome.connectionMode === 'managed' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-chrome-executable-path">Chrome Executable Path</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-chrome-executable-path"
                      value={chrome.executablePath || ''}
                      onChange={(event) =>
                        updateChromeDraft((current) =>
                          withChromeConfig(current, (currentChrome) => ({
                            ...currentChrome,
                            executablePath: event.target.value,
                          })),
                        )
                      }
                      placeholder="Optional override if auto-detection is not enough"
                    />
                  </FieldContent>
                </Field>
              ) : null}

              {chrome.connectionMode === 'attach_url' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-chrome-browser-url">Browser URL</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-chrome-browser-url"
                      value={chrome.browserUrl || ''}
                      onChange={(event) =>
                        updateChromeDraft((current) =>
                          withChromeConfig(current, (currentChrome) => ({
                            ...currentChrome,
                            browserUrl: event.target.value,
                          })),
                        )
                      }
                      placeholder="http://127.0.0.1:9222"
                    />
                    <FieldDescription>Use this when Chrome exposes the HTTP DevTools endpoint.</FieldDescription>
                  </FieldContent>
                </Field>
              ) : null}

              {chrome.connectionMode === 'attach_url' ? (
                <Field>
                  <FieldLabel htmlFor="builtin-chrome-ws-endpoint">WebSocket Endpoint</FieldLabel>
                  <FieldContent>
                    <Input
                      id="builtin-chrome-ws-endpoint"
                      value={chrome.wsEndpoint || ''}
                      onChange={(event) =>
                        updateChromeDraft((current) =>
                          withChromeConfig(current, (currentChrome) => ({
                            ...currentChrome,
                            wsEndpoint: event.target.value,
                          })),
                        )
                      }
                      placeholder="ws://127.0.0.1:9222/devtools/browser/..."
                    />
                    <FieldDescription>Use this instead of browser URL when you already have the raw DevTools WebSocket address.</FieldDescription>
                  </FieldContent>
                </Field>
              ) : null}

              <Field className={chrome.connectionMode === 'attach_url' ? 'md:col-span-2' : undefined}>
                <FieldLabel htmlFor="builtin-chrome-user-data-dir">User Data Dir</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-chrome-user-data-dir"
                    value={chrome.userDataDir || ''}
                    onChange={(event) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          userDataDir: event.target.value,
                        })),
                      )
                    }
                    placeholder={chrome.connectionMode === 'managed' ? 'Leave blank to use Relay-managed AI browser profile' : 'Optional profile hint for advanced connection modes'}
                  />
                  <FieldDescription>
                    {chrome.connectionMode === 'managed'
                      ? 'Leave this empty for the default persistent AI profile under the Relay data directory.'
                      : 'Optional advanced override. Leave blank unless you know which profile the target Chrome is using.'}
                  </FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-chrome-log-file">Log File</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-chrome-log-file"
                    value={chrome.logFile || ''}
                    onChange={(event) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          logFile: event.target.value,
                        })),
                      )
                    }
                    placeholder="Leave blank to use Relay-managed logs"
                  />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-chrome-args">Extra Chrome Args</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-chrome-args"
                    value={(chrome.chromeArgs || []).join(', ')}
                    onChange={(event) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          chromeArgs: parseCommaSeparatedList(event.target.value),
                        })),
                      )
                    }
                    placeholder="--window-size=1440,900, --lang=en-US"
                  />
                  <FieldDescription>Comma-separated flags appended to the Chrome launch command when applicable.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-chrome-ignore-default-args">Ignore Default Chrome Args</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-chrome-ignore-default-args"
                    value={(chrome.ignoreDefaultChromeArgs || []).join(', ')}
                    onChange={(event) =>
                      updateChromeDraft((current) =>
                        withChromeConfig(current, (currentChrome) => ({
                          ...currentChrome,
                          ignoreDefaultChromeArgs: parseCommaSeparatedList(event.target.value),
                        })),
                      )
                    }
                    placeholder="--disable-background-networking"
                  />
                </FieldContent>
              </Field>
            </div>

            <div className="mt-5 rounded-2xl border border-border/70 bg-background/35 px-4 py-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Globe className="size-4" />
                Default behavior
              </div>
              <div className="mt-2">
                Managed mode is designed for non-technical users: Relay starts a dedicated Chrome window on first use, stores the AI browsing state in its own profile, and does not require a separate Node or npm installation on the user machine.
              </div>
            </div>
          </div>
        ) : chromeDraft.enabled !== false ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            Expand to switch between managed and advanced attach modes, control the persistent profile, and pass through Chrome launch options.
          </div>
        ) : null}
      </section>

      <section className="rounded-[28px] border border-border/70 bg-background/55 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium">Computer Use Automation</div>
              <Badge variant="secondary">builtin</Badge>
              <Badge variant={cuaDraft.enabled !== false ? 'success' : 'secondary'}>{cuaDraft.enabled !== false ? 'enabled' : 'disabled'}</Badge>
              {cua.readOnly ? <Badge variant="warning">read-only</Badge> : null}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Screenshots, display selection, pointer state, keyboard state, windows, and desktop control tools.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Enable</span>
              <input
                type="checkbox"
                className="size-4 accent-[color:var(--primary)]"
                checked={cuaDraft.enabled !== false}
                onChange={(event) =>
                  updateCUADraft((current) => ({
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
              disabled={cuaDraft.enabled === false}
              onClick={() => setExpanded((current) => ({ ...current, cua: !current.cua }))}
            >
              <ChevronDown className={cn('transition-transform', expanded.cua && 'rotate-180')} />
              Options
            </Button>
          </div>
        </div>

        {cuaDraft.enabled !== false && expanded.cua ? (
          <div className="mt-5 border-t border-border/70 pt-5">
            <FieldGroup>
              <SettingToggle
                label="Read-Only Mode"
                description="Keep observation tools available but block pointer, keyboard, scrolling, drag, and typing actions until the user manually authorizes control in the client."
                checked={Boolean(cua.readOnly)}
                onChange={(checked) =>
                  updateCUADraft((current) =>
                    withCUAConfig(current, (currentCUA) => ({
                      ...currentCUA,
                      readOnly: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Relative Coordinate Mode"
                description="When on, CUA compatibility coordinates use the relative size instead of image size."
                checked={Boolean(cua.relativeCoordinate)}
                onChange={(checked) =>
                  updateCUADraft((current) =>
                    withCUAConfig(current, (currentCUA) => ({
                      ...currentCUA,
                      relativeCoordinate: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Allow Per-call Display Override"
                description="Lets tool calls target a different display than the server default."
                checked={cua.allowDisplayOverride !== false}
                onChange={(checked) =>
                  updateCUADraft((current) =>
                    withCUAConfig(current, (currentCUA) => ({
                      ...currentCUA,
                      allowDisplayOverride: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Expose Overview Tool"
                description="Add the multi-display overview screenshot tool to the catalog."
                checked={cua.includeOverviewTool !== false}
                onChange={(checked) =>
                  updateCUADraft((current) =>
                    withCUAConfig(current, (currentCUA) => ({
                      ...currentCUA,
                      includeOverviewTool: checked,
                    })),
                  )
                }
              />
            </FieldGroup>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="builtin-cua-name">Server Name</FieldLabel>
                <FieldContent>
                  <Input id="builtin-cua-name" value={cuaDraft.name} onChange={(event) => updateCUADraft((current) => ({ ...current, name: event.target.value }))} />
                  <FieldDescription>Shown in the relay catalog and cloud exposure list.</FieldDescription>
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-cua-instance-id">Instance ID</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-cua-instance-id"
                    value={cuaDraft.builtin?.instanceId || ''}
                    onChange={(event) =>
                      updateCUADraft((current) => ({
                        ...current,
                        builtin: {
                          kind: 'cua',
                          instanceId: event.target.value,
                          cua: current.builtin?.cua || defaultCUAServer().builtin?.cua,
                        },
                      }))
                    }
                  />
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
                      updateCUADraft((current) =>
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
                        updateCUADraft((current) =>
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
                        updateCUADraft((current) =>
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
                        updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
                      updateCUADraft((current) =>
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
        ) : cuaDraft.enabled !== false ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            Expand to edit display targeting, screenshot sizing, overview exposure, and control permissions.
          </div>
        ) : null}
      </section>

      <section className="rounded-[28px] border border-border/70 bg-background/55 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium">Filesystem</div>
              <Badge variant="secondary">builtin</Badge>
              <Badge variant={filesystemDraft.enabled !== false ? 'success' : 'secondary'}>{filesystemDraft.enabled !== false ? 'enabled' : 'disabled'}</Badge>
              {filesystem.readOnly ? <Badge variant="warning">read-only</Badge> : null}
              {filesystemIndex.contentEnabled ? <Badge variant="secondary">content index</Badge> : null}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              Local file read/write tools with per-root or global access control, system path blocking, and optional content indexing for text, PDF, modern Office, and legacy binary Office files.
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Enable</span>
              <input
                type="checkbox"
                className="size-4 accent-[color:var(--primary)]"
                checked={filesystemDraft.enabled !== false}
                onChange={(event) =>
                  updateFilesystemDraft((current) => ({
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
              disabled={filesystemDraft.enabled === false}
              onClick={() => setExpanded((current) => ({ ...current, filesystem: !current.filesystem }))}
            >
              <ChevronDown className={cn('transition-transform', expanded.filesystem && 'rotate-180')} />
              Options
            </Button>
          </div>
        </div>

        {filesystemDraft.enabled !== false && expanded.filesystem ? (
          <div className="mt-5 border-t border-border/70 pt-5">
            <FieldGroup>
              <SettingToggle
                label="Read-Only Mode"
                description="Keep read and search tools available but return a friendly user-approval error for any mutating call."
                checked={Boolean(filesystem.readOnly)}
                onChange={(checked) =>
                  updateFilesystemDraft((current) =>
                    withFilesystemConfig(current, (currentFilesystem) => ({
                      ...currentFilesystem,
                      readOnly: checked,
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Content Indexing"
                description="Extract and index searchable text from configured file types. Path search remains available even when this is off."
                checked={Boolean(filesystemIndex.contentEnabled)}
                onChange={(checked) =>
                  updateFilesystemDraft((current) =>
                    withFilesystemConfig(current, (currentFilesystem) => ({
                      ...currentFilesystem,
                      index: {
                        ...(currentFilesystem.index || {}),
                        contentEnabled: checked,
                      },
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="PDF Extraction"
                description="Use the bundled PDF parser when content indexing or read_text_file needs PDF text."
                checked={filesystemIndex.parsePdf !== false}
                onChange={(checked) =>
                  updateFilesystemDraft((current) =>
                    withFilesystemConfig(current, (currentFilesystem) => ({
                      ...currentFilesystem,
                      index: {
                        ...(currentFilesystem.index || {}),
                        parsePdf: checked,
                      },
                    })),
                  )
                }
              />
              <Separator />
              <SettingToggle
                label="Office Extraction"
                description="Enable spreadsheet, OOXML/ODF, and legacy .doc/.xls/.ppt extraction for indexing and read_text_file. Legacy binary files use pure Go where available, then LibreOffice/OLE fallbacks."
                checked={filesystemIndex.parseOffice !== false}
                onChange={(checked) =>
                  updateFilesystemDraft((current) =>
                    withFilesystemConfig(current, (currentFilesystem) => ({
                      ...currentFilesystem,
                      index: {
                        ...(currentFilesystem.index || {}),
                        parseOffice: checked,
                      },
                    })),
                  )
                }
              />
            </FieldGroup>

            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="builtin-filesystem-name">Server Name</FieldLabel>
                <FieldContent>
                  <Input id="builtin-filesystem-name" value={filesystemDraft.name} onChange={(event) => updateFilesystemDraft((current) => ({ ...current, name: event.target.value }))} />
                </FieldContent>
              </Field>

              <Field>
                <FieldLabel htmlFor="builtin-filesystem-instance-id">Instance ID</FieldLabel>
                <FieldContent>
                  <Input
                    id="builtin-filesystem-instance-id"
                    value={filesystemDraft.builtin?.instanceId || ''}
                    onChange={(event) =>
                      updateFilesystemDraft((current) => ({
                        ...current,
                        builtin: {
                          kind: 'filesystem',
                          instanceId: event.target.value,
                          filesystem: current.builtin?.filesystem || defaultFilesystemServer().builtin?.filesystem,
                        },
                      }))
                    }
                  />
                  <FieldDescription>Used for a stable built-in identity across restarts.</FieldDescription>
                </FieldContent>
              </Field>
            </div>

            <div className="mt-5 rounded-2xl border border-border/70 bg-background/35 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <FolderTree className="size-4" />
                Access Scope
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <ScopeButton
                  active={filesystem.scope === 'roots'}
                  label="Scoped Roots"
                  onClick={() =>
                    updateFilesystemDraft((current) =>
                      withFilesystemConfig(current, (currentFilesystem) => ({
                        ...currentFilesystem,
                        scope: 'roots',
                      })),
                    )
                  }
                />
                <ScopeButton
                  active={filesystem.scope === 'global'}
                  label="Global"
                  onClick={() =>
                    updateFilesystemDraft((current) =>
                      withFilesystemConfig(current, (currentFilesystem) => ({
                        ...currentFilesystem,
                        scope: 'global',
                      })),
                    )
                  }
                />
              </div>

              {filesystem.scope === 'global' ? (
                <div className="mt-4">
                  <div className="text-sm font-medium text-foreground">Global Access</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ScopeButton
                      active={filesystem.globalAccess === 'ro'}
                      label="Read Only"
                      onClick={() =>
                        updateFilesystemDraft((current) =>
                          withFilesystemConfig(current, (currentFilesystem) => ({
                            ...currentFilesystem,
                            globalAccess: 'ro',
                          })),
                        )
                      }
                    />
                    <ScopeButton
                      active={filesystem.globalAccess === 'rw'}
                      label="Read / Write"
                      onClick={() =>
                        updateFilesystemDraft((current) =>
                          withFilesystemConfig(current, (currentFilesystem) => ({
                            ...currentFilesystem,
                            globalAccess: 'rw',
                          })),
                        )
                      }
                    />
                  </div>
                  <div className="mt-3 text-sm text-muted-foreground">
                    Global mode still blocks system-managed paths. User-specified overrides do not bypass that protection.
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-foreground">Roots</div>
                    <Button type="button" size="sm" variant="outline" onClick={addFilesystemRoot}>
                      <Plus data-icon="inline-start" />
                      Add Root
                    </Button>
                  </div>

                  <div className="mt-4 flex flex-col gap-4">
                    {(filesystem.roots || []).map((root, index) => (
                      <div key={`filesystem-root-${index}`} className="rounded-2xl border border-border/70 bg-background/20 p-4">
                        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                          <Field>
                            <FieldLabel htmlFor={`filesystem-root-path-${index}`}>Path</FieldLabel>
                            <FieldContent>
                              <Input
                                id={`filesystem-root-path-${index}`}
                                value={root.path || ''}
                                onChange={(event) => updateFilesystemRoot(index, (currentRoot) => ({ ...currentRoot, path: event.target.value }))}
                                placeholder="/workspace or C:\\Users\\name\\Documents"
                              />
                            </FieldContent>
                          </Field>

                          <div className="flex flex-col gap-2">
                            <FieldLabel>Access</FieldLabel>
                            <div className="flex gap-2">
                              <ScopeButton active={root.access !== 'rw'} label="RO" onClick={() => updateFilesystemRoot(index, (currentRoot) => ({ ...currentRoot, access: 'ro' }))} />
                              <ScopeButton active={root.access === 'rw'} label="RW" onClick={() => updateFilesystemRoot(index, (currentRoot) => ({ ...currentRoot, access: 'rw' }))} />
                            </div>
                          </div>

                          <div className="flex items-end">
                            <Button type="button" size="sm" variant="ghost" onClick={() => removeFilesystemRoot(index)}>
                              <Trash2 data-icon="inline-start" />
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5 rounded-2xl border border-border/70 bg-background/35 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Search className="size-4" />
                Index Settings
              </div>
              <div className="mt-4 grid gap-5 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="filesystem-max-file-size">Max Indexed File Size (bytes)</FieldLabel>
                  <FieldContent>
                    <Input
                      id="filesystem-max-file-size"
                      type="number"
                      value={filesystemIndex.maxFileSizeBytes ?? 8 * 1024 * 1024}
                      onChange={(event) =>
                        updateFilesystemDraft((current) =>
                          withFilesystemConfig(current, (currentFilesystem) => ({
                            ...currentFilesystem,
                            index: {
                              ...(currentFilesystem.index || {}),
                              maxFileSizeBytes: Number(event.target.value || 0),
                            },
                          })),
                        )
                      }
                    />
                  </FieldContent>
                </Field>

                <Field>
                  <FieldLabel htmlFor="filesystem-file-types">Indexed File Types</FieldLabel>
                  <FieldContent>
                    <Input
                      id="filesystem-file-types"
                      value={(filesystemIndex.fileTypes || []).join(', ')}
                      onChange={(event) =>
                        updateFilesystemDraft((current) =>
                          withFilesystemConfig(current, (currentFilesystem) => ({
                            ...currentFilesystem,
                            index: {
                              ...(currentFilesystem.index || {}),
                              fileTypes: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
                            },
                          })),
                        )
                      }
                      placeholder=".go, .md, .pdf, .xlsx, Dockerfile"
                    />
                    <FieldDescription>Comma-separated extensions or exact basenames. Legacy .doc/.xls/.ppt are supported when Office extraction is enabled.</FieldDescription>
                  </FieldContent>
                </Field>
              </div>
            </div>

            <div className="mt-5 rounded-2xl border border-border/70 bg-background/35 px-4 py-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Shield className="size-4" />
                Safety model
              </div>
              <div className="mt-2">
                System-managed paths remain blocked even in global mode or when a user explicitly types them here. Read-only mode still exposes the full tool catalog, but mutating calls return a friendly MCP tool error that tells the model to ask the user for manual approval in the client.
              </div>
            </div>
          </div>
        ) : filesystemDraft.enabled !== false ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="size-4" />
            Expand to edit scope, roots, read-only mode, parsers, and content indexing.
          </div>
        ) : null}
      </section>
    </section>
  )
}
