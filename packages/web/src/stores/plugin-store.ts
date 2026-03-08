'use client';
import { create } from 'zustand';
import { api } from '@/lib/api';

interface PluginState {
  marketplace: any[];
  installations: any[];
  organizations: any[];
  loadingMarketplace: boolean;
  loadingInstalled: boolean;

  loadMarketplace: (search?: string) => Promise<void>;
  loadOrganizations: () => Promise<void>;
  loadInstallations: (wsId: string) => Promise<void>;
  installPlugin: (wsId: string, data: { pluginId: string; scopeType: string; scopeId?: string; lifecycleScope?: string; configData?: Record<string, unknown> }) => Promise<void>;
  uninstallPlugin: (wsId: string, installId: string) => Promise<void>;
  updateInstallation: (wsId: string, installId: string, data: any) => Promise<void>;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  marketplace: [],
  installations: [],
  organizations: [],
  loadingMarketplace: false,
  loadingInstalled: false,

  loadMarketplace: async (search?: string) => {
    set({ loadingMarketplace: true });
    try {
      const params = search ? `search=${encodeURIComponent(search)}` : '';
      const data = await api.getMarketplace(params);
      set({ marketplace: data });
    } catch (err) {
      console.error('Failed to load marketplace:', err);
    } finally {
      set({ loadingMarketplace: false });
    }
  },

  loadOrganizations: async () => {
    try {
      const data = await api.getMcpOrganizations();
      set({ organizations: data });
    } catch (err) {
      console.error('Failed to load orgs:', err);
    }
  },

  loadInstallations: async (wsId: string) => {
    set({ loadingInstalled: true });
    try {
      const data = await api.getInstallations(wsId);
      set({ installations: data });
    } catch (err) {
      console.error('Failed to load installations:', err);
    } finally {
      set({ loadingInstalled: false });
    }
  },

  installPlugin: async (wsId, data) => {
    await api.installPlugin(wsId, data);
    await get().loadInstallations(wsId);
  },

  uninstallPlugin: async (wsId: string, installId: string) => {
    await api.uninstallPlugin(wsId, installId);
    await get().loadInstallations(wsId);
  },

  updateInstallation: async (wsId: string, installId: string, data: any) => {
    await api.updateInstallation(wsId, installId, data);
    await get().loadInstallations(wsId);
  },
}));
