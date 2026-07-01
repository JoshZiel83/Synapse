"use client"

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import type {
  TransportConnectorCapability,
  TransportKind,
} from "@synapse/shared"
import { api } from "@/lib/api"

/**
 * IM connector metadata provider.
 *
 * Lives in `lib/` (not `app/dashboard/im/`) because dashboard/chat,
 * dashboard/im, and any future surface need the same map — colocating
 * with the IM route would obscure ownership.
 *
 * Frontend label/icon resolution goes through this provider so the
 * UI never has to know `transportKind` literals. The static
 * `describeTransportKind` shared helper is the fallback when the
 * provider hasn't loaded yet (initial render before fetch, missing
 * connector, etc).
 *
 * No SWR / react-query dependency in this repo — bare
 * `useEffect + useState` is enough. `api.getTransportConnectors`
 * already carries cookie credentials and unified error parsing, so
 * we call it instead of raw `fetch`.
 */

export type ConnectorMetadataMap = Map<
  TransportKind,
  TransportConnectorCapability
>

interface ConnectorMetadataValue {
  /** Resolved map; undefined until the first fetch completes. */
  metadata: ConnectorMetadataMap | undefined
  /** True between fetch start and resolution (covers refetch on workspace switch). */
  loading: boolean
  /** Last fetch error, if any. Reset on next workspace change. */
  error: Error | null
  /** Force a refetch — used after admin actions that change capability flags. */
  refresh: () => Promise<void>
}

const Context = createContext<ConnectorMetadataValue>({
  metadata: undefined,
  loading: false,
  error: null,
  refresh: async () => {},
})

export function useConnectorMetadata(): ConnectorMetadataMap | undefined {
  return useContext(Context).metadata
}

export function useConnectorMetadataState(): ConnectorMetadataValue {
  return useContext(Context)
}

interface ProviderProps {
  /**
   * Active workspace id. When this changes, metadata is refetched
   * (capability flags can vary per workspace if the backend ever
   * starts gating per workspace). When null/undefined, the provider
   * stays in the "not loaded" state.
   */
  workspaceId: string | null
  children: ReactNode
}

export function ConnectorMetadataProvider({
  workspaceId,
  children,
}: ProviderProps) {
  const [metadata, setMetadata] = useState<ConnectorMetadataMap | undefined>(
    undefined
  )
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)

  // Bumping this counter triggers a refetch even when workspaceId
  // didn't change (manual refresh, post-config-update etc).
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!workspaceId) {
      setMetadata(undefined)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .getTransportConnectors(workspaceId)
      .then((res) => {
        if (cancelled) return
        const map: ConnectorMetadataMap = new Map()
        for (const cap of res.connectors) {
          map.set(cap.transportKind, cap)
        }
        setMetadata(map)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, refreshTick])

  const refresh = async () => {
    setRefreshTick((tick) => tick + 1)
  }

  return (
    <Context.Provider value={{ metadata, loading, error, refresh }}>
      {children}
    </Context.Provider>
  )
}
