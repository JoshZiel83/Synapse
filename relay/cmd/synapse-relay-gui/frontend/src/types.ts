export interface RelaySettings {
  serverBaseUrl?: string
  websocketUrl?: string
  deviceId?: string
  displayName?: string
  publicKeyFingerprint?: string
  serverTlsPublicKeyPin?: string
  privateKeyPath?: string
}

export interface StartupSettings {
  runAtLogin?: boolean
  autoConnect?: boolean
  launchHidden?: boolean
}

export interface NotificationSettings {
  backgroundEnabled?: boolean
}

export interface UpdateSettings {
  channel?: string
  lastCheckedAt?: string
  lastVersion?: string
  pendingVersion?: string
  pendingInstaller?: string
}

export interface BuiltinDisplaySelectorConfig {
  mode?: 'main' | 'mouse' | 'index' | 'id' | 'electron_id'
  index?: number
  id?: number
  electronId?: number
}

export interface BuiltinCUAConfig {
  readOnly?: boolean
  relativeCoordinate?: boolean
  imageSize?: [number, number]
  relativeSize?: [number, number]
  scrollMultiplier?: number
  logDir?: string
  allowDisplayOverride?: boolean
  includeOverviewTool?: boolean
  displaySelector?: BuiltinDisplaySelectorConfig
}

export interface BuiltinServerConfig {
  kind: 'cua'
  instanceId?: string
  cua?: BuiltinCUAConfig
}

export interface ServerConfig {
  stableKey?: string
  syncSourceKey?: string
  managementMode?: 'manual' | 'imported' | 'mirrored' | 'managed' | 'builtin'
  enabled?: boolean
  name: string
  transport: 'stdio' | 'http' | 'builtin'
  command?: string
  args?: string[]
  env?: Record<string, string>
  endpoint?: string
  builtin?: BuiltinServerConfig
  metadata?: Record<string, unknown>
}

export interface SyncSourceConfig {
  sourceKind: 'manual' | 'claude_code' | 'claude_desktop' | 'codex' | 'gemini' | 'opencode' | 'custom'
  sourceKey: string
  configPath?: string
  syncMode: 'import_only' | 'observe' | 'mirror' | 'managed' | 'detached'
  status: 'unknown' | 'idle' | 'syncing' | 'error' | 'disabled'
  lastSyncedAt?: string
  lastError?: string
  metadata?: Record<string, unknown>
}

export interface RelayConfig {
  relay?: RelaySettings
  startup?: StartupSettings
  notifications?: NotificationSettings
  update?: UpdateSettings
  logLevel?: string
  syncSources?: SyncSourceConfig[]
  servers?: ServerConfig[]
}

export interface StatusInfo {
  state: string
  error?: string
  authFailureCode?: string
  authFailureMessage?: string
  authFailurePermanent?: boolean
  servers?: Array<{
    stableKey?: string
    name: string
    transport: string
    tools?: Array<{
      stableKey?: string
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
    }>
  }>
}

export interface LogEntry {
  time: string
  type: string
  message: string
}

export interface ImportServer {
  sourceKind?: SyncSourceConfig['sourceKind']
  sourceKey?: string
  sourceConfigPath?: string
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  endpoint?: string
}

export interface ImportSource {
  kind: SyncSourceConfig['sourceKind']
  sourceKey: string
  name: string
  configPath: string
  available: boolean
  syncMode?: SyncSourceConfig['syncMode']
  status?: SyncSourceConfig['status']
  linkedMcps?: number
  servers: ImportServer[]
  error?: string
}

export interface ConfigChangeEvent {
  kind: 'changed' | 'deleted' | 'error'
  path?: string
  message?: string
  requiresRestart?: boolean
  autoApplied?: boolean
  config?: RelayConfig
}

export interface ConfigUpdatedEvent {
  message?: string
  autoApplied?: boolean
  config?: RelayConfig
}

export interface RelayEventPayload {
  type: string
  message: string
  time: string
  data?: Record<string, unknown>
}
