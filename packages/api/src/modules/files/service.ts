import { query } from '../../infrastructure/database/index.js';
import { saveFromBuffer, type FileRecord } from '../../infrastructure/storage/file-io.js';
import { getFileUrl, getFullUrl, readAsBuffer } from '../../infrastructure/storage/index.js';
import type { FileRecordView } from '@synapse/shared/types';

export function getFileUrlById(fileId: string): string {
  return `/files/${fileId}`;
}

export async function storeFile(
  params: {
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    workspaceId: string | null;
    uploaderUserId?: string | null;
    category?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<FileRecord> {
  return saveFromBuffer(
    params.buffer,
    params.originalName,
    params.mimeType,
    params.workspaceId,
    params.uploaderUserId ?? null,
    params.category,
    params.metadata,
  );
}

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
  return storeFile({
    buffer,
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    category,
  });
}

/**
 * Get a file record by ID.
 */
export async function getFileRecord(fileId: string): Promise<FileRecord | null> {
  const result = await query(
    `SELECT id, stored_name, original_name, mime_type, size_bytes, metadata
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
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
  };
}

export async function getFileDetail(fileId: string): Promise<FileRecordView | null> {
  const result = await query(
    `SELECT id, workspace_id, uploader_user_id, stored_name, original_name, mime_type, size_bytes, metadata, created_at
     FROM files
     WHERE id = $1`,
    [fileId],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uploaderUserId: row.uploader_user_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    url: getFileUrl(row.stored_name),
    fullUrl: getFullUrl(row.stored_name),
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: new Date(row.created_at).toISOString(),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
  };
}

export async function getWorkspaceFileDetail(
  fileId: string,
  workspaceId: string,
): Promise<FileRecordView | null> {
  const result = await query(
    `SELECT id, workspace_id, uploader_user_id, stored_name, original_name, mime_type, size_bytes, metadata, created_at
     FROM files
     WHERE id = $1
       AND workspace_id = $2`,
    [fileId, workspaceId],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uploaderUserId: row.uploader_user_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    url: getFileUrl(row.stored_name),
    fullUrl: getFullUrl(row.stored_name),
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: new Date(row.created_at).toISOString(),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
  };
}

/**
 * Get file access info (stored path + mime type) for serving.
 */
export async function getFileAccessInfo(
  fileId: string,
): Promise<{
  storedName: string;
  mimeType: string;
  originalName: string;
  workspaceId: string | null;
} | null> {
  const result = await query(
    `SELECT stored_name, mime_type, original_name, workspace_id
     FROM files
     WHERE id = $1`,
    [fileId],
  );
  if (result.rows.length === 0) return null;
  return {
    storedName: result.rows[0].stored_name,
    mimeType: result.rows[0].mime_type,
    originalName: result.rows[0].original_name,
    workspaceId: result.rows[0].workspace_id,
  };
}

export async function duplicateFileRecord(
  fileId: string,
  options: {
    workspaceId: string | null;
    uploaderUserId: string | null;
    category?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<FileRecord | null> {
  const info = await getFileAccessInfo(fileId);
  if (!info) {
    return null;
  }

  const buffer = await readAsBuffer(info.storedName);
  return storeFile({
    buffer,
    originalName: info.originalName,
    mimeType: info.mimeType,
    workspaceId: options.workspaceId,
    uploaderUserId: options.uploaderUserId,
    category: options.category,
    metadata: options.metadata,
  });
}

export async function getStoredFileAccessInfo(
  storedName: string,
): Promise<{
  storedName: string;
  mimeType: string;
  originalName: string;
  workspaceId: string | null;
} | null> {
  const result = await query(
    `SELECT stored_name, mime_type, original_name, workspace_id
     FROM files
     WHERE stored_name = $1`,
    [storedName],
  );
  if (result.rows.length === 0) return null;
  return {
    storedName: result.rows[0].stored_name,
    mimeType: result.rows[0].mime_type,
    originalName: result.rows[0].original_name,
    workspaceId: result.rows[0].workspace_id,
  };
}

export async function canUserAccessFileWorkspace(
  workspaceId: string | null,
  userId: string,
): Promise<boolean> {
  if (!workspaceId) return true;

  const result = await query(
    `SELECT 1
     FROM workspaces w
     LEFT JOIN workspace_members wm
       ON wm.workspace_id = w.id
      AND wm.user_id = $2
     WHERE w.id = $1
       AND (w.owner_id = $2 OR wm.user_id IS NOT NULL)
     LIMIT 1`,
    [workspaceId, userId],
  );

  return result.rows.length > 0;
}
