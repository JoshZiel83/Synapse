import { query } from '../../infrastructure/database/index.js';
import { decryptSensitiveFields } from '../../infrastructure/crypto/index.js';

export interface ResolvedPluginConfig {
  pluginId: string;
  installationId: string;
  config: Record<string, unknown>;
}

/**
 * Resolve the final merged config for an installation.
 * 2-layer merge:
 *   1. Plugin default_config
 *   2. Installation config_data
 */
export async function resolveInstallationConfig(installationId: string): Promise<ResolvedPluginConfig> {
  const result = await query(
    `SELECT i.id, i.plugin_id, i.config_data,
            p.default_config, p.config_schema
     FROM mcp_installations i
     JOIN mcp_plugins p ON p.id = i.plugin_id
     WHERE i.id = $1`,
    [installationId]
  );

  if (result.rows.length === 0) {
    return { pluginId: '', installationId, config: {} };
  }

  const row = result.rows[0];
  const pluginDefault = row.default_config || {};
  const installConfig = row.config_data || {};

  // Merge: plugin defaults, then installation config overrides
  const merged = mergeConfigs(pluginDefault, installConfig);

  // Decrypt sensitive fields
  const decrypted = decryptSensitiveFields(merged);

  return {
    pluginId: row.plugin_id,
    installationId,
    config: decrypted,
  };
}

function mergeConfigs(...layers: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined && value !== null && value !== '') {
        result[key] = value;
      }
    }
  }
  return result;
}
