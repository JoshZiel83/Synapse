import { db } from '../database/kysely.js';
import type { FileStorageBackend } from '@synapse/shared/types';
import {
  downloadToBuffer,
  getStableFileUrl,
  getStableFullFileUrl,
  normalizeOriginalNameForMimeType,
  putBufferCas,
  readCasBlob,
  readCasBlobBase64,
  resolveBufferMimeType,
} from './index.js';
import {
  mimeToFileContentKind,
  toFileOriginSummary,
  type FileOriginInput,
  type StoredFileRecord,
} from '../../modules/files/model.js';

export type FileRecord = StoredFileRecord;

type CreateStoredFileParams = {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  workspaceId: string | null;
  uploaderUserId: string | null;
  origin: FileOriginInput;
  backend?: FileStorageBackend;
};

function toJsonObject(value: Record<string, unknown>): any {
  return value as any;
}

function assertExplicitOrigin(origin: FileOriginInput | undefined): asserts origin is FileOriginInput {
  if (!origin?.family || !origin.system) {
    throw new Error('File origin is required and must include family plus system.');
  }
}

function normalizeDetails(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value && Object.keys(value).length > 0 ? value : {};
}

async function createStoredFile(
  params: CreateStoredFileParams,
): Promise<FileRecord> {
  assertExplicitOrigin(params.origin);

  const resolvedMimeType = await resolveBufferMimeType(
    params.buffer,
    params.mimeType,
  );
  const normalizedOriginalName = normalizeOriginalNameForMimeType(
    params.originalName,
    resolvedMimeType,
  );
  // Content-address the bytes (sha256 dedup). Same sha = one physical blob.
  const blobRef = await putBufferCas(params.buffer);
  const contentKind = mimeToFileContentKind(resolvedMimeType);

  const record = await db.transaction().execute(async (trx) => {
    // Upsert the content_blobs row (sha256 PK). ON CONFLICT DO NOTHING: a
    // dedup hit means the row already exists with identical content.
    await trx
      .insertInto('content_blobs')
      .values({
        sha256: blobRef.sha256,
        size_bytes: String(blobRef.sizeBytes),
        backend: 'local_cas',
        locator_json: toJsonObject({}),
      })
      .onConflict((oc) => oc.column('sha256').doNothing())
      .execute();

    const asset = await trx
      .insertInto('file_assets')
      .values({
        workspace_id: params.workspaceId,
        content_sha256: blobRef.sha256,
        original_name: normalizedOriginalName,
        mime_type: resolvedMimeType,
        content_kind: contentKind,
        size_bytes: String(blobRef.sizeBytes),
        uploader_user_id: params.uploaderUserId,
        initiator_actor_id: params.origin.initiatorActorId ?? null,
        source_family: params.origin.family,
        source_system: params.origin.system,
        parent_asset_id: params.origin.parentFileId ?? null,
        details_json: toJsonObject(normalizeDetails(params.origin.details)),
      })
      .returning([
        'id',
        'workspace_id',
        'uploader_user_id',
        'original_name',
        'mime_type',
        'content_kind',
        'size_bytes',
        'content_sha256',
        'created_at',
      ])
      .executeTakeFirstOrThrow();

    return {
      id: asset.id,
      assetId: asset.id,
      workspaceId: asset.workspace_id,
      uploaderUserId: asset.uploader_user_id,
      originalName: asset.original_name,
      url: getStableFileUrl(asset.id),
      fullUrl: getStableFullFileUrl(asset.id),
      mimeType: asset.mime_type,
      contentKind: asset.content_kind,
      sizeBytes: Number(asset.size_bytes),
      sha256: asset.content_sha256,
      storageBackend: 'local_cas' as FileStorageBackend,
      originSummary: toFileOriginSummary(params.origin),
      createdAt:
        asset.created_at instanceof Date
          ? asset.created_at.toISOString()
          : String(asset.created_at),
    } satisfies StoredFileRecord;
  });

  void import('../../modules/files/parse-service.js')
    .then(({ enqueueDefaultFileParse }) =>
      enqueueDefaultFileParse({
        fileId: record.id,
        mimeType: record.mimeType,
        contentKind: record.contentKind,
      }),
    )
    .catch((error) => {
      console.error(`[file-io] Failed to enqueue default file parse for ${record.id}:`, error);
    });

  return record;
}

export async function fileToBase64(record: Pick<FileRecord, 'sha256'>): Promise<string> {
  return readCasBlobBase64(record.sha256);
}

export async function fileToBuffer(record: Pick<FileRecord, 'sha256'>): Promise<Buffer> {
  return readCasBlob(record.sha256);
}

export async function saveFromUrl(
  url: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  originalName: string | undefined,
  origin: FileOriginInput,
  backend: FileStorageBackend = 'local_cas',
): Promise<FileRecord> {
  const downloaded = await downloadToBuffer(url, originalName);
  return createStoredFile({
    buffer: downloaded.buffer,
    originalName: downloaded.originalName,
    mimeType: downloaded.mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  });
}

export async function saveFromBase64(
  base64: string,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  origin: FileOriginInput,
  backend: FileStorageBackend = 'local_cas',
): Promise<FileRecord> {
  return createStoredFile({
    buffer: Buffer.from(base64, 'base64'),
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  });
}

export async function saveFromBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  workspaceId: string | null,
  uploaderUserId: string | null,
  origin: FileOriginInput,
  backend: FileStorageBackend = 'local_cas',
): Promise<FileRecord> {
  return createStoredFile({
    buffer,
    originalName,
    mimeType,
    workspaceId,
    uploaderUserId,
    origin,
    backend,
  });
}
