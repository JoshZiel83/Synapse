import { query } from '../../infrastructure/database/index.js';
import { db } from '../../infrastructure/database/kysely.js';
import { saveFromBuffer, type FileRecord } from '../../infrastructure/storage/file-io.js';
import { getFileUrl, getFullUrl, readAsBuffer } from '../../infrastructure/storage/index.js';
import type { FileRecordView } from '@synapse/shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIsoString(value: string | Date | null | undefined): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(0).toISOString();
}

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
  const row = await db
    .selectFrom('files')
    .select(['id', 'stored_name', 'original_name', 'mime_type', 'size_bytes', 'metadata'])
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    url: getFileUrl(row.stored_name),
    fullUrl: getFullUrl(row.stored_name),
    storedName: row.stored_name,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    metadata: isRecord(row.metadata) ? row.metadata : undefined,
  };
}

export async function getFileDetail(fileId: string): Promise<FileRecordView | null> {
  const row = await db
    .selectFrom('files')
    .select([
      'id',
      'workspace_id',
      'uploader_user_id',
      'stored_name',
      'original_name',
      'mime_type',
      'size_bytes',
      'metadata',
      'created_at',
    ])
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!row) return null;
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
    createdAt: toIsoString(row.created_at),
    metadata: isRecord(row.metadata) ? row.metadata : undefined,
  };
}

export async function getWorkspaceFileDetail(
  fileId: string,
  workspaceId: string,
): Promise<FileRecordView | null> {
  const row = await db
    .selectFrom('files')
    .select([
      'id',
      'workspace_id',
      'uploader_user_id',
      'stored_name',
      'original_name',
      'mime_type',
      'size_bytes',
      'metadata',
      'created_at',
    ])
    .where('id', '=', fileId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row) return null;
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
    createdAt: toIsoString(row.created_at),
    metadata: isRecord(row.metadata) ? row.metadata : undefined,
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
  const row = await db
    .selectFrom('files')
    .select(['stored_name', 'mime_type', 'original_name', 'workspace_id'])
    .where('id', '=', fileId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    storedName: row.stored_name,
    mimeType: row.mime_type,
    originalName: row.original_name,
    workspaceId: row.workspace_id,
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
  const row = await db
    .selectFrom('files')
    .select(['stored_name', 'mime_type', 'original_name', 'workspace_id'])
    .where('stored_name', '=', storedName)
    .executeTakeFirst();
  if (!row) return null;
  return {
    storedName: row.stored_name,
    mimeType: row.mime_type,
    originalName: row.original_name,
    workspaceId: row.workspace_id,
  };
}

export async function canUserAccessFileWorkspace(
  workspaceId: string | null,
  userId: string,
): Promise<boolean> {
  if (!workspaceId) return true;

  const row = await db
    .selectFrom('workspaces as w')
    .leftJoin('workspace_members as wm', (join) =>
      join
        .onRef('wm.workspace_id', '=', 'w.id')
        .on('wm.user_id', '=', userId),
    )
    .select('w.id')
    .where('w.id', '=', workspaceId)
    .where((eb) =>
      eb.or([
        eb('w.owner_id', '=', userId),
        eb('wm.user_id', 'is not', null),
      ]),
    )
    .limit(1)
    .executeTakeFirst();

  return Boolean(row);
}
