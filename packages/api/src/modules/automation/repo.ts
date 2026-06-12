// automation/repo.ts — DB-touching helpers for the automation module.
//
// The only automation file (alongside repo.types.ts) permitted to import the db
// client (guard r8). Owns the integration-installation row read. Business
// mapping (JSON decode via asObject, decryptSensitiveFields, provider
// resolution) stays in integrations.ts so the repo is a thin row-reader.
// round-6 P1-6.

import { db } from "../../infrastructure/database/kysely.js"

/**
 * Raw integration-installation row projection. Columns are selected with
 * explicit camelCase `as` aliases (so the CamelCasePlugin is moot). No Date
 * columns are projected; configData/specMetadata are raw JSONB left as
 * `unknown` and decoded by the service.
 */
export type IntegrationInstallationRow = {
  installationId: string
  workspaceId: string
  installationStatus: "active" | "disabled" | "error" | "archived"
  configData: unknown
  orgSlug: string
  itemSlug: string
  specMetadata: unknown
}

/**
 * Read one integration installation for a workspace, scoped to non-deleted
 * workspace apps. Returns the raw camelCase row (no JSON decode / decryption).
 */
export async function selectIntegrationInstallationRow(
  workspaceId: string,
  installationId: string
): Promise<IntegrationInstallationRow | undefined> {
  return (await db
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .innerJoin("catalogItems as item", "item.id", "installation.catalogItemId")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisherId")
    .innerJoin(
      "pluginPackageVersionSpecs as spec",
      "spec.catalogVersionId",
      "installation.catalogVersionId"
    )
    .select([
      "installation.id as installationId",
      "app.workspaceId as workspaceId",
      "app.status as installationStatus",
      "installation.configData",
      "publisher.slug as orgSlug",
      "item.slug as itemSlug",
      "spec.metadata as specMetadata",
    ])
    .where("installation.id", "=", installationId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()) as IntegrationInstallationRow | undefined
}
