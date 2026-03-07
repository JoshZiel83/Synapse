'use client';
import { create } from 'zustand';
import { api } from '@/lib/api';

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
  setUser: (user) => set({ user }),
  login: async (email, password) => {
    const res = await api.login(email, password);
    api.setToken(res.tokens.accessToken);
    localStorage.setItem('refreshToken', res.tokens.refreshToken);
    set({ user: res.user });
  },
  register: async (email, password, name) => {
    const res = await api.register(email, password, name);
    api.setToken(res.tokens.accessToken);
    localStorage.setItem('refreshToken', res.tokens.refreshToken);
    set({ user: res.user });
  },
  logout: () => { api.clearToken(); localStorage.removeItem('refreshToken'); set({ user: null }); },
  checkAuth: async () => {
    try {
      const user = await api.getMe();
      set({ user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },
}));
