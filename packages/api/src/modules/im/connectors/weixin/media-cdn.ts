/**
 * Personal-WeChat (ilink) outbound media CDN upload.
 *
 * Mirrors the upstream `@tencent-weixin/openclaw-weixin` cdn/upload flow:
 *   1. getuploadurl  → pre-signed upload params (upload_full_url / upload_param)
 *   2. AES-128-ECB encrypt the plaintext bytes (PKCS7 padding)
 *   3. POST ciphertext to the CDN → `x-encrypted-param` download token
 * The returned token + aes key go into the image/video/file message item.
 *
 * NOTE: this path talks to the live WeChat CDN and AES layer and cannot be
 * exercised by unit tests — verify against a real bound account before relying
 * on outbound media. See docs/weixin-ilink-integration-audit.md.
 */

import crypto from "node:crypto"
import { postWeixinJson } from "./client.js"
import {
  buildWeixinBaseInfo,
  WEIXIN_ENDPOINTS,
  WEIXIN_UPLOAD_MEDIA_TYPE,
} from "./protocol.js"

export interface UploadedWeixinMedia {
  /** CDN download token; fill into <item>.media.encrypt_query_param. */
  encryptQueryParam: string
  /** AES-128 key, base64; fill into <item>.media.aes_key. */
  aesKeyBase64: string
  /** Plaintext size (bytes). */
  rawSize: number
  /** Ciphertext size (bytes) after AES-128-ECB PKCS7 padding. */
  cipherSize: number
}

/** AES-128-ECB ciphertext size for a given plaintext (PKCS7 to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function buildCdnUploadUrl(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string
): string {
  return `${cdnBaseUrl.replace(/\/+$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

async function getUploadUrl(params: {
  baseUrl: string
  token: string
  filekey: string
  mediaType: number
  toUserId: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  aeskeyHex: string
}): Promise<{ uploadFullUrl?: string; uploadParam?: string }> {
  const resp = await postWeixinJson({
    baseUrl: params.baseUrl,
    endpoint: WEIXIN_ENDPOINTS.GET_UPLOAD_URL,
    token: params.token,
    timeoutMs: 15_000,
    body: {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aeskeyHex,
      base_info: buildWeixinBaseInfo(),
    },
  })
  return {
    uploadFullUrl:
      typeof resp.upload_full_url === "string"
        ? resp.upload_full_url
        : undefined,
    uploadParam:
      typeof resp.upload_param === "string" ? resp.upload_param : undefined,
  }
}

const CDN_UPLOAD_MAX_RETRIES = 3

async function uploadCiphertextToCdn(params: {
  ciphertext: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  cdnBaseUrl: string
}): Promise<string> {
  const { ciphertext, uploadFullUrl, uploadParam, filekey, cdnBaseUrl } = params
  const trimmedFull = uploadFullUrl?.trim()
  let cdnUrl: string
  if (trimmedFull) {
    cdnUrl = trimmedFull
  } else if (uploadParam && cdnBaseUrl) {
    cdnUrl = buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey)
  } else {
    throw new Error(
      "Weixin CDN upload URL missing (no upload_full_url and no config.cdnBaseUrl)"
    )
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= CDN_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      })
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get("x-error-message") ?? (await res.text())
        // Client errors won't succeed on retry — surface immediately.
        throw new Error(`Weixin CDN upload client error ${res.status}: ${msg}`)
      }
      if (res.status !== 200) {
        const msg = res.headers.get("x-error-message") ?? `status ${res.status}`
        throw new Error(`Weixin CDN upload server error: ${msg}`)
      }
      const downloadParam = res.headers.get("x-encrypted-param")
      if (!downloadParam) {
        throw new Error("Weixin CDN upload response missing x-encrypted-param")
      }
      return downloadParam
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.includes("client error"))
        throw err
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(
        `Weixin CDN upload failed after ${CDN_UPLOAD_MAX_RETRIES} attempts`
      )
}

/** Upload plaintext bytes to the WeChat CDN and return the media reference. */
export async function uploadWeixinMedia(params: {
  buffer: Buffer
  toUserId: string
  mediaType: number
  baseUrl: string
  token: string
  cdnBaseUrl: string
}): Promise<UploadedWeixinMedia> {
  const { buffer, toUserId, mediaType, baseUrl, token, cdnBaseUrl } = params
  const rawsize = buffer.length
  const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex")
  const filesize = aesEcbPaddedSize(rawsize)
  const filekey = crypto.randomBytes(16).toString("hex")
  const aeskey = crypto.randomBytes(16)

  const { uploadFullUrl, uploadParam } = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType,
    toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskeyHex: aeskey.toString("hex"),
  })
  const ciphertext = encryptAesEcb(buffer, aeskey)
  const encryptQueryParam = await uploadCiphertextToCdn({
    ciphertext,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl,
  })
  return {
    encryptQueryParam,
    aesKeyBase64: aeskey.toString("base64"),
    rawSize: rawsize,
    cipherSize: filesize,
  }
}

export { WEIXIN_UPLOAD_MEDIA_TYPE }
