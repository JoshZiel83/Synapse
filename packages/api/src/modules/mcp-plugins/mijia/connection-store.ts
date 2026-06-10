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
    .updateTable("pluginConnections")
    .set({
      secretPayload: encryptDeep(
        authState
      ) as TableInsert<"pluginConnections">["secretPayload"],
      expiresAt:
        typeof authState.expireTime === "number"
          ? new Date(authState.expireTime)
          : null,
      status: "active",
    })
    .where("id", "=", connectionId)
    .execute()
}

export async function markMijiaConnectionExpired(connectionId: string) {
  await db
    .updateTable("pluginConnections")
    .set({
      status: "expired",
    })
    .where("id", "=", connectionId)
    .execute()
}
