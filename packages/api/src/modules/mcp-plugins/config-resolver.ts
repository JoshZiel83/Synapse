import { decryptSensitiveFields } from "../../infrastructure/crypto/index.js";
import { query } from "../../infrastructure/database/index.js";
import { resolveAuthConnectionRefs } from "./auth-service.js";

export interface ResolvedPluginConfig {
  pluginId: string;
  installationId: string;
  config: Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeConfigs(...layers: Record<string, unknown>[]) {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && value !== null && value !== "") {
        result[key] = value;
      }
    }
  }
  return result;
}

export async function resolveInstallationConfig(
  installationId: string,
): Promise<ResolvedPluginConfig> {
  const result = await query<{
    catalog_item_id: string;
    config_data: unknown;
    default_config: unknown;
    config_schema: unknown;
  }>(
    `SELECT
       installation.catalog_item_id,
       installation.config_data,
       spec.default_config,
       spec.config_schema
     FROM plugin_installations installation
     JOIN plugin_package_version_specs spec
       ON spec.catalog_version_id = installation.catalog_version_id
     WHERE installation.id = $1
     LIMIT 1`,
    [installationId],
  );

  if (result.rows.length === 0) {
    return {
      pluginId: "",
      installationId,
      config: {},
    };
  }

  const row = result.rows[0]!;
  const merged = mergeConfigs(
    asObject(row.default_config),
    asObject(row.config_data),
  );
  const decrypted = decryptSensitiveFields(merged);
  const withConnections = await resolveAuthConnectionRefs(decrypted);

  return {
    pluginId: row.catalog_item_id,
    installationId,
    config: withConnections,
  };
}
