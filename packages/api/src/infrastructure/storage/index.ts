import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export const STORAGE_DIR = process.env.STORAGE_DIR || '/home/ubuntu/project/synapse/storage/files';
export const FILE_URL_PREFIX = '/files/';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
};
const PREFERRED_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heif': '.heif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};
const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4': ['.m4a', '.mp4'],
  'audio/ogg': ['.ogg'],
  'audio/wav': ['.wav'],
  'image/avif': ['.avif'],
  'image/bmp': ['.bmp'],
  'image/gif': ['.gif'],
  'image/heif': ['.heif', '.heic'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/tiff': ['.tif', '.tiff'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
};
const SHARP_FORMAT_MIME_TYPES: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

/** Ensure the root storage directory exists */
export async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

/** Date-partitioned sub-path: YYYY/MM/DD */
function dateParts(): { year: string; month: string; day: string } {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
  };
}

function extFromName(originalName: string): string {
  const idx = originalName.lastIndexOf('.');
  return idx > 0 ? originalName.slice(idx) : '';
}

export function normalizeMimeType(mimeType: string | null | undefined): string {
  const normalized = (mimeType || 'application/octet-stream')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return MIME_ALIASES[normalized] || normalized || 'application/octet-stream';
}

function extensionForMimeType(mimeType: string): string {
  return PREFERRED_EXTENSIONS[normalizeMimeType(mimeType)] || '';
}

export function normalizeOriginalNameForMimeType(
  originalName: string,
  mimeType: string,
): string {
  const allowedExtensions = MIME_EXTENSIONS[normalizeMimeType(mimeType)];
  if (!allowedExtensions || allowedExtensions.length === 0) {
    return originalName;
  }

  const currentExtension = path.extname(originalName).toLowerCase();
  if (currentExtension && allowedExtensions.includes(currentExtension)) {
    return originalName;
  }

  const baseName = currentExtension
    ? originalName.slice(0, -currentExtension.length)
    : originalName;
  return `${baseName}${allowedExtensions[0]}`;
}

function looksLikeJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function looksLikePng(buffer: Buffer): boolean {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function looksLikeGif(buffer: Buffer): boolean {
  if (buffer.length < 6) return false;
  const signature = buffer.subarray(0, 6).toString('ascii');
  return signature === 'GIF87a' || signature === 'GIF89a';
}

function looksLikeWebp(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function looksLikeTiff(buffer: Buffer): boolean {
  return buffer.length >= 4 && (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00)
    || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
  );
}

function looksLikeBmp(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

function looksLikeWav(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WAVE';
}

function looksLikeOgg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS';
}

function looksLikeMp3(buffer: Buffer): boolean {
  if (buffer.length < 3) return false;
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function looksLikeMp4Family(buffer: Buffer): string | null {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return null;
  }
  const brand = buffer.subarray(8, 12).toString('ascii');
  if (brand.startsWith('M4A')) return 'audio/mp4';
  if (brand === 'qt  ') return 'video/quicktime';
  return 'video/mp4';
}

function looksLikeWebm(buffer: Buffer): boolean {
  return buffer.length >= 4
    && buffer[0] === 0x1a
    && buffer[1] === 0x45
    && buffer[2] === 0xdf
    && buffer[3] === 0xa3;
}

function detectMimeTypeFromMagicBytes(buffer: Buffer): string | null {
  if (looksLikeJpeg(buffer)) return 'image/jpeg';
  if (looksLikePng(buffer)) return 'image/png';
  if (looksLikeGif(buffer)) return 'image/gif';
  if (looksLikeWebp(buffer)) return 'image/webp';
  if (looksLikeTiff(buffer)) return 'image/tiff';
  if (looksLikeBmp(buffer)) return 'image/bmp';
  if (looksLikePdf(buffer)) return 'application/pdf';
  if (looksLikeWav(buffer)) return 'audio/wav';
  if (looksLikeOgg(buffer)) return 'audio/ogg';
  if (looksLikeMp3(buffer)) return 'audio/mpeg';
  const mp4MimeType = looksLikeMp4Family(buffer);
  if (mp4MimeType) return mp4MimeType;
  if (looksLikeWebm(buffer)) return 'video/webm';
  return null;
}

async function detectImageMimeType(buffer: Buffer): Promise<string | null> {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(buffer, { animated: true }).metadata();
    return metadata.format ? SHARP_FORMAT_MIME_TYPES[metadata.format] || null : null;
  } catch {
    return null;
  }
}

export async function resolveBufferMimeType(
  buffer: Buffer,
  claimedMimeType?: string | null,
): Promise<string> {
  const normalizedClaimedMimeType = normalizeMimeType(claimedMimeType);
  const detectedFromMagicBytes = detectMimeTypeFromMagicBytes(buffer);
  const detectedMimeType = detectedFromMagicBytes
    || (normalizedClaimedMimeType.startsWith('image/')
      ? await detectImageMimeType(buffer)
      : null);

  if (detectedMimeType && detectedMimeType !== normalizedClaimedMimeType) {
    console.warn(`[storage] Corrected MIME type from ${normalizedClaimedMimeType} to ${detectedMimeType}`);
    return detectedMimeType;
  }

  return detectedMimeType || normalizedClaimedMimeType;
}

/**
 * Save a buffer to disk in the date-partitioned directory.
 * Returns { storedName, sizeBytes }.
 */
export async function saveBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<{ storedName: string; sizeBytes: number }> {
  const { year, month, day } = dateParts();
  const ext = extensionForMimeType(mimeType) || extFromName(originalName);
  const uuid = crypto.randomUUID();
  const storedName = path.join(year, month, day, `${uuid}${ext}`);
  const fullPath = path.join(STORAGE_DIR, storedName);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);

  return { storedName, sizeBytes: buffer.length };
}

/** Relative URL: /files/YYYY/MM/DD/uuid.ext */
export function getFileUrl(storedName: string): string {
  return FILE_URL_PREFIX + storedName;
}

/** Absolute URL: http://{BASE_URL}/files/... */
export function getFullUrl(storedName: string): string {
  return BASE_URL + FILE_URL_PREFIX + storedName;
}

/** Read a stored file back as a Buffer */
export async function readAsBuffer(storedName: string): Promise<Buffer> {
  const fullPath = path.join(STORAGE_DIR, storedName);
  return fs.readFile(fullPath);
}

/** Read a stored file back as a base64 string */
export async function readAsBase64(storedName: string): Promise<string> {
  const buf = await readAsBuffer(storedName);
  return buf.toString('base64');
}

/** Download a remote URL, save to disk, return metadata */
export async function downloadAndSave(
  url: string,
  originalName?: string,
): Promise<{ storedName: string; mimeType: string; sizeBytes: number; originalName: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);

    const contentType = res.headers.get('content-type');

    if (!originalName) {
      // Try to extract from URL path
      const urlPath = new URL(url).pathname;
      originalName = path.basename(urlPath) || 'download';
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const mimeType = await resolveBufferMimeType(buffer, contentType);
    const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, mimeType);

    return { storedName, mimeType, sizeBytes, originalName };
  } finally {
    clearTimeout(timeout);
  }
}
