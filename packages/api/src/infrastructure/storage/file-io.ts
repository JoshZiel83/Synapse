import { executeSql } from '../database/kysely.js';
import {
  saveBuffer,
  getFileUrl,
  getFullUrl,
  readAsBuffer,
  readAsBase64,
  downloadAndSave,
  normalizeOriginalNameForMimeType,
  resolveBufferMimeType,
} from './index.js';

export interface FileRecord {
  id: string;
  url: string;
  fullUrl: string;
  storedName: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
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
  metadata: Record<string, unknown> = {},
): Promise<FileRecord> {
  const result = await executeSql<{ id: string }>(
    `INSERT INTO files (workspace_id, uploader_user_id, original_name, stored_name, mime_type, size_bytes, category, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [workspaceId, uploaderUserId, originalName, storedName, mimeType, sizeBytes, category, JSON.stringify(metadata)],
  );
  return {
    id: result.rows[0].id,
    url: getFileUrl(storedName),
    fullUrl: getFullUrl(storedName),
    storedName,
    originalName,
    mimeType,
    sizeBytes,
    metadata,
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
  metadata: Record<string, unknown> = {},
): Promise<FileRecord> {
  const downloaded = await downloadAndSave(url, originalName);
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    downloaded.originalName,
    downloaded.mimeType,
  );
  return insertFileRow(
    workspaceId,
    uploaderUserId,
    normalizedOriginalName,
    downloaded.storedName,
    downloaded.mimeType,
    downloaded.sizeBytes,
    category,
    metadata,
  );
}

/** Decode base64, save to disk, insert DB row, return FileRecord */
export async function saveFromBase64(
  base64: string,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  category: string = 'general',
  metadata: Record<string, unknown> = {},
): Promise<FileRecord> {
  const buffer = Buffer.from(base64, 'base64');
  const resolvedMimeType = await resolveBufferMimeType(buffer, mimeType);
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    originalName,
    resolvedMimeType,
  );
  const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, resolvedMimeType);
  return insertFileRow(
    workspaceId,
    uploaderUserId,
    normalizedOriginalName,
    storedName,
    resolvedMimeType,
    sizeBytes,
    category,
    metadata,
  );
}

/** Save a buffer to disk, insert DB row, return FileRecord */
export async function saveFromBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  category: string = 'general',
  metadata: Record<string, unknown> = {},
): Promise<FileRecord> {
  const resolvedMimeType = await resolveBufferMimeType(buffer, mimeType);
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    originalName,
    resolvedMimeType,
  );
  const { storedName, sizeBytes } = await saveBuffer(buffer, originalName, resolvedMimeType);
  return insertFileRow(
    workspaceId,
    uploaderUserId,
    normalizedOriginalName,
    storedName,
    resolvedMimeType,
    sizeBytes,
    category,
    metadata,
  );
}
