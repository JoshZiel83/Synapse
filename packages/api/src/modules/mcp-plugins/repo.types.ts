/**
 * mcp-plugins module repo types.
 *
 * The only mcp-plugins service-facing file allowed to reference
 * `TableInsert<...>` (guard-layering r2). Groups the JSONB / enum column-type
 * aliases so service.ts can cast payloads (`as PluginInstallationsConfigData`,
 * etc.) without writing `TableInsert<...>` inline. See §10.1.
 */

import type { TableInsert } from "../../infrastructure/database/kysely.js"

export type PluginPackageVersionSpecsTransport =
  TableInsert<"pluginPackageVersionSpecs">["transport"]
export type PluginInstallationsConfigData =
  TableInsert<"pluginInstallations">["configData"]
export type CatalogCategoriesMetadata =
  TableInsert<"catalogCategories">["metadata"]

/**
 * Domain record the publisher presenter consumes (the camelCase publisher row
 * plus the COUNT(plugin) aggregate that listOrganizations projects). Hand-written
 * structural shape — no generated/db import lands here — so both service.ts (which
 * builds these rows) and presenter.ts (which shapes them into MarketplacePublisherView)
 * can take it via `import type`.
 */
export type PublisherRecord = {
  id: string
  slug: string
  displayName: string
  description: string | null
  logoFileId: string | null
  ownerUserId: string | null
  workspaceId: string | null
  isBuiltin: boolean | null
  isVerified: boolean | null
  createdAt: Date
  updatedAt: Date
  pluginCount?: string | number | null
}

/**
 * Domain record the plugin-category presenter consumes (the camelCase
 * catalog_categories row, item_kind = 'plugin_package').
 */
export type PluginCategoryRecord = {
  id: string
  slug: string
  displayName: string
  description: string | null
  sortOrder: number
  metadata: unknown
}
