import { startTransition, useEffect, useEffectEvent, useState } from "react"

import { callGo } from "../lib/wails"
import type {
  BuiltinFilesystemRootConfig,
  CrashRecoveryNotice,
  ConfigChangeEvent,
  ConfigUpdatedEvent,
  ImportServer,
  ImportSource,
  LogEntry,
  NotificationSettings,
  RelayConfig,
  RelayEventPayload,
  SecuritySettings,
  ServerConfig,
  StatusInfo,
  StartupSettings,
  SyncSourceConfig,
} from "../types"

declare const window: any

function normalizeConfig(cfg?: RelayConfig | null): RelayConfig {
  return {
    relay: cfg?.relay || {},
    startup: cfg?.startup || {},
    notifications: cfg?.notifications || {},
    security: cfg?.security || {},
    update: cfg?.update || {},
    logLevel: cfg?.logLevel || "info",
    syncSources: cfg?.syncSources || [],
    servers: cfg?.servers || [],
  }
}

export function useRelayDesktop() {
  const [config, setConfig] = useState<RelayConfig>(() => normalizeConfig())
  const [status, setStatus] = useState<StatusInfo>({ state: "stopped" })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [sources, setSources] = useState<ImportSource[]>([])
  const [banner, setBanner] = useState<string>("")
  const [ready, setReady] = useState(false)
  const [crashRecovery, setCrashRecovery] =
    useState<CrashRecoveryNotice | null>(null)

  const loadConfig = useEffectEvent(async () => {
    try {
      const cfg = await callGo<RelayConfig>("GetConfig")
      startTransition(() => {
        setConfig(normalizeConfig(cfg))
      })
      return normalizeConfig(cfg)
    } catch (error) {
      throw error
    }
  })

  const refreshStatus = useEffectEvent(async () => {
    const nextStatus = await callGo<StatusInfo>("GetStatusSummary")
    startTransition(() => {
      setStatus(nextStatus)
    })
    return nextStatus
  })

  const refreshLogs = useEffectEvent(async () => {
    const nextLogs = await callGo<LogEntry[]>("GetRecentLogs", 200)
    startTransition(() => {
      setLogs(nextLogs || [])
    })
    return nextLogs
  })

  const detectSources = useEffectEvent(async () => {
    const detected = await callGo<ImportSource[]>("DetectSources")
    startTransition(() => {
      setSources(
        (detected || []).map((source) => ({
          ...source,
          servers: source.servers || [],
        }))
      )
    })
    return detected
  })

  const refreshRuntime = useEffectEvent(async () => {
    await refreshStatus()
  })

  const loadCrashRecovery = useEffectEvent(async () => {
    const nextNotice = await callGo<CrashRecoveryNotice | null>(
      "GetCrashRecoveryStatus"
    )
    startTransition(() => {
      setCrashRecovery(nextNotice || null)
    })
    return nextNotice
  })

  const saveConfig = useEffectEvent(async (nextConfig: RelayConfig) => {
    await callGo("SaveConfig", nextConfig)
    await loadConfig()
  })

  const saveDesktopPreferences = useEffectEvent(
    async (
      startup: StartupSettings,
      notifications: NotificationSettings,
      security: SecuritySettings
    ) => {
      await callGo("SaveDesktopPreferences", startup, notifications, security)
      await loadConfig()
    }
  )

  const addServer = useEffectEvent(async (server: ServerConfig) => {
    await callGo("AddServer", server)
    await loadConfig()
  })

  const removeServer = useEffectEvent(async (name: string) => {
    await callGo("RemoveServer", name)
    await loadConfig()
  })

  const getSuggestedFilesystemRoots = useEffectEvent(async () => {
    const roots = await callGo<BuiltinFilesystemRootConfig[]>(
      "GetSuggestedFilesystemRoots"
    )
    return roots || []
  })

  const importServers = useEffectEvent(async (servers: ImportServer[]) => {
    await callGo("ImportServers", servers)
    await Promise.all([loadConfig(), detectSources()])
  })

  const setSyncSourceMode = useEffectEvent(
    async (source: ImportSource, syncMode: SyncSourceConfig["syncMode"]) => {
      const currentConfig = normalizeConfig(config)
      const nextSyncSources = [...(currentConfig.syncSources || [])]
      const existingIndex = nextSyncSources.findIndex(
        (item) => item.sourceKey === source.sourceKey
      )
      const nextSource: SyncSourceConfig = {
        sourceKind: source.kind,
        sourceKey: source.sourceKey,
        configPath: source.configPath,
        syncMode,
        status:
          source.status ||
          (source.available ? "idle" : source.error ? "error" : "disabled"),
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
    }
  )

  const addSyncSource = useEffectEvent(
    async (source: ImportSource, syncMode: SyncSourceConfig["syncMode"]) => {
      const currentConfig = normalizeConfig(config)
      if (
        (currentConfig.syncSources || []).some(
          (item) => item.sourceKey === source.sourceKey
        )
      ) {
        throw new Error("This target already exists.")
      }

      const nextSource: SyncSourceConfig = {
        sourceKind: source.kind,
        sourceKey: source.sourceKey,
        configPath: source.configPath,
        syncMode,
        status:
          source.status ||
          (source.available ? "idle" : source.error ? "error" : "disabled"),
        lastError: source.error,
        metadata: {
          displayName: source.name,
          detectedServerCount: source.servers.length,
        },
      }

      await saveConfig({
        ...currentConfig,
        syncSources: [...(currentConfig.syncSources || []), nextSource],
      })
      await detectSources()
    }
  )

  const removeSyncSource = useEffectEvent(async (sourceKey: string) => {
    const currentConfig = normalizeConfig(config)
    await saveConfig({
      ...currentConfig,
      syncSources: (currentConfig.syncSources || []).filter(
        (item) => item.sourceKey !== sourceKey
      ),
      servers: (currentConfig.servers || []).map((server) =>
        server.syncSourceKey === sourceKey
          ? { ...server, syncSourceKey: undefined }
          : server
      ),
    })
    await detectSources()
  })

  const claimPairing = useEffectEvent(
    async (serverBaseUrl: string, pairingCode: string, displayName: string) => {
      const result = await callGo<string>(
        "ClaimPairing",
        serverBaseUrl,
        pairingCode,
        displayName
      )
      await Promise.all([loadConfig(), refreshStatus()])
      return result
    }
  )

  const startRelay = useEffectEvent(async () => {
    await callGo("StartRelay")
    await refreshStatus()
  })

  const stopRelay = useEffectEvent(async () => {
    await callGo("StopRelay")
    await refreshStatus()
  })

  const restartRelay = useEffectEvent(async () => {
    await callGo("RestartRelay")
    await refreshStatus()
  })

  const dismissCrashRecovery = useEffectEvent(async () => {
    await callGo("DismissCrashRecoveryStatus")
    startTransition(() => {
      setCrashRecovery(null)
    })
  })

  const openDesktopLogFile = useEffectEvent(async () => {
    await callGo("OpenDesktopLogFile")
  })

  const openDesktopLogDir = useEffectEvent(async () => {
    await callGo("OpenDesktopLogDir")
  })

  useEffect(() => {
    void Promise.all([
      loadConfig(),
      refreshStatus(),
      refreshLogs(),
      detectSources(),
      loadCrashRecovery(),
    ]).finally(() => {
      setReady(true)
    })

    const poll = window.setInterval(() => {
      void refreshStatus()
    }, 2000)

    if (window.runtime?.EventsOn) {
      const offRelayEvent = window.runtime.EventsOn(
        "relay:event",
        (evt: RelayEventPayload) => {
          startTransition(() => {
            setLogs((current) => [
              ...current.slice(-199),
              {
                time: evt.time,
                type: evt.type,
                message: evt.message,
                data: evt.data || {},
              },
            ])
          })
          void refreshStatus()
        }
      )

      const offConfigUpdated = window.runtime.EventsOn(
        "config:updated",
        (evt: ConfigUpdatedEvent) => {
          setBanner(
            evt?.message ||
              (evt?.autoApplied
                ? "Configuration updated and relay restarted."
                : "Configuration updated.")
          )
          void loadConfig()
          void Promise.all([refreshStatus(), refreshLogs()])
        }
      )

      const offConfigExternalChange = window.runtime.EventsOn(
        "config:external-change",
        (evt: ConfigChangeEvent) => {
          if (evt?.kind === "changed") {
            setBanner(
              evt.message ||
                (evt.autoApplied
                  ? "Configuration reloaded from disk and applied to the running relay."
                  : evt.requiresRestart
                    ? "Configuration reloaded from disk. Restart relay to apply runtime changes."
                    : "Configuration reloaded from disk.")
            )
            void loadConfig()
            void Promise.all([refreshStatus(), refreshLogs()])
          } else if (evt?.kind === "deleted") {
            setBanner(
              "The relay configuration file was removed outside the app."
            )
          } else if (evt?.kind === "error") {
            setBanner(evt.message || "Failed to reload updated configuration.")
          }
        }
      )

      return () => {
        window.clearInterval(poll)
        offRelayEvent?.()
        offConfigUpdated?.()
        offConfigExternalChange?.()
      }
    }

    return () => {
      window.clearInterval(poll)
    }
  }, [detectSources, loadConfig, loadCrashRecovery, refreshLogs, refreshStatus])

  useEffect(() => {
    function reportFrontendError(
      kind: string,
      message: string,
      stack = "",
      source = ""
    ) {
      try {
        const method = window.go?.main?.App?.ReportFrontendError
        if (typeof method === "function") {
          void method(kind, message, stack, source)
        }
      } catch {
        // Swallow diagnostics reporting errors to avoid recursive crashes.
      }
    }

    function onWindowError(event: ErrorEvent) {
      reportFrontendError(
        "frontend_error",
        event.message || "Unhandled window error",
        event.error?.stack || "",
        event.filename || ""
      )
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason
      if (reason instanceof Error) {
        reportFrontendError(
          "frontend_unhandled_rejection",
          reason.message,
          reason.stack || ""
        )
        return
      }
      reportFrontendError(
        "frontend_unhandled_rejection",
        String(reason ?? "Unhandled promise rejection")
      )
    }

    window.addEventListener("error", onWindowError)
    window.addEventListener("unhandledrejection", onUnhandledRejection)
    return () => {
      window.removeEventListener("error", onWindowError)
      window.removeEventListener("unhandledrejection", onUnhandledRejection)
    }
  }, [])

  return {
    config,
    status,
    logs,
    sources,
    crashRecovery,
    banner,
    setBanner,
    ready,
    actions: {
      loadConfig,
      refreshStatus,
      refreshLogs,
      refreshRuntime,
      detectSources,
      addServer,
      removeServer,
      getSuggestedFilesystemRoots,
      saveConfig,
      saveDesktopPreferences,
      importServers,
      addSyncSource,
      removeSyncSource,
      setSyncSourceMode,
      claimPairing,
      startRelay,
      stopRelay,
      restartRelay,
      dismissCrashRecovery,
      openDesktopLogFile,
      openDesktopLogDir,
    },
  }
}
