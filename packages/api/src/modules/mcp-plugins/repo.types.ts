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
  TableUpdate,
} from "../../infrastructure/database/kysely.js"

export type PluginPackageVersionSpecsTransport =
  TableInsert<"pluginPackageVersionSpecs">["transport"]
export type PluginInstallationsConfigData =
  TableInsert<"pluginInstallations">["configData"]
export type CatalogCategoriesMetadata =
  TableInsert<"catalogCategories">["metadata"]

export type CatalogCategoryTableRow = TableRow<"catalogCategories">

export type PluginAuthSessionTableRow = TableRow<"pluginAuthSessions">

/**
 * Service-facing row of the `plugin_auth_sessions` table (camelCase), with
 * JSONB payload columns decoded to plain objects at repo exit.
 */
export type PluginAuthSessionRow = Omit<
  PluginAuthSessionTableRow,
  | "challengePayload"
  | "transientPayload"
  | "resultPreview"
  | "resultPayload"
  | "metadata"
> & {
  challengePayload: Record<string, unknown>
  transientPayload: Record<string, unknown>
  resultPreview: Record<string, unknown>
  resultPayload: Record<string, unknown>
  metadata: Record<string, unknown>
}

export type PluginConnectionTableRow = TableRow<"pluginConnections">

/**
 * Service-facing row of the `plugin_connections` table (camelCase) widened with
 * catalog identifiers, with JSONB payload columns decoded to plain objects at
 * repo exit. Consumed by the auth-connection helpers + presenter.
 */
export type PluginConnectionRow = Omit<
  PluginConnectionTableRow,
  "publicPayload" | "secretPayload"
> & {
  publicPayload: Record<string, unknown>
  secretPayload: Record<string, unknown>
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
 * Updateable column maps for the auth-connection write paths. The
 * plugin-auth-connections repo updaters (`updatePluginAuthSession` /
 * `updatePluginConnection`) take these so the service can keep building each
 * heterogeneous `.set({…})` patch object inline (typed against the table's
 * updatable column set, so a patch can never widen past the table) and hand it
 * to the repo to run (guard-layering r8 — only the repo touches the db client).
 */
export type PluginAuthSessionsUpdate = TableUpdate<"pluginAuthSessions">
export type PluginConnectionsUpdate = TableUpdate<"pluginConnections">

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
  metadata: Record<string, unknown>
}
