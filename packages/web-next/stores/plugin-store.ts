"use client"
import { create } from "zustand"
import type { ReuseScope } from "@synapse/shared"
import { api } from "@/lib/api"

interface PluginState {
  marketplace: any[]
  categories: any[]
  installations: any[]
  organizations: any[]
  loadingMarketplace: boolean
  loadingInstalled: boolean

  loadMarketplace: (search?: string, categorySlugs?: string[]) => Promise<void>
  loadCategories: () => Promise<void>
  loadOrganizations: () => Promise<void>
  loadInstallations: (wsId: string) => Promise<void>
  installPlugin: (
    wsId: string,
    data: {
      pluginId: string
      lifecycleScope?: ReuseScope
      configData?: Record<string, unknown>
      authSessionIds?: Record<string, string>
    }
  ) => Promise<any>
  uninstallPlugin: (wsId: string, installId: string) => Promise<void>
  updateInstallation: (
    wsId: string,
    installId: string,
    data: any
  ) => Promise<any>
}

export const usePluginStore = create<PluginState>((set, get) => ({
  marketplace: [],
  categories: [],
  installations: [],
  organizations: [],
  loadingMarketplace: false,
  loadingInstalled: false,

  loadMarketplace: async (search?: string, categorySlugs?: string[]) => {
    set({ loadingMarketplace: true })
    try {
      const params = new URLSearchParams()
      if (search) params.set("search", search)
      if (categorySlugs && categorySlugs.length > 0)
        params.set("categories", categorySlugs.join(","))
      const data = await api.getMarketplace(params.toString() || undefined)
      set({ marketplace: data })
    } catch (err) {
      console.error("Failed to load marketplace:", err)
    } finally {
      set({ loadingMarketplace: false })
    }
  },

  loadCategories: async () => {
    try {
      const data = await api.getPluginCategories()
      set({ categories: data })
    } catch (err) {
      console.error("Failed to load plugin categories:", err)
    }
  },

  loadOrganizations: async () => {
    try {
      const data = await api.getMcpOrganizations()
      set({ organizations: data })
    } catch (err) {
      console.error("Failed to load orgs:", err)
    }
  },

  loadInstallations: async (wsId: string) => {
    set({ loadingInstalled: true })
    try {
      const data = await api.getInstallations(wsId)
      set({ installations: data })
    } catch (err) {
      console.error("Failed to load installations:", err)
    } finally {
      set({ loadingInstalled: false })
    }
  },

  installPlugin: async (wsId, data) => {
    const installation = await api.installPlugin(wsId, data)
    await get().loadInstallations(wsId)
    return installation
  },

  uninstallPlugin: async (wsId: string, installId: string) => {
    await api.uninstallPlugin(wsId, installId)
    await get().loadInstallations(wsId)
  },

  updateInstallation: async (wsId: string, installId: string, data: any) => {
    const installation = await api.updateInstallation(wsId, installId, data)
    await get().loadInstallations(wsId)
    return installation
  },
}))
