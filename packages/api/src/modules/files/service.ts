import { query } from '../../infrastructure/database/index.js';
import { saveFromBuffer, type FileRecord } from '../../infrastructure/storage/file-io.js';
import { getFileUrl, getFullUrl } from '../../infrastructure/storage/index.js';

/**
 * Upload a file from a multipart buffer.
 */
export async function uploadFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string,
  uploaderUserId: string,
  category: string = 'chat_attachment',
): Promise<FileRecord> {
  return saveFromBuffer(buffer, originalName, mimeType, workspaceId, uploaderUserId, category);
}

/**
 * Get a file record by ID.
 */
export async function getFileRecord(fileId: string): Promise<FileRecord | null> {
  const result = await query(
    `SELECT id, stored_name, original_name, mime_type, size_bytes
     FROM files WHERE id = $1`,
    [fileId],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    url: getFileUrl(row.stored_name),
    fullUrl: getFullUrl(row.stored_name),
    storedName: row.stored_name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
  };
}

/**
 * Get file access info (stored path + mime type) for serving.
 */
export async function getFileAccessInfo(
  fileId: string,
): Promise<{ storedName: string; mimeType: string; originalName: string } | null> {
  const result = await query(
    `SELECT stored_name, mime_type, original_name FROM files WHERE id = $1`,
    [fileId],
  );
  if (result.rows.length === 0) return null;
  return {
    storedName: result.rows[0].stored_name,
    mimeType: result.rows[0].mime_type,
    originalName: result.rows[0].original_name,
  };
}
