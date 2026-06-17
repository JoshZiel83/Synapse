/**
 * Personal-WeChat (ilink) inbound media download + AES-128-ECB decrypt.
 *
 * Mirrors the upstream `@tencent-weixin/openclaw-weixin` cdn/pic-decrypt flow:
 * fetch the encrypted bytes from the CDN (server-returned `full_url`, or a
 * fallback URL built from `encrypt_query_param` + a configured cdnBaseUrl),
 * then AES-128-ECB decrypt with the per-item key. Images may arrive
 * unencrypted (no key) — those are returned as-is.
 */

import crypto from "node:crypto"

/** Cap inbound media downloads (matches upstream's 100 MB guard). */
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024

function buildCdnDownloadUrl(
  encryptQueryParam: string,
  cdnBaseUrl: string
): string {
  return `${cdnBaseUrl.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
}

/**
 * Parse a CDNMedia aes_key into a raw 16-byte AES key. Two encodings occur:
 *   - base64(raw 16 bytes)           → images (from media.aes_key)
 *   - base64(hex string of 16 bytes) → file / voice / video
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64")
  if (decoded.length === 16) return decoded
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex")
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or a 32-char hex string`
  )
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Fetch raw bytes from a URL, aborting past `maxBytes` (streaming guard). */
async function fetchCdnBytes(
  url: string,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText}`)
  }
  const declared = Number(res.headers.get("content-length") || "0")
  if (declared > maxBytes) {
    throw new Error(`${label}: media exceeds ${maxBytes} byte limit`)
  }
  if (!res.body) throw new Error(`${label}: empty CDN response`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${label}: media exceeds ${maxBytes} byte limit`)
    }
    chunks.push(value)
  }
  if (total === 0) throw new Error(`${label}: empty media`)
  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

/**
 * Download (and decrypt, when an aes key is present) one inbound media item.
 * Prefers the server-returned `fullUrl`; falls back to building a URL from
 * `encryptQueryParam` + `cdnBaseUrl` (throws if neither is available).
 */
export async function downloadAndDecryptWeixinMedia(params: {
  encryptQueryParam?: string
  aesKeyBase64?: string
  fullUrl?: string
  cdnBaseUrl: string
  maxBytes?: number
  label: string
}): Promise<Buffer> {
  const { encryptQueryParam, aesKeyBase64, fullUrl, cdnBaseUrl, label } = params
  const maxBytes = params.maxBytes ?? WEIXIN_MEDIA_MAX_BYTES

  let url: string
  if (fullUrl?.trim()) {
    url = fullUrl.trim()
  } else if (encryptQueryParam && cdnBaseUrl) {
    url = buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl)
  } else {
    throw new Error(
      `${label}: no full_url and no config.cdnBaseUrl to build a download URL`
    )
  }

  const encrypted = await fetchCdnBytes(url, maxBytes, label)
  if (!aesKeyBase64) return encrypted // unencrypted (e.g. some images)
  return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64, label))
}
