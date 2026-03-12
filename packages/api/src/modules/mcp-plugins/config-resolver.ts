import { query } from '../../infrastructure/database/index.js';
import { decryptSensitiveFields } from '../../infrastructure/crypto/index.js';
import { resolveAuthConnectionRefs } from './auth-service.js';

export interface ResolvedPluginConfig {
  pluginId: string;
  installationId: string;
  config: Record<string, unknown>;
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

/**
 * Resolve the final merged config for a capability binding.
 * 2-layer merge:
 *   1. Revision default_config
 *   2. Binding config_data
 */
export async function resolveInstallationConfig(installationId: string): Promise<ResolvedPluginConfig> {
  const result = await query(
    `SELECT
        b.id,
        b.package_id,
        b.config_data,
        r.default_config,
        r.config_schema
     FROM capability_bindings b
     JOIN capability_package_revisions r ON r.id = b.revision_id
     WHERE b.id = $1`,
    [installationId],
  );

  if (result.rows.length === 0) {
    return { pluginId: '', installationId, config: {} };
  }

  const row = result.rows[0];
  const revisionDefault = row.default_config || {};
  const bindingConfig = row.config_data || {};
  const merged = mergeConfigs(revisionDefault, bindingConfig);
  const decrypted = decryptSensitiveFields(merged);
  const withConnections = await resolveAuthConnectionRefs(decrypted);

  return {
    pluginId: row.package_id,
    installationId,
    config: withConnections,
  };
}
