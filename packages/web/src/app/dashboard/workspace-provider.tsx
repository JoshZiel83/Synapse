'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api } from '@/lib/api';

interface WorkspaceContextType {
  workspaceId: string | null;
  workspaceName: string | null;
  setWorkspaceId: (id: string) => void;
  loading: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextType>({
  workspaceId: null,
  workspaceName: null,
  setWorkspaceId: () => {},
  loading: true,
});

export function useWorkspace() {
  return useContext(WorkspaceContext);
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedWsId = localStorage.getItem('workspaceId');
    if (savedWsId) {
      api.getWorkspace(savedWsId)
        .then((ws: any) => {
          setWorkspaceId(savedWsId);
          setWorkspaceName(ws.name);
          setLoading(false);
        })
        .catch(() => {
          localStorage.removeItem('workspaceId');
          loadOrCreateWorkspace();
        });
    } else {
      loadOrCreateWorkspace();
    }
  }, []);

  async function loadOrCreateWorkspace() {
    try {
      const res = await api.getWorkspaces();
      // API returns { data: [...] }
      const workspaces = res?.data ?? res ?? [];

      if (workspaces.length > 0) {
        setWorkspaceId(workspaces[0].id);
        setWorkspaceName(workspaces[0].name);
        localStorage.setItem('workspaceId', workspaces[0].id);
      } else {
        // Auto-create a default workspace for new users
        const newWs = await api.createWorkspace('My Workspace', 'Default workspace');
        if (newWs?.id) {
          setWorkspaceId(newWs.id);
          setWorkspaceName(newWs.name);
          localStorage.setItem('workspaceId', newWs.id);
        }
      }
    } catch (err) {
      console.error('Failed to load/create workspace:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleSetWorkspaceId = (id: string) => {
    setWorkspaceId(id);
    localStorage.setItem('workspaceId', id);
    api.getWorkspace(id)
      .then((ws: any) => setWorkspaceName(ws.name))
      .catch(() => {});
  };

  return (
    <WorkspaceContext.Provider value={{ workspaceId, workspaceName, setWorkspaceId: handleSetWorkspaceId, loading }}>
      {children}
    </WorkspaceContext.Provider>
  );
}
