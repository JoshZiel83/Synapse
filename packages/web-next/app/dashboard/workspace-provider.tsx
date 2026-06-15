"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { api } from "@/lib/api"
import { ConnectorMetadataProvider } from "@/lib/im-connector-metadata"
import { useClearWorkspaceQueries } from "@/hooks/use-logout"
import type { WorkspaceListItemView } from "@synapse/shared"

type WorkspaceInfo = WorkspaceListItemView

interface WorkspaceContextType {
  workspaceId: string | null
  workspaceName: string | null
  currentWorkspaceMemberId: string | null
  workspaces: WorkspaceInfo[]
  needsOnboarding: boolean
  setWorkspaceId: (id: string) => void
  refreshWorkspaces: () => Promise<void>
  loading: boolean
}

const WorkspaceContext = createContext<WorkspaceContextType>({
  workspaceId: null,
  workspaceName: null,
  currentWorkspaceMemberId: null,
  workspaces: [],
  needsOnboarding: false,
  setWorkspaceId: () => {},
  refreshWorkspaces: async () => {},
  loading: true,
})

const MIN_INITIAL_WORKSPACE_LOADING_MS = 560

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function useWorkspace() {
  return useContext(WorkspaceContext)
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [currentWorkspaceMemberId, setCurrentWorkspaceMemberId] = useState<
    string | null
  >(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [loading, setLoading] = useState(true)
  const initialLoadPendingRef = useRef(true)
  const clearWorkspaceQueries = useClearWorkspaceQueries()

  const loadWorkspaces = useCallback(async () => {
    setLoading(true)
    const minimumDelay = initialLoadPendingRef.current
      ? wait(MIN_INITIAL_WORKSPACE_LOADING_MS)
      : Promise.resolve()

    try {
      const list: WorkspaceInfo[] = await api.getWorkspaces()
      setWorkspaces(list)

      if (list.length === 0) {
        setNeedsOnboarding(true)
        setWorkspaceId(null)
        setWorkspaceName(null)
        setCurrentWorkspaceMemberId(null)
        localStorage.removeItem("workspaceId")
      } else {
        setNeedsOnboarding(false)
        const savedWsId = localStorage.getItem("workspaceId")
        const match = list.find((w) => w.id === savedWsId)
        if (match) {
          setWorkspaceId(match.id)
          setWorkspaceName(match.name)
          setCurrentWorkspaceMemberId(match.currentWorkspaceMemberId ?? null)
        } else {
          setWorkspaceId(list[0].id)
          setWorkspaceName(list[0].name)
          setCurrentWorkspaceMemberId(list[0].currentWorkspaceMemberId ?? null)
          localStorage.setItem("workspaceId", list[0].id)
        }
      }
    } catch (err) {
      console.error("Failed to load workspaces:", err)
    } finally {
      await minimumDelay
      initialLoadPendingRef.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  const handleSetWorkspaceId = (id: string) => {
    // Switching workspaces: drop the previous workspace's cached queries so its
    // data can't bleed into the next one.
    if (workspaceId && workspaceId !== id) {
      clearWorkspaceQueries(workspaceId)
    }
    const ws = workspaces.find((w) => w.id === id)
    setWorkspaceId(id)
    setWorkspaceName(ws?.name ?? null)
    setCurrentWorkspaceMemberId(ws?.currentWorkspaceMemberId ?? null)
    localStorage.setItem("workspaceId", id)
    if (!ws) {
      api
        .getWorkspace(id)
        .then((w: any) => setWorkspaceName(w.name))
        .catch(() => {})
    }
  }

  return (
    <WorkspaceContext.Provider
      value={{
        workspaceId,
        workspaceName,
        currentWorkspaceMemberId,
        workspaces,
        needsOnboarding,
        setWorkspaceId: handleSetWorkspaceId,
        refreshWorkspaces: loadWorkspaces,
        loading,
      }}
    >
      {/* Connector metadata is workspace-scoped (capability flags
          may differ later). Wrap inside the WorkspaceProvider so
          `workspaceId` is in scope. */}
      <ConnectorMetadataProvider workspaceId={workspaceId}>
        {children}
      </ConnectorMetadataProvider>
    </WorkspaceContext.Provider>
  )
}
