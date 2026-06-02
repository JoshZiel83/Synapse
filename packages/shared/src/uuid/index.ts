/**
 * Canonical RFC-4122 UUID generation + strict validation.
 *
 * Consolidated from the byte-identical implementations previously duplicated in
 * `web-next/lib/uuid.ts` (createUuid) and `mobile-app/src/lib/ids.ts` (createId).
 *
 * IMPORTANT: this is distinct from `generateId()` in `../utils` — that helper's
 * crypto-less fallback returns a NON-UUID `id_<rand>_<ts>` string. The validators
 * here (`isUuid`) are reserved for server-issued UUIDs (e.g. clientInstanceId);
 * do not feed `generateId()` / content-block ids to `isUuid`.
 *
 * Pure + dependency-free + DOM-free (probes `globalThis.crypto`), so it is safe
 * for both the Next.js web bundle and the React Native / Hermes runtime. Kept on
 * its own subpath (NOT re-exported from the root barrel) to keep the surface tight.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-")
}

function buildUuidFromRandomBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytesToUuid(bytes)
}

function createFallbackUuid(): string {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  return buildUuidFromRandomBytes(bytes)
}

/** Strict RFC-4122 (v1–v5) check. Reserved for server-issued UUIDs. */
export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

/**
 * Generate a real RFC-4122 v4 UUID. Prefers `crypto.randomUUID`, falls back to
 * `crypto.getRandomValues`, and finally to `Math.random` (still a well-formed
 * v4 UUID — unlike `generateId()`).
 */
export function createUuid(): string {
  const cryptoObj = globalThis.crypto

  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID()
  }

  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    return buildUuidFromRandomBytes(bytes)
  }

  return createFallbackUuid()
}
