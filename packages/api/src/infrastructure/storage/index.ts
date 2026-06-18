import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { assertPublicHost, ssrfSafeDispatcher } from "./ssrf.js"
import { createLogger } from "../logger/index.js"

const log = createLogger("storage")

// Production deployments inject STORAGE_DIR via the API container env
// (docker-compose.yml sets /app/storage/files mounted to api_storage:).
// The default below is only used by local dev / tests where the env var
// is unset — it lives under os.tmpdir() to avoid writing into the source
// tree or stale hardcoded paths.
export const STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "synapse-storage")
// Shared content-addressed store root. The file-service refactor stores all
// blobs content-addressed (blobs/<aa>/<sha256>), the SAME layout the Rust
// fs-helper uses, so in topology A the API and the sandbox helpers share one
// CAS volume (env CONTENT_STORE_DIR overrides; defaults under STORAGE_DIR).
export const CONTENT_STORE_DIR =
  process.env.CONTENT_STORE_DIR || path.join(STORAGE_DIR, "cas")
// Entity-asset read endpoint: GET /api/v1/files/<assetId>. Mounted under
// /api/v1 (modules/files/index.ts) so it rides the same proxy every other
// API route uses (Next dev rewrite of /api/v1/* + prod nginx `location
// /api/`); a bare /files/ would not be proxied to the API. Keep this prefix
// in lockstep with the route registration.
export const FILE_URL_PREFIX = "/api/v1/files/"
// Content-addressed read endpoint: GET /api/v1/content/<sha256>. Distinct from
// /api/v1/files/<assetId> (entity assets by id). file_ref blocks render by
// sha. Same /api/v1 rationale as above.
export const CONTENT_URL_PREFIX = "/api/v1/content/"
export const BASE_URL = (
  process.env.BASE_URL || "http://localhost:3001"
).replace(/\/+$/, "")
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
}
const MIME_EXTENSIONS: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "audio/mpeg": [".mp3"],
  "audio/mp4": [".m4a", ".mp4"],
  "audio/ogg": [".ogg"],
  "audio/wav": [".wav"],
  "image/avif": [".avif"],
  "image/bmp": [".bmp"],
  "image/gif": [".gif"],
  "image/heif": [".heif", ".heic"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/tiff": [".tif", ".tiff"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
}
const SHARP_FORMAT_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  jpeg: "image/jpeg",
  png: "image/png",
  tiff: "image/tiff",
  webp: "image/webp",
}

/** Ensure the root storage directory exists */
export async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true })
}

export function normalizeMimeType(mimeType: string | null | undefined): string {
  const normalized = (mimeType || "application/octet-stream")
    .split(";", 1)[0]
    .trim()
    .toLowerCase()
  return MIME_ALIASES[normalized] || normalized || "application/octet-stream"
}

export function normalizeOriginalNameForMimeType(
  originalName: string,
  mimeType: string
): string {
  const allowedExtensions = MIME_EXTENSIONS[normalizeMimeType(mimeType)]
  if (!allowedExtensions || allowedExtensions.length === 0) {
    return originalName
  }

  const currentExtension = path.extname(originalName).toLowerCase()
  if (currentExtension && allowedExtensions.includes(currentExtension)) {
    return originalName
  }

  const baseName = currentExtension
    ? originalName.slice(0, -currentExtension.length)
    : originalName
  return `${baseName}${allowedExtensions[0]}`
}

function looksLikeJpeg(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
}

function looksLikePng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  )
}

function looksLikeGif(buffer: Buffer): boolean {
  if (buffer.length < 6) return false
  const signature = buffer.subarray(0, 6).toString("ascii")
  return signature === "GIF87a" || signature === "GIF89a"
}

function looksLikeWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
}

function looksLikeTiff(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x2a &&
      buffer[3] === 0x00) ||
      (buffer[0] === 0x4d &&
        buffer[1] === 0x4d &&
        buffer[2] === 0x00 &&
        buffer[3] === 0x2a))
  )
}

function looksLikeBmp(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d
}

function looksLikePdf(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  )
}

function looksLikeWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  )
}

function looksLikeOgg(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS"
  )
}

function looksLikeMp3(buffer: Buffer): boolean {
  if (buffer.length < 3) return false
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return true
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0
}

function looksLikeMp4Family(buffer: Buffer): string | null {
  if (
    buffer.length < 12 ||
    buffer.subarray(4, 8).toString("ascii") !== "ftyp"
  ) {
    return null
  }
  const brand = buffer.subarray(8, 12).toString("ascii")
  if (brand.startsWith("M4A")) return "audio/mp4"
  if (brand === "qt  ") return "video/quicktime"
  // HEIF/HEIC and AVIF are also ISO-BMFF (ftyp) containers — detect their
  // brands so the magic-byte sniffer matches the MIME tables that already
  // advertise image/heif and image/avif (previously these fell through to
  // video/mp4).
  if (brand === "avif" || brand === "avis") return "image/avif"
  if (
    brand === "heic" ||
    brand === "heix" ||
    brand === "heif" ||
    brand === "mif1" ||
    brand === "msf1"
  ) {
    return "image/heif"
  }
  return "video/mp4"
}

function looksLikeWebm(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  )
}

function detectMimeTypeFromMagicBytes(buffer: Buffer): string | null {
  if (looksLikeJpeg(buffer)) return "image/jpeg"
  if (looksLikePng(buffer)) return "image/png"
  if (looksLikeGif(buffer)) return "image/gif"
  if (looksLikeWebp(buffer)) return "image/webp"
  if (looksLikeTiff(buffer)) return "image/tiff"
  if (looksLikeBmp(buffer)) return "image/bmp"
  if (looksLikePdf(buffer)) return "application/pdf"
  if (looksLikeWav(buffer)) return "audio/wav"
  if (looksLikeOgg(buffer)) return "audio/ogg"
  if (looksLikeMp3(buffer)) return "audio/mpeg"
  const mp4MimeType = looksLikeMp4Family(buffer)
  if (mp4MimeType) return mp4MimeType
  if (looksLikeWebm(buffer)) return "video/webm"
  return null
}

async function detectImageMimeType(buffer: Buffer): Promise<string | null> {
  try {
    const sharp = (await import("sharp")).default
    const metadata = await sharp(buffer, { animated: true }).metadata()
    return metadata.format
      ? SHARP_FORMAT_MIME_TYPES[metadata.format] || null
      : null
  } catch {
    return null
  }
}

export async function resolveBufferMimeType(
  buffer: Buffer,
  claimedMimeType?: string | null
): Promise<string> {
  const normalizedClaimedMimeType = normalizeMimeType(claimedMimeType)
  const detectedFromMagicBytes = detectMimeTypeFromMagicBytes(buffer)
  const detectedMimeType =
    detectedFromMagicBytes ||
    (normalizedClaimedMimeType.startsWith("image/")
      ? await detectImageMimeType(buffer)
      : null)

  if (detectedMimeType && detectedMimeType !== normalizedClaimedMimeType) {
    log.warn(
      `[storage] Corrected MIME type from ${normalizedClaimedMimeType} to ${detectedMimeType}`
    )
    return detectedMimeType
  }

  return detectedMimeType || normalizedClaimedMimeType
}

export function getStableFileUrl(fileId: string): string {
  return `${FILE_URL_PREFIX}${fileId}`
}

export function getStableFullFileUrl(fileId: string): string {
  return `${BASE_URL}${getStableFileUrl(fileId)}`
}

/**
 * Default hard cap for the generic `downloadToBuffer` entry (50 MiB). Callers
 * that need a different cap should use `downloadToBufferWithLimit` directly.
 */
const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024

/**
 * Download a remote URL into memory, resolving MIME type and fallback filename.
 *
 * SSRF- and OOM-safe: it delegates to `downloadToBufferWithLimit`, so it always
 * runs the SSRF host check (rejecting private/loopback/link-local targets and
 * pinning the validated IP) and always streams with a size cap. Remote-supplied
 * URLs (MCP/Zhipu results, IM media) flow through here safely.
 */
export async function downloadToBuffer(
  url: string,
  originalName?: string
): Promise<{
  buffer: Buffer
  mimeType: string
  sizeBytes: number
  originalName: string
}> {
  return downloadToBufferWithLimit({
    url,
    originalName,
    maxBytes: DEFAULT_DOWNLOAD_MAX_BYTES,
  })
}

/**
 * Strict, signature-explicit variant of `downloadToBuffer`:
 *  - `maxBytes` is required (no accidental unbounded reads)
 *  - validates initial URL host against `allowedHosts` if provided
 *  - manually follows redirects (max 5 hops) and re-validates every hop
 *    against `allowedHosts` — relevant for CDNs that redirect to short-
 *    lived signed URLs on a different host
 *  - pre-checks `Content-Length` against `maxBytes` before reading
 *  - streams the body, aborts as soon as the accumulated size would
 *    exceed `maxBytes`
 *
 * Used by the QQ connector for inbound media ingest, where attachment
 * URLs are short-lived CDN links that could legitimately point anywhere
 * under the QQ media domain but should never exceed UPLOAD_SIZE_LIMITS.
 */
export interface DownloadToBufferWithLimitOpts {
  url: string
  /** Hard cap on body size in bytes. Required to prevent OOM. */
  maxBytes: number
  originalName?: string
  /**
   * Lowercased host whitelist. When provided, both the initial URL and
   * every redirect target's host must appear in this list. Subdomains
   * are NOT auto-allowed — list each explicitly. An empty/omitted list
   * means "no host allowlist" — but the SSRF check (reject hosts that
   * resolve to private/loopback/link-local/reserved addresses) ALWAYS
   * runs regardless.
   */
  allowedHosts?: string[]
  /**
   * Opt out of the private/loopback/link-local SSRF block. Default false.
   * Only set this for downloads whose URL is fully trusted/internal (e.g.
   * tests against a local server, or an explicitly-configured internal host).
   * Remote-supplied URLs must NEVER set this.
   */
  allowPrivateHosts?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Extra request headers sent on the initial request AND on every
   * redirect hop — e.g. `{ Authorization: "Bearer …" }` for WhatsApp
   * Cloud media downloads, whose binary CDN GET requires the Graph API
   * bearer token (the `downloadToBufferWithLimit` callers for Telegram
   * use unauthenticated file URLs and omit this).
   *
   * SECURITY: when these headers carry a credential, the caller MUST
   * also pass `allowedHosts` so the credential can only ever be sent to
   * an explicitly-listed host. Without an allowlist a redirect could
   * forward the credential to an arbitrary public host.
   */
  headers?: Record<string, string>
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

export async function downloadToBufferWithLimit(
  opts: DownloadToBufferWithLimitOpts
): Promise<{
  buffer: Buffer
  mimeType: string
  sizeBytes: number
  originalName: string
}> {
  const {
    url,
    maxBytes,
    allowedHosts,
    allowPrivateHosts,
    timeoutMs,
    signal,
    headers,
  } = opts
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("downloadToBufferWithLimit: maxBytes must be > 0")
  }

  const checkHost = async (target: string) => {
    let host: string
    try {
      host = new URL(target).hostname.toLowerCase()
    } catch {
      throw new Error(`downloadToBufferWithLimit: invalid URL: ${target}`)
    }
    // Optional allowlist first (cheap, no I/O): when provided, the host must be
    // on it. Subdomains are NOT auto-allowed — list each explicitly.
    if (
      allowedHosts &&
      allowedHosts.length > 0 &&
      !allowedHosts.includes(host)
    ) {
      throw new Error(
        `downloadToBufferWithLimit: host ${host} not in allowedHosts`
      )
    }
    // SSRF defense: ALWAYS reject hosts that are (or resolve to) non-public
    // addresses, regardless of whether an allowlist was supplied. This closes
    // the previous gap where an empty/missing allowedHosts meant "no check".
    // Skipped only when the caller explicitly trusts the target.
    if (!allowPrivateHosts) {
      try {
        await assertPublicHost(host)
      } catch (error) {
        throw new Error(
          `downloadToBufferWithLimit: ${(error as Error).message}`
        )
      }
    }
  }

  const controller = new AbortController()
  const linkedSignal = signal
  const linkAbort = () => controller.abort()
  if (linkedSignal) {
    if (linkedSignal.aborted) controller.abort()
    else linkedSignal.addEventListener("abort", linkAbort, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  )

  let currentUrl = url
  let res: Response | undefined
  // Pin the SSRF-validated IP to the actual connection (closes the DNS-
  // rebinding window between the pre-flight assertPublicHost and connect).
  const dispatcher = ssrfSafeDispatcher(allowPrivateHosts === true)

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await checkHost(currentUrl)
      res = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        dispatcher,
        ...(headers ? { headers } : {}),
      } as RequestInit & { dispatcher: typeof dispatcher })
      // Manual redirect handling: only follow if explicit Location header
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location")
        if (!location) {
          throw new Error(
            `downloadToBufferWithLimit: redirect without Location header (status ${res.status})`
          )
        }
        if (hop === MAX_REDIRECTS) {
          throw new Error(
            `downloadToBufferWithLimit: too many redirects (>${MAX_REDIRECTS})`
          )
        }
        currentUrl = new URL(location, currentUrl).toString()
        // Discard the redirect body WITHOUT buffering it — a malicious server
        // could attach a huge body to a 3xx to blow past maxBytes if we read
        // it. cancel() frees the stream/connection without reading bytes.
        await res.body?.cancel().catch(() => undefined)
        continue
      }
      break
    }

    if (!res || !res.ok) {
      throw new Error(
        `downloadToBufferWithLimit: failed to download: ${res?.status} ${res?.statusText}`
      )
    }

    // Content-Length precheck — abort early if server declared > maxBytes
    const contentLength = res.headers.get("content-length")
    if (contentLength) {
      const declared = Number.parseInt(contentLength, 10)
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort()
        throw new Error(
          `downloadToBufferWithLimit: declared size ${declared} > maxBytes ${maxBytes}`
        )
      }
    }

    const contentType = res.headers.get("content-type")

    let originalName = opts.originalName
    if (!originalName) {
      const urlPath = new URL(currentUrl).pathname
      originalName = path.basename(urlPath) || "download"
    }

    if (!res.body) {
      throw new Error("downloadToBufferWithLimit: response has no body")
    }

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        controller.abort()
        reader.cancel().catch(() => undefined)
        throw new Error(
          `downloadToBufferWithLimit: body exceeded maxBytes ${maxBytes}`
        )
      }
      chunks.push(value)
    }

    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    const mimeType = await resolveBufferMimeType(buffer, contentType)
    return { buffer, mimeType, sizeBytes: buffer.length, originalName }
  } finally {
    clearTimeout(timer)
    if (linkedSignal) {
      linkedSignal.removeEventListener("abort", linkAbort)
    }
  }
}
