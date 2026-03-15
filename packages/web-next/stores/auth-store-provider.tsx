'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { User } from '@synapse/shared';
import { api } from '@/lib/api';

function normalizeAuthUser(payload: unknown): User | null {
  if (!payload || typeof payload !== 'object') return null;
  if ('user' in payload && payload.user && typeof payload.user === 'object') {
    return payload.user as User;
  }
  return payload as User;
}

interface AuthState {
  user: User | null;
  setUser: (user: User | null) => void;
  login: (email: string, password: string) => Promise<User | null>;
  register: (email: string, password: string, name: string) => Promise<User | null>;
  logout: () => Promise<void>;
}

type AuthStore = StoreApi<AuthState>;

function createAuthStore(initialUser: User | null): AuthStore {
  return createStore<AuthState>((set) => ({
    user: normalizeAuthUser(initialUser),
    setUser: (user) => set({ user: normalizeAuthUser(user) }),
    login: async (email, password) => {
      const res = await api.login(email, password);
      const user = normalizeAuthUser(res.user);
      set({ user });
      return user;
    },
    register: async (email, password, name) => {
      const res = await api.register(email, password, name);
      const user = normalizeAuthUser(res.user);
      set({ user });
      return user;
    },
    logout: async () => {
      try {
        await api.logout();
      } catch {
        // Best-effort logout: the server may already consider the session invalid.
      }
      localStorage.removeItem('workspaceId');
      set({ user: null });
    },
  }));
}

const AuthStoreContext = createContext<AuthStore | null>(null);

export function AuthStoreProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  initialUser?: User | null;
}) {
  const storeRef = useRef<AuthStore | null>(null);

  if (!storeRef.current) {
    storeRef.current = createAuthStore(initialUser);
  }

  useEffect(() => {
    storeRef.current?.setState({
      user: normalizeAuthUser(initialUser),
    });
  }, [initialUser]);

  return (
    <AuthStoreContext.Provider value={storeRef.current}>
      {children}
    </AuthStoreContext.Provider>
  );
}

function useAuthStoreContext() {
  const store = useContext(AuthStoreContext);
  if (!store) {
    throw new Error('useAuthStore must be used within an AuthStoreProvider');
  }
  return store;
}

const identity = (state: AuthState) => state;

export function useAuthStore(): AuthState;
export function useAuthStore<T>(selector: (state: AuthState) => T): T;
export function useAuthStore<T>(selector?: (state: AuthState) => T) {
  const store = useAuthStoreContext();
  return useStore(
    store,
    selector ?? (identity as (state: AuthState) => T),
  );
}
