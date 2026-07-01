import {
  MarketplacePluginListViewSchema,
  MarketplacePluginViewSchema,
  PluginCategoryListViewSchema,
  MarketplacePublisherListViewSchema,
  MarketplacePublisherDetailViewSchema,
  PluginInstallationListViewSchema,
  PluginInstallationDetailViewSchema,
  WorkspaceResourceSuccessViewSchema,
  PluginAuthSessionViewSchema,
  PluginAuditLogListSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
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
  getMarketplace: async () => mock(MarketplacePluginListViewSchema),
  getMarketplacePlugin: async () => mock(MarketplacePluginViewSchema),
  getPluginCategories: async () => mock(PluginCategoryListViewSchema),
  getMcpOrganizations: async () => mock(MarketplacePublisherListViewSchema),
  getMcpOrganization: async () => mock(MarketplacePublisherDetailViewSchema),
  getInstallations: async () => mock(PluginInstallationListViewSchema),
  getInstallation: async () => mock(PluginInstallationDetailViewSchema),
  installPlugin: async () => mock(PluginInstallationDetailViewSchema),
  updateInstallation: async () => mock(PluginInstallationDetailViewSchema),
  uninstallPlugin: async () => mock(WorkspaceResourceSuccessViewSchema),
  startPluginAuth: async () => mock(PluginAuthSessionViewSchema),
  getPluginAuthSession: async () => mock(PluginAuthSessionViewSchema),
  inspectPluginAuthSession: async () => mock(PluginAuthSessionViewSchema),
  getMcpToolCallLogs: async () => mock(PluginAuditLogListSchema),
  getMcpEventLogs: async () => mock(PluginAuditLogListSchema),
} satisfies DesignHandlers
