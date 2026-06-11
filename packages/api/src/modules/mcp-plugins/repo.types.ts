/**
 * mcp-plugins module repo types.
 *
 * The only mcp-plugins service-facing file allowed to reference
 * `TableInsert<...>` (guard-layering r2). Groups the JSONB / enum column-type
 * aliases so service.ts can cast payloads (`as PluginInstallationsConfigData`,
 * etc.) without writing `TableInsert<...>` inline. See §10.1.
 */

import type {
  TableInsert,
  TableRow,
} from "../../infrastructure/database/kysely.js"

export type PluginPackageVersionSpecsTransport =
  TableInsert<"pluginPackageVersionSpecs">["transport"]
export type PluginInstallationsConfigData =
  TableInsert<"pluginInstallations">["configData"]
export type CatalogCategoriesMetadata =
  TableInsert<"catalogCategories">["metadata"]

/**
 * Selectable row of the `plugin_auth_sessions` table (camelCase). Consumed by
 * the auth-connection helpers + presenter; the alias lives here so the helper
 * file (plugin-auth-connections.ts) and presenter.ts never reference
 * `TableRow<…>` directly (guard-layering r2).
 */
export type PluginAuthSessionRow = TableRow<"pluginAuthSessions">

/**
 * Selectable row of the `plugin_connections` table (camelCase) widened with the
 * catalog identifiers the connection helpers join in. Consumed by the
 * auth-connection helpers + presenter.
 */
export type PluginConnectionRow = TableRow<"pluginConnections"> & {
  catalogItemId: string
  catalogVersionId: string | null
}

// JSONB / enum column-type aliases for the auth-connection write paths so
// plugin-auth-connections.ts and mijia/connection-store.ts can cast payloads
// without writing `TableInsert<…>["col"]` inline (guard-layering r2).
export type PluginConnectionsSecretPayload =
  TableInsert<"pluginConnections">["secretPayload"]
export type PluginConnectionsPublicPayload =
  TableInsert<"pluginConnections">["publicPayload"]
export type PluginAuthSessionsResultPreview =
  TableInsert<"pluginAuthSessions">["resultPreview"]
export type PluginAuthSessionsResultPayload =
  TableInsert<"pluginAuthSessions">["resultPayload"]
export type PluginAuthSessionsChallengePayload =
  TableInsert<"pluginAuthSessions">["challengePayload"]
export type PluginAuthSessionsTransientPayload =
  TableInsert<"pluginAuthSessions">["transientPayload"]
export type PluginAuthSessionsMetadata =
  TableInsert<"pluginAuthSessions">["metadata"]

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
