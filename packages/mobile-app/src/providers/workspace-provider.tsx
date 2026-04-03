import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { api } from '@/lib/api';
import { deleteStoredValue, readStoredValue, writeStoredValue } from '@/lib/storage';
import { useSession } from '@/providers/session-provider';
import type { WorkspaceInfo } from '@/types/api';

const WORKSPACE_KEY = 'synapse.mobile.workspaceId';

interface WorkspaceContextValue {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: WorkspaceInfo[];
  loading: boolean;
  needsOnboarding: boolean;
  setWorkspaceId: (workspaceId: string) => Promise<void>;
  refreshWorkspaces: (preferredWorkspaceId?: string | null) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [loading, setLoading] = useState(true);

  const selectWorkspace = useCallback(
    async (nextWorkspaceId: string) => {
      setWorkspaceIdState(nextWorkspaceId);
      const match = workspaces.find((workspace) => workspace.id === nextWorkspaceId);
      setWorkspaceName(match?.name ?? null);
      await writeStoredValue(WORKSPACE_KEY, nextWorkspaceId);
    },
    [workspaces],
  );

  const refreshWorkspaces = useCallback(async (preferredWorkspaceId?: string | null) => {
    if (status !== 'authenticated') {
      setWorkspaces([]);
      setWorkspaceIdState(null);
      setWorkspaceName(null);
      setNeedsOnboarding(false);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const response = await api.getWorkspaces();
      const list = response.data ?? [];
      setWorkspaces(list);
      setNeedsOnboarding(list.length === 0);

      if (list.length === 0) {
        setWorkspaceIdState(null);
        setWorkspaceName(null);
        await deleteStoredValue(WORKSPACE_KEY);
        return;
      }

      const savedWorkspaceId = await readStoredValue(WORKSPACE_KEY);
      const targetWorkspaceId = preferredWorkspaceId ?? savedWorkspaceId;
      const activeWorkspace = list.find((workspace) => workspace.id === targetWorkspaceId) ?? list[0] ?? null;

      if (activeWorkspace) {
        setWorkspaceIdState(activeWorkspace.id);
        setWorkspaceName(activeWorkspace.name);
        await writeStoredValue(WORKSPACE_KEY, activeWorkspace.id);
      }
    } catch {
      setWorkspaces([]);
      setWorkspaceIdState(null);
      setWorkspaceName(null);
      setNeedsOnboarding(false);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId,
      workspaceName,
      workspaces,
      loading,
      needsOnboarding,
      setWorkspaceId: selectWorkspace,
      refreshWorkspaces,
    }),
    [loading, needsOnboarding, refreshWorkspaces, selectWorkspace, workspaceId, workspaceName, workspaces],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  }

  return value;
}
