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
