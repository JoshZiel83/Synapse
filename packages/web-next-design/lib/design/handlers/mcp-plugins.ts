import {
  MarketplacePublisherListViewSchema,
  MarketplacePublisherDetailViewSchema,
  PluginInstallationDetailViewSchema,
  WorkspaceResourceSuccessViewSchema,
  PluginAuthSessionViewSchema,
  PluginAuditLogListSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import {
  designMarketplacePlugins,
  designPluginCategories,
  designInstalledPlugins,
  findMarketplacePlugin,
  findInstalledPlugin,
} from "../fixtures/mcp-plugins"
import type { DesignHandlers } from "./_types"

// MCP plugin marketplace + installations: catalog browse (marketplace / plugin /
// categories / organizations), the workspace install lifecycle (list / detail /
// install / update / uninstall), the plugin-auth session flow, and the audit
// log reads. These feed the plugins marketplace, install dialog, and audit pages.
//
// The three auth-session methods (startPluginAuth / getPluginAuthSession /
// inspectPluginAuthSession) have no explicit return type upstream (they do
// `return res.data`), so the session view is the realistic shape the install
// dialog consumes.
export const mcpPluginsHandlers = {
  getMarketplace: async () => designMarketplacePlugins,
  getMarketplacePlugin: async (id: string) =>
    findMarketplacePlugin(id) ?? designMarketplacePlugins[0],
  getPluginCategories: async () => designPluginCategories,
  getMcpOrganizations: async () => mock(MarketplacePublisherListViewSchema),
  getMcpOrganization: async () => mock(MarketplacePublisherDetailViewSchema),
  getInstallations: async () => designInstalledPlugins,
  getInstallation: async (_ws: string, id: string) =>
    findInstalledPlugin(id) ?? designInstalledPlugins[0],
  installPlugin: async () => mock(PluginInstallationDetailViewSchema),
  updateInstallation: async () => mock(PluginInstallationDetailViewSchema),
  uninstallPlugin: async () => mock(WorkspaceResourceSuccessViewSchema),
  startPluginAuth: async () => mock(PluginAuthSessionViewSchema),
  getPluginAuthSession: async () => mock(PluginAuthSessionViewSchema),
  inspectPluginAuthSession: async () => mock(PluginAuthSessionViewSchema),
  getMcpToolCallLogs: async () => mock(PluginAuditLogListSchema),
  getMcpEventLogs: async () => mock(PluginAuditLogListSchema),
} satisfies DesignHandlers
