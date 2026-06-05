import { decryptSensitiveFields } from "../../infrastructure/crypto/index.js"
import { db } from "../../infrastructure/database/kysely.js"
import { resolveAuthConnectionRefs } from "./plugin-auth-connections.js"

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
    .selectFrom("plugin_installations as installation")
    .innerJoin(
      "plugin_package_version_specs as spec",
      "spec.catalog_version_id",
      "installation.catalog_version_id"
    )
    .select([
      "installation.catalog_item_id",
      "installation.config_data",
      "spec.default_config",
      "spec.config_schema",
    ])
    .where("installation.id", "=", installationId)
    .where("installation.deleted_at", "is", null)
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
    asObject(row.default_config),
    asObject(row.config_data)
  )
  const decrypted = decryptSensitiveFields(merged)
  const withConnections = await resolveAuthConnectionRefs(decrypted)

  return {
    pluginId: row.catalog_item_id,
    installationId,
    config: withConnections,
  }
}
