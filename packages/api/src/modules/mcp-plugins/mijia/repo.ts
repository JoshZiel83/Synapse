/**
 * mijia sub-module repo.
 *
 * The only mijia file allowed to import the db client (guard-layering r8). Owns
 * the two pluginConnections writes; the TableInsert-cast `secretPayload` alias
 * (r2) is legal here because the basename matches /repo[^/]*\.ts$/.
 */

import { db } from "../../../infrastructure/database/kysely.js"
import type { PluginConnectionsSecretPayload } from "../repo.types.js"

export async function updateMijiaConnectionState(
  connectionId: string,
  fields: {
    secretPayload: unknown
    expiresAt: Date | null
    status: "active"
  }
): Promise<void> {
  await db
    .updateTable("pluginConnections")
    .set({
      secretPayload: fields.secretPayload as PluginConnectionsSecretPayload,
      expiresAt: fields.expiresAt,
      status: fields.status,
    })
    .where("id", "=", connectionId)
    .execute()
}

export async function markMijiaConnectionExpired(
  connectionId: string
): Promise<void> {
  await db
    .updateTable("pluginConnections")
    .set({
      status: "expired",
    })
    .where("id", "=", connectionId)
    .execute()
}
