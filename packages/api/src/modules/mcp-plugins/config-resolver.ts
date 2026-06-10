import { decryptSensitiveFields } from "../../infrastructure/crypto/index.js"
import { db } from "../../infrastructure/database/kysely.js"
import { resolveAuthConnectionRefs } from "./plugin-auth-connections.js"
import { PLUGIN_INSTALLATION_LIVE_STATUSES } from "./live-status.js"

export interface ResolvedPluginConfig {
  pluginId: string
  installationId: string
  config: Record<string, unknown>
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mergeConfigs(...layers: Record<string, unknown>[]) {
  const result: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && value !== null && value !== "") {
        result[key] = value
      }
    }
  }
  return result
}

export async function resolveInstallationConfig(
  installationId: string
): Promise<ResolvedPluginConfig> {
  const row = await db
    // Live predicate (review F16): exclude tombstoned AND non-live status
    // (archived) installs — same definition as plugin_installations_live /
    // manifest liveValues. Read the base table (not the _live view) so the NOT
    // NULL column types are preserved (views type every column nullable).
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .innerJoin(
      "pluginPackageVersionSpecs as spec",
      "spec.catalogVersionId",
      "installation.catalogVersionId"
    )
    .select([
      "installation.catalogItemId",
      "installation.configData",
      "spec.defaultConfig",
      "spec.configSchema",
    ])
    .where("installation.id", "=", installationId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "in", PLUGIN_INSTALLATION_LIVE_STATUSES)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    return {
      pluginId: "",
      installationId,
      config: {},
    }
  }

  const merged = mergeConfigs(
    asObject(row.defaultConfig),
    asObject(row.configData)
  )
  const decrypted = decryptSensitiveFields(merged)
  const withConnections = await resolveAuthConnectionRefs(decrypted)

  return {
    pluginId: row.catalogItemId,
    installationId,
    config: withConnections,
  }
}
