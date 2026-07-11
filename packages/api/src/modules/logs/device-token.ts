// Short-lived device log-ingest token.
//
// device-runtime / remote-agent-daemon authenticate to the control plane via
// Ed25519 challenge-response (no bearer token). To let them ship logs over the
// plain HTTP ingest endpoint, the server mints a SHORT-LIVED, stateless,
// HMAC-signed token AFTER a successful device.hello and hands it back in the
// hello ack. The device then sends it as `Authorization: Bearer <token>` to
// POST /api/v1/logs. Stateless (no DB row) — verified purely by HMAC + expiry.
//
// Gated on SYNAPSE_LOG_INGEST_SECRET: if unset, minting/verification return null
// so device log回传 is simply disabled (safe default, env-driven, no hardcode).
import { createHmac, timingSafeEqual } from "node:crypto"

const SECRET = process.env.SYNAPSE_LOG_INGEST_SECRET
// Tokens are re-minted on every hello/reconnect, so a short TTL is fine.
const TTL_MS = 12 * 60 * 60 * 1000 // 12h

interface RuntimeLogTokenPayload {
  d: string // runtimeId
  s: string // serviceId
  exp: number // epoch ms
}

function sign(body: string): string {
  return createHmac("sha256", SECRET as string)
    .update(body)
    .digest("base64url")
}

/** Mint a device log-ingest token, or null when ingest is not configured. */
export function mintRuntimeLogToken(
  runtimeId: string,
  serviceId: string,
  nowMs: number
): string | null {
  if (!SECRET) return null
  const payload: RuntimeLogTokenPayload = {
    d: runtimeId,
    s: serviceId,
    exp: nowMs + TTL_MS,
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  )
  return `${body}.${sign(body)}`
}

/** Verify a device log-ingest token; returns the device/service or null. */
export function verifyRuntimeLogToken(
  token: string,
  nowMs: number
): { runtimeId: string; serviceId: string } | null {
  if (!SECRET) return null
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(body)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as RuntimeLogTokenPayload
    if (typeof payload.exp !== "number" || payload.exp < nowMs) return null
    if (typeof payload.d !== "string" || typeof payload.s !== "string") {
      return null
    }
    return { runtimeId: payload.d, serviceId: payload.s }
  } catch {
    return null
  }
}
