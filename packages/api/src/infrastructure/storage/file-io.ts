import { query } from '../database/index.js';
import {
  saveBuffer,
  getFileUrl,
  getFullUrl,
  readAsBuffer,
  readAsBase64,
  downloadAndSave,
} from './index.js';

export interface FileRecord {
  id: string;
  url: string;
  fullUrl: string;
  storedName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Insert a row in the files table and return a FileRecord */
async function insertFileRow(
  workspaceId: string | null,
  uploaderUserId: string | null,
  originalName: string,
  storedName: string,
  mimeType: string,
  sizeBytes: number,
  category: string = 'general',
): Promise<FileRecord> {
  const result = await query(
    `INSERT INTO files (workspace_id, uploader_user_id, original_name, stored_name, mime_type, size_bytes, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [workspaceId, uploaderUserId, originalName, storedName, mimeType, sizeBytes, category],
  );
  return {
    id: result.rows[0].id,
    url: getFileUrl(storedName),
    fullUrl: getFullUrl(storedName),
    storedName,
    originalName,
    mimeType,
    sizeBytes,
  };
}

// ────────── Input helpers (read existing files) ──────────

/** Get the relative URL for a stored file */
export function fileToUrl(storedName: string): string {
  return getFileUrl(storedName);
}

/** Read a stored file as a base64 string */
export async function fileToBase64(storedName: string): Promise<string> {
  return readAsBase64(storedName);
}

/** Read a stored file as a Buffer */
export async function fileToBuffer(storedName: string): Promise<Buffer> {
  return readAsBuffer(storedName);
}

// ────────── Output helpers (save new files) ──────────

/** Download from URL, save to disk, insert DB row, return FileRecord */
export async function saveFromUrl(
  url: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  originalName?: string,
  category: string = 'general',
): Promise<FileRecord> {
  const { storedName, mimeType, sizeBytes } = await downloadAndSave(url, originalName);
  return insertFileRow(workspaceId, uploaderUserId, originalName || 'download', storedName, mimeType, sizeBytes, category);
}

/** Decode base64, save to disk, insert DB row, return FileRecord */
export async function saveFromBase64(
  base64: string,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  category: string = 'general',
): Promise<FileRecord> {
  const buffer = Buffer.from(base64, 'base64');
  const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, mimeType);
  return insertFileRow(workspaceId, uploaderUserId, originalName, storedName, mimeType, sizeBytes, category);
}

/** Save a buffer to disk, insert DB row, return FileRecord */
export async function saveFromBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  category: string = 'general',
): Promise<FileRecord> {
  const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, mimeType);
  return insertFileRow(workspaceId, uploaderUserId, originalName, storedName, mimeType, sizeBytes, category);
}
