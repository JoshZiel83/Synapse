import type {
  CanonicalFileCategory,
  ActorOutputFileOriginSystem,
  FileContentKind,
  FileCreateOriginInput,
  FileOriginSystem,
  FileOriginFamily,
  FileOriginSummary,
  FileRecordView,
  FileStorageBackend,
  ExternalImportFileOriginSystem,
  ModelOutputFileOriginSystem,
  PackageImportFileOriginSystem,
  SystemGeneratedFileOriginSystem,
  ToolOutputFileOriginSystem,
  UserUploadFileOriginSystem,
} from "@synapse/shared/types"
import { FILE_ORIGIN_SYSTEMS } from "@synapse/shared/constants"

export type {
  CanonicalFileCategory,
  ActorOutputFileOriginSystem,
  FileContentKind,
  FileCreateOriginInput,
  FileOriginSystem,
  FileOriginFamily,
  FileOriginSummary,
  FileRecordView,
  FileStorageBackend,
  ExternalImportFileOriginSystem,
  ModelOutputFileOriginSystem,
  PackageImportFileOriginSystem,
  SystemGeneratedFileOriginSystem,
  ToolOutputFileOriginSystem,
  UserUploadFileOriginSystem,
}

export interface FileOriginInput extends FileCreateOriginInput {
  initiatorUserId?: string | null
  initiatorActorId?: string | null
  providerKey?: string
  pluginId?: string | null
  parentFileId?: string | null
  externalResourceKey?: string
  details?: Record<string, unknown>
}

export interface StoredFileRecord extends FileRecordView {
  // Content-addressed: the blob is fetched by sha256 (= FileRecordView.sha256)
  // from the CAS. No separate blob row anymore (content_blobs is keyed by
  // sha256), so the old blobId/storageKey/bucket/locator quadruple is gone.
  // `assetId` mirrors `id` for callers that referenced the asset row id.
  assetId: string
}

export function mimeToFileContentKind(mimeType: string): FileContentKind {
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("video/")) return "video"
  return "document"
}

export function mimeToCanonicalFileCategory(
  mimeType: string
): CanonicalFileCategory {
  return mimeToFileContentKind(mimeType)
}

export function buildUserUploadOrigin(input: {
  system: UserUploadFileOriginSystem
  initiatorUserId?: string | null
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "user_upload",
    system: input.system,
    initiatorUserId: input.initiatorUserId ?? null,
    details: input.details,
  }
}

export function buildActorOutputOrigin(input: {
  system: ActorOutputFileOriginSystem
  initiatorActorId: string
  initiatorUserId?: string | null
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "actor_output",
    system: input.system,
    initiatorActorId: input.initiatorActorId,
    initiatorUserId: input.initiatorUserId ?? null,
    details: input.details,
  }
}

export function buildToolOutputOrigin(input: {
  system: ToolOutputFileOriginSystem
  initiatorActorId?: string | null
  initiatorUserId?: string | null
  providerKey?: string
  pluginId?: string | null
  parentFileId?: string | null
  externalResourceKey?: string
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "tool_output",
    system: input.system,
    initiatorActorId: input.initiatorActorId ?? null,
    initiatorUserId: input.initiatorUserId ?? null,
    providerKey: input.providerKey,
    pluginId: input.pluginId ?? null,
    parentFileId: input.parentFileId ?? null,
    externalResourceKey: input.externalResourceKey,
    details: input.details,
  }
}

export function buildModelOutputOrigin(input: {
  system: ModelOutputFileOriginSystem
  initiatorActorId?: string | null
  initiatorUserId?: string | null
  providerKey?: string
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "model_output",
    system: input.system,
    initiatorActorId: input.initiatorActorId ?? null,
    initiatorUserId: input.initiatorUserId ?? null,
    providerKey: input.providerKey,
    details: input.details,
  }
}

export function buildExternalImportOrigin(input: {
  system: ExternalImportFileOriginSystem
  initiatorActorId?: string | null
  initiatorUserId?: string | null
  providerKey?: string
  externalResourceKey?: string
  parentFileId?: string | null
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "external_import",
    system: input.system,
    initiatorActorId: input.initiatorActorId ?? null,
    initiatorUserId: input.initiatorUserId ?? null,
    providerKey: input.providerKey,
    externalResourceKey: input.externalResourceKey,
    parentFileId: input.parentFileId ?? null,
    details: input.details,
  }
}

export function buildPackageImportOrigin(input: {
  system: PackageImportFileOriginSystem
  initiatorUserId?: string | null
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "package_import",
    system: input.system,
    initiatorUserId: input.initiatorUserId ?? null,
    details: input.details,
  }
}

export function buildSystemGeneratedOrigin(input: {
  system: SystemGeneratedFileOriginSystem
  initiatorUserId?: string | null
  initiatorActorId?: string | null
  details?: Record<string, unknown>
}): FileOriginInput {
  return {
    family: "system_generated",
    system: input.system,
    initiatorUserId: input.initiatorUserId ?? null,
    initiatorActorId: input.initiatorActorId ?? null,
    details: input.details,
  }
}

export function toFileOriginSummary(
  origin: FileOriginInput
): FileOriginSummary {
  return {
    family: origin.family,
    system: origin.system,
    initiatorUserId: origin.initiatorUserId ?? null,
    initiatorActorId: origin.initiatorActorId ?? null,
    providerKey: origin.providerKey,
    parentFileId: origin.parentFileId ?? null,
    externalResourceKey: origin.externalResourceKey,
    details: origin.details,
  }
}

export function resolveModelResponseMediaOriginSystem(
  providerType: string
): ModelOutputFileOriginSystem {
  if (providerType === "anthropic") {
    return FILE_ORIGIN_SYSTEMS.ANTHROPIC_RESPONSE_MEDIA_INGEST
  }
  if (providerType === "openai" || providerType === "openai.responses") {
    return FILE_ORIGIN_SYSTEMS.OPENAI_RESPONSE_MEDIA_INGEST
  }
  return FILE_ORIGIN_SYSTEMS.GENERIC_MODEL_RESPONSE_MEDIA_INGEST
}
