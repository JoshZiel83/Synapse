import { encrypt } from "../../../infrastructure/crypto/index.js"
import type { MijiaAuthState } from "./types.js"
import { updateMijiaConnectionState } from "./repo.js"

// DB writes live in repo.ts (guard r8). Re-export to keep the public surface
// unchanged for any importer of markMijiaConnectionExpired.
export { markMijiaConnectionExpired } from "./repo.js"

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
  await updateMijiaConnectionState(connectionId, {
    secretPayload: encryptDeep(authState),
    expiresAt:
      typeof authState.expireTime === "number"
        ? new Date(authState.expireTime)
        : null,
    status: "active",
  })
}
