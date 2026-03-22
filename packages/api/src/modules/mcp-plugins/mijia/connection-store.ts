import { encrypt } from "../../../infrastructure/crypto/index.js";
import { query } from "../../../infrastructure/database/index.js";
import type { MijiaAuthState } from "./types.js";

function encryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return encrypt(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => encryptDeep(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = encryptDeep(nested);
    }
    return result;
  }
  return value;
}

export async function persistMijiaConnectionState(
  connectionId: string,
  authState: MijiaAuthState,
) {
  await query(
    `UPDATE plugin_connections
     SET secret_payload = $2::jsonb,
         expires_at = $3,
         status = 'active',
         updated_at = NOW()
     WHERE id = $1`,
    [
      connectionId,
      JSON.stringify(encryptDeep(authState)),
      typeof authState.expireTime === "number"
        ? new Date(authState.expireTime).toISOString()
        : null,
    ],
  );
}

export async function markMijiaConnectionExpired(connectionId: string) {
  await query(
    `UPDATE plugin_connections
     SET status = 'expired',
         updated_at = NOW()
     WHERE id = $1`,
    [connectionId],
  );
}
