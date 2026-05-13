import { encrypt } from "../../../infrastructure/crypto/index.js"
import {
  db,
  type TableInsert,
} from "../../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import type { MijiaAuthState } from "./types.js"

function encryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return encrypt(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => encryptDeep(item))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = encryptDeep(nested)
    }
    return result
  }
  return value
}

export async function persistMijiaConnectionState(
  connectionId: string,
  authState: MijiaAuthState
) {
  await db
    .updateTable("plugin_connections")
    .set({
      secret_payload: encryptDeep(
        authState
      ) as TableInsert<"plugin_connections">["secret_payload"],
      expires_at:
        typeof authState.expireTime === "number"
          ? new Date(authState.expireTime).toISOString()
          : null,
      status: "active",
      updated_at: sql`NOW()`,
    })
    .where("id", "=", connectionId)
    .execute()
}

export async function markMijiaConnectionExpired(connectionId: string) {
  await db
    .updateTable("plugin_connections")
    .set({
      status: "expired",
      updated_at: sql`NOW()`,
    })
    .where("id", "=", connectionId)
    .execute()
}
