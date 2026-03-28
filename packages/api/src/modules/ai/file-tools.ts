import type { ToolDefinition } from '@synapse/shared';
import { z } from 'zod';
import { saveFromBase64 } from '../../infrastructure/storage/file-io.js';
import {
  getFileUrlById,
  getWorkspaceFileDetail,
  storeFile,
} from '../files/service.js';
import { extractFileRefId } from '../mcp-plugins/file-ref.js';
import { getToolExecutionContext } from './session-tools.js';
import { registerToolPlugin } from './tool-plugins.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_TEXT_MIME_TYPE = 'text/plain; charset=utf-8';
const DEFAULT_BINARY_MIME_TYPE = 'application/octet-stream';
const DEFAULT_CATEGORY = 'actor_output';
const PROTECTED_LINK_NOTE = 'Links are workspace-protected and require an authenticated Synapse session.';

const uploadFileInputSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).optional(),
  textContent: z.string().optional(),
  base64Content: z.string().optional(),
  category: z.string().trim().min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  const sourceCount = [value.textContent, value.base64Content]
    .filter((candidate) => candidate !== undefined).length;
  if (sourceCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide exactly one of textContent or base64Content.',
      path: ['textContent'],
    });
  }
});

const fileLookupInputSchema = z.object({
  fileRef: z.string().trim().min(1),
}).strict();

type UploadMode = 'text' | 'base64';

type ActorFileToolContext = NonNullable<ReturnType<typeof getToolExecutionContext>>;

function buildFileRef(fileId: string): string {
  return `<FileRef id="${fileId}"/>`;
}

function buildActorUploadMetadata(
  context: ActorFileToolContext,
  mode: UploadMode,
): Record<string, unknown> {
  return {
    source: {
      kind: 'actor_tool',
      toolName: 'upload_file',
      uploadMode: mode,
      actorId: context.actorId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      conversationId: context.conversationId,
    },
  };
}

function ensureFileSizeLimit(sizeBytes: number) {
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`File too large (${sizeBytes} bytes). Max allowed size is ${MAX_FILE_BYTES} bytes.`);
  }
}

function normalizeBase64Payload(value: string): string {
  const trimmed = value.trim();
  const dataUrlPrefixMatch = trimmed.match(/^data:[^,]*;base64,(.*)$/s);
  return (dataUrlPrefixMatch ? dataUrlPrefixMatch[1] : trimmed).replace(/\s+/g, '');
}

function decodeBase64Payload(value: string): Buffer {
  const normalized = normalizeBase64Payload(value);
  if (!normalized) {
    return Buffer.alloc(0);
  }
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('base64Content must be valid Base64 data.');
  }
  return Buffer.from(normalized, 'base64');
}

function buildFileToolPayload(detail: NonNullable<Awaited<ReturnType<typeof getWorkspaceFileDetail>>>) {
  return {
    fileId: detail.id,
    fileRef: buildFileRef(detail.id),
    originalName: detail.originalName,
    mimeType: detail.mimeType,
    sizeBytes: detail.sizeBytes,
    createdAt: detail.createdAt,
    byIdUrl: getFileUrlById(detail.id),
    url: detail.url,
    fullUrl: detail.fullUrl,
    metadata: detail.metadata,
  };
}

async function resolveWorkspaceFileDetail(
  rawValue: unknown,
) {
  const context = getToolExecutionContext();
  if (!context) {
    return { error: { error: 'No session context available' } as const };
  }

  const fileId = extractFileRefId(rawValue);
  if (!fileId) {
    return {
      error: {
        error: 'fileRef must be an exact FileRef string like <FileRef id="..."/> or a bare file ID.',
      } as const,
    };
  }

  const detail = await getWorkspaceFileDetail(fileId, context.workspaceId);
  if (!detail) {
    return { error: { error: 'File not found in the current workspace' } as const };
  }

  return { detail };
}

const uploadFileDefinition: ToolDefinition = {
  name: 'upload_file',
  description:
    'Store a new file in the current workspace and return its FileRef plus protected download links. ' +
    'Use textContent for generated text files, or base64Content for binary files.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Original filename to store, for example report.md or image.png.',
      },
      mimeType: {
        type: 'string',
        description: `Optional MIME type. Defaults to ${DEFAULT_TEXT_MIME_TYPE} for textContent and ${DEFAULT_BINARY_MIME_TYPE} for base64Content.`,
      },
      textContent: {
        type: 'string',
        description: 'UTF-8 text content for a generated file.',
      },
      base64Content: {
        type: 'string',
        description: 'Binary file payload encoded as Base64. Data URLs like data:image/png;base64,... are also accepted.',
      },
      category: {
        type: 'string',
        description: `Optional file category label. Defaults to ${DEFAULT_CATEGORY}.`,
      },
    },
    required: ['filename'],
  },
};

const getFileLinkDefinition: ToolDefinition = {
  name: 'get_file_link',
  description:
    'Resolve a FileRef or bare file ID to the protected workspace file links. ' +
    'Returns both the stable ID-based route and the stored-path route.',
  parameters: {
    type: 'object',
    properties: {
      fileRef: {
        type: 'string',
        description: 'Exact FileRef string like <FileRef id="..."/> or a bare file ID.',
      },
    },
    required: ['fileRef'],
  },
};

const getFileInfoDefinition: ToolDefinition = {
  name: 'get_file_info',
  description:
    'Resolve a FileRef or bare file ID to structured file metadata in the current workspace.',
  parameters: {
    type: 'object',
    properties: {
      fileRef: {
        type: 'string',
        description: 'Exact FileRef string like <FileRef id="..."/> or a bare file ID.',
      },
    },
    required: ['fileRef'],
  },
};

export function registerActorFileToolPlugins(): void {
  registerToolPlugin({
    name: 'upload_file',
    kind: 'callable',
    definition: uploadFileDefinition,
    resolve: (ctx) => ({
      active: Boolean(ctx.workspaceId),
      definition: uploadFileDefinition,
    }),
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const parsed = uploadFileInputSchema.safeParse(input);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'Invalid input for upload_file.',
          details: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const { filename, mimeType, textContent, base64Content, category } = parsed.data;
      const nextCategory = category || DEFAULT_CATEGORY;

      try {
        const record = textContent !== undefined
          ? await (() => {
            const buffer = Buffer.from(textContent, 'utf8');
            ensureFileSizeLimit(buffer.length);
            return storeFile({
              buffer,
              originalName: filename,
              mimeType: mimeType || DEFAULT_TEXT_MIME_TYPE,
              workspaceId: context.workspaceId,
              uploaderUserId: null,
              category: nextCategory,
              metadata: buildActorUploadMetadata(context, 'text'),
            });
          })()
          : await (() => {
            const normalizedBase64 = normalizeBase64Payload(base64Content || '');
            const buffer = decodeBase64Payload(normalizedBase64);
            ensureFileSizeLimit(buffer.length);
            return saveFromBase64(
              normalizedBase64,
              filename,
              mimeType || DEFAULT_BINARY_MIME_TYPE,
              context.workspaceId,
              null,
              nextCategory,
              buildActorUploadMetadata(context, 'base64'),
            );
          })();

        const detail = await getWorkspaceFileDetail(record.id, context.workspaceId);
        if (!detail) {
          return JSON.stringify({ error: 'Uploaded file could not be reloaded from the current workspace.' });
        }

        return JSON.stringify({
          success: true,
          ...buildFileToolPayload(detail),
          note: PROTECTED_LINK_NOTE,
        });
      } catch (error: any) {
        return JSON.stringify({
          error: error?.message || 'Failed to upload file',
        });
      }
    },
  });

  registerToolPlugin({
    name: 'get_file_link',
    kind: 'callable',
    definition: getFileLinkDefinition,
    resolve: (ctx) => ({
      active: Boolean(ctx.workspaceId),
      definition: getFileLinkDefinition,
    }),
    execute: async (input) => {
      const parsed = fileLookupInputSchema.safeParse(input);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'Invalid input for get_file_link.',
          details: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const resolved = await resolveWorkspaceFileDetail(parsed.data.fileRef);
      if ('error' in resolved) {
        return JSON.stringify(resolved.error);
      }

      return JSON.stringify({
        success: true,
        fileId: resolved.detail.id,
        fileRef: buildFileRef(resolved.detail.id),
        byIdUrl: getFileUrlById(resolved.detail.id),
        url: resolved.detail.url,
        fullUrl: resolved.detail.fullUrl,
        note: PROTECTED_LINK_NOTE,
      });
    },
  });

  registerToolPlugin({
    name: 'get_file_info',
    kind: 'callable',
    definition: getFileInfoDefinition,
    resolve: (ctx) => ({
      active: Boolean(ctx.workspaceId),
      definition: getFileInfoDefinition,
    }),
    execute: async (input) => {
      const parsed = fileLookupInputSchema.safeParse(input);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'Invalid input for get_file_info.',
          details: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const resolved = await resolveWorkspaceFileDetail(parsed.data.fileRef);
      if ('error' in resolved) {
        return JSON.stringify(resolved.error);
      }

      return JSON.stringify({
        success: true,
        ...buildFileToolPayload(resolved.detail),
        note: PROTECTED_LINK_NOTE,
      });
    },
  });
}
