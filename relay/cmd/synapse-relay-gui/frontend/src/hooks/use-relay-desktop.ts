import {
  startTransition,
  useEffect,
  useEffectEvent,
  useState,
} from 'react'

import { callGo } from '../lib/wails'
import type {
  ConfigChangeEvent,
  ConfigUpdatedEvent,
  ImportServer,
  ImportSource,
  LogEntry,
  RelayConfig,
  RelayEventPayload,
  ServerConfig,
  StatusInfo,
  SyncSourceConfig,
} from '../types'

declare const window: any

function normalizeConfig(cfg?: RelayConfig | null): RelayConfig {
  return {
    relay: cfg?.relay || {},
    logLevel: cfg?.logLevel || 'info',
    syncSources: cfg?.syncSources || [],
    servers: cfg?.servers || [],
  }
}

export function useRelayDesktop() {
  const [config, setConfig] = useState<RelayConfig>(() => normalizeConfig())
  const [status, setStatus] = useState<StatusInfo>({ state: 'stopped' })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [sources, setSources] = useState<ImportSource[]>([])
  const [banner, setBanner] = useState<string>('')

  const loadConfig = useEffectEvent(async () => {
    try {
      const cfg = await callGo<RelayConfig>('GetConfig')
      startTransition(() => {
        setConfig(normalizeConfig(cfg))
      })
      return normalizeConfig(cfg)
    } catch (error) {
      throw error
    }
  })

  const refreshStatus = useEffectEvent(async () => {
    const nextStatus = await callGo<StatusInfo>('GetStatus')
    startTransition(() => {
      setStatus(nextStatus)
    })
    return nextStatus
  })

  const refreshLogs = useEffectEvent(async () => {
    const nextLogs = await callGo<LogEntry[]>('GetRecentLogs', 200)
    startTransition(() => {
      setLogs(nextLogs || [])
    })
    return nextLogs
  })

  const detectSources = useEffectEvent(async () => {
    const detected = await callGo<ImportSource[]>('DetectSources')
    startTransition(() => {
      setSources(
        (detected || []).map((source) => ({
          ...source,
          servers: source.servers || [],
        })),
      )
    })
    return detected
  })

  const refreshRuntime = useEffectEvent(async () => {
    await Promise.all([refreshStatus(), refreshLogs()])
  })

  const saveConfig = useEffectEvent(async (nextConfig: RelayConfig) => {
    await callGo('SaveConfig', nextConfig)
    await loadConfig()
  })

  const addServer = useEffectEvent(async (server: ServerConfig) => {
    await callGo('AddServer', server)
    await loadConfig()
  })

  const removeServer = useEffectEvent(async (name: string) => {
    await callGo('RemoveServer', name)
    await loadConfig()
  })

  const importServers = useEffectEvent(async (servers: ImportServer[]) => {
    await callGo('ImportServers', servers)
    await Promise.all([loadConfig(), detectSources()])
  })

  const setSyncSourceMode = useEffectEvent(async (source: ImportSource, syncMode: SyncSourceConfig['syncMode']) => {
    const currentConfig = normalizeConfig(config)
    const nextSyncSources = [...(currentConfig.syncSources || [])]
    const existingIndex = nextSyncSources.findIndex((item) => item.sourceKey === source.sourceKey)
    const nextSource: SyncSourceConfig = {
      sourceKind: source.kind,
      sourceKey: source.sourceKey,
      configPath: source.configPath,
      syncMode,
      status: source.status || (source.available ? 'idle' : source.error ? 'error' : 'disabled'),
      lastError: source.error,
      metadata: {
        displayName: source.name,
        detectedServerCount: source.servers.length,
      },
    }

    if (existingIndex >= 0) {
      nextSyncSources[existingIndex] = {
        ...nextSyncSources[existingIndex],
        ...nextSource,
      }
    } else {
      nextSyncSources.push(nextSource)
    }

    await saveConfig({
      ...currentConfig,
      syncSources: nextSyncSources,
    })
    await detectSources()
  })

  const claimPairing = useEffectEvent(async (serverBaseUrl: string, pairingCode: string, displayName: string) => {
    const result = await callGo<string>('ClaimPairing', serverBaseUrl, pairingCode, displayName)
    await Promise.all([loadConfig(), refreshStatus()])
    return result
  })

  const startRelay = useEffectEvent(async () => {
    await callGo('StartRelay')
    await refreshStatus()
  })

  const stopRelay = useEffectEvent(async () => {
    await callGo('StopRelay')
    await refreshStatus()
  })

  const restartRelay = useEffectEvent(async () => {
    await callGo('RestartRelay')
    await refreshStatus()
  })

  useEffect(() => {
    void Promise.all([loadConfig(), refreshRuntime(), detectSources()])

    const poll = window.setInterval(() => {
      void refreshRuntime()
    }, 2000)

    if (window.runtime?.EventsOn) {
      window.runtime.EventsOn('relay:event', (evt: RelayEventPayload) => {
        startTransition(() => {
          setLogs((current) => [...current.slice(-199), {
            time: evt.time,
            type: evt.type,
            message: evt.message,
          }])
        })
        void refreshStatus()
      })

      window.runtime.EventsOn('config:updated', (evt: ConfigUpdatedEvent) => {
        setBanner(
          evt?.message ||
            (evt?.autoApplied ? 'Configuration updated and relay restarted.' : 'Configuration updated.'),
        )
        void loadConfig()
        void refreshRuntime()
      })

      window.runtime.EventsOn('config:external-change', (evt: ConfigChangeEvent) => {
        if (evt?.kind === 'changed') {
          setBanner(
            evt.message ||
              (evt.autoApplied
                ? 'Configuration reloaded from disk and applied to the running relay.'
                : evt.requiresRestart
                  ? 'Configuration reloaded from disk. Restart relay to apply runtime changes.'
                  : 'Configuration reloaded from disk.'),
          )
          void loadConfig()
          void refreshRuntime()
        } else if (evt?.kind === 'deleted') {
          setBanner('The relay configuration file was removed outside the app.')
        } else if (evt?.kind === 'error') {
          setBanner(evt.message || 'Failed to reload updated configuration.')
        }
      })
    }

    return () => {
      window.clearInterval(poll)
      if (window.runtime?.EventsOff) {
        window.runtime.EventsOff('relay:event')
        window.runtime.EventsOff('config:updated')
        window.runtime.EventsOff('config:external-change')
      }
    }
  }, [detectSources, loadConfig, refreshRuntime, refreshStatus])

  return {
    config,
    status,
    logs,
    sources,
    banner,
    setBanner,
    actions: {
      loadConfig,
      refreshStatus,
      refreshLogs,
      refreshRuntime,
      detectSources,
      addServer,
      removeServer,
      saveConfig,
      importServers,
      setSyncSourceMode,
      claimPairing,
      startRelay,
      stopRelay,
      restartRelay,
    },
  }
}
