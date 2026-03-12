'use client';
import { create } from 'zustand';
import { api } from '@/lib/api';

function normalizeAuthUser(payload: any) {
  if (!payload) return null;
  if (payload.user && typeof payload.user === 'object') {
    return payload.user;
  }
  return payload;
}

interface AuthState {
  user: any | null;
  loading: boolean;
  setUser: (user: any) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (user) => set({ user: normalizeAuthUser(user) }),
  login: async (email, password) => {
    const res = await api.login(email, password);
    api.setToken(res.tokens.accessToken);
    localStorage.setItem('refreshToken', res.tokens.refreshToken);
    set({ user: normalizeAuthUser(res.user), loading: false });
  },
  register: async (email, password, name) => {
    const res = await api.register(email, password, name);
    api.setToken(res.tokens.accessToken);
    localStorage.setItem('refreshToken', res.tokens.refreshToken);
    set({ user: normalizeAuthUser(res.user), loading: false });
  },
  logout: () => { api.clearToken(); localStorage.removeItem('refreshToken'); set({ user: null }); },
  checkAuth: async () => {
    try {
      const user = await api.getMe();
      set({ user: normalizeAuthUser(user), loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },
}));
