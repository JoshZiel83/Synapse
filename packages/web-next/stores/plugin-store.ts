"use client"
import { create } from "zustand"
import type {
  MarketplacePluginView,
  MarketplacePublisherView,
  PluginCategoryView,
  PluginInstallationDetailView,
  ReuseScope,
} from "@synapse/shared"
import type { CapabilityAccessTarget } from "@synapse/shared/types"
import { api } from "@/lib/api"

import { createLogger } from "@/lib/client-logger"

const clientLog = createLogger("web.stores.plugin-store")

interface PluginState {
  marketplace: MarketplacePluginView[]
  categories: PluginCategoryView[]
  installations: PluginInstallationDetailView[]
  organizations: MarketplacePublisherView[]
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
      grants?: Array<{
        target: CapabilityAccessTarget
        permissions: string[]
        conversationTypeMaskOverride?: number | null
        reason?: string
      }>
    }
  ) => Promise<PluginInstallationDetailView>
  uninstallPlugin: (wsId: string, installId: string) => Promise<void>
  updateInstallation: (
    wsId: string,
    installId: string,
    data: {
      isEnabled?: boolean
      configData?: Record<string, unknown>
      authSessionIds?: Record<string, string>
      lifecycleScope?: ReuseScope
      conversationTypeMaskOverride?: number | null
    }
  ) => Promise<PluginInstallationDetailView>
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
      const data = await api.getMarketplace({
        search,
        categories: categorySlugs,
      })
      set({ marketplace: data })
    } catch (err) {
      clientLog.error("Failed to load marketplace:", err)
    } finally {
      set({ loadingMarketplace: false })
    }
  },

  loadCategories: async () => {
    try {
      const data = await api.getPluginCategories()
      set({ categories: data })
    } catch (err) {
      clientLog.error("Failed to load plugin categories:", err)
    }
  },

  loadOrganizations: async () => {
    try {
      const data = await api.getMcpOrganizations()
      set({ organizations: data })
    } catch (err) {
      clientLog.error("Failed to load orgs:", err)
    }
  },

  loadInstallations: async (wsId: string) => {
    set({ loadingInstalled: true })
    try {
      const data = await api.getInstallations(wsId)
      set({ installations: data })
    } catch (err) {
      clientLog.error("Failed to load installations:", err)
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

  updateInstallation: async (wsId, installId, data) => {
    const installation = await api.updateInstallation(wsId, installId, data)
    await get().loadInstallations(wsId)
    return installation
  },
}))
