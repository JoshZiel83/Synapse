import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

export const STORAGE_DIR = process.env.STORAGE_DIR || '/home/ubuntu/project/synapse/storage/files';
export const FILE_URL_PREFIX = '/files/';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

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

/**
 * Save a buffer to disk in the date-partitioned directory.
 * Returns { storedName, sizeBytes }.
 */
export async function saveBuffer(
  buffer: Buffer,
  originalName: string,
  _mimeType: string,
): Promise<{ storedName: string; sizeBytes: number }> {
  const { year, month, day } = dateParts();
  const ext = extFromName(originalName);
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
): Promise<{ storedName: string; mimeType: string; sizeBytes: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Failed to download file: ${res.status} ${res.statusText}`);

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const mimeType = contentType.split(';')[0].trim();

    if (!originalName) {
      // Try to extract from URL path
      const urlPath = new URL(url).pathname;
      originalName = path.basename(urlPath) || 'download';
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, mimeType);

    return { storedName, mimeType, sizeBytes };
  } finally {
    clearTimeout(timeout);
  }
}
