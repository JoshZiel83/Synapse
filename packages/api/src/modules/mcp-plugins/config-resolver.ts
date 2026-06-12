import { parseJsonObject } from "@synapse/shared"
import { decryptSensitiveFields } from "../../infrastructure/crypto/index.js"
import { resolveAuthConnectionRefs } from "./plugin-auth-connections.js"
import { findInstallationConfigRow } from "./repo.js"

export interface ResolvedPluginConfig {
  pluginId: string
  installationId: string
  config: Record<string, unknown>
}

// Business JSON decode → shared parseJsonObject (string-parse + array-reject;
// replaces a local copy that blindly cast JSON.parse, accepting arrays). r6 P1-8.
const asObject = parseJsonObject

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
  const row = await findInstallationConfigRow(installationId)

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
