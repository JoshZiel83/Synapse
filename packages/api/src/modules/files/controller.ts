import type { FastifyInstance, FastifyReply } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { readAsBuffer } from '../../infrastructure/storage/index.js';
import {
  canUserAccessFileWorkspace,
  getFileAccessInfo,
  getFileDetail,
  getStoredFileAccessInfo,
  uploadFile,
} from './service.js';

async function sendStoredFile(
  reply: FastifyReply,
  info: {
    storedName: string;
    mimeType: string;
    originalName: string;
  },
) {
  try {
    const buffer = await readAsBuffer(info.storedName);
    reply.type(info.mimeType || 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(info.originalName || 'file')}`,
    );
    return reply.send(buffer);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return reply.status(404).send({ error: 'File not found' });
    }
    throw error;
  }
}

export async function filesUploadController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', workspaceMiddleware);

  app.post<{
    Params: { workspaceId: string };
  }>('/workspaces/:workspaceId/files', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    let data;
    try {
      data = await request.file();
    } catch {
      return reply.status(413).send({ error: 'File too large (max 25MB)' });
    }
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    let buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      return reply.status(413).send({ error: 'File too large (max 25MB)' });
    }

    const record = await uploadFile(buffer, data.filename, data.mimetype, workspaceId, userId);
    return reply.status(201).send(record);
  });
}

export async function filesReadController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  app.get<{
    Params: { fileId: string };
  }>('/files/:fileId/info', async (request, reply) => {
    const userId = (request as any).user!.userId;
    const detail = await getFileDetail(request.params.fileId);
    if (!detail) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const allowed = await canUserAccessFileWorkspace(detail.workspaceId ?? null, userId);
    if (!allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return detail;
  });

  app.get<{
    Params: { fileId: string };
  }>('/files/:fileId', async (request, reply) => {
    const userId = (request as any).user!.userId;
    const info = await getFileAccessInfo(request.params.fileId);
    if (!info) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const allowed = await canUserAccessFileWorkspace(info.workspaceId, userId);
    if (!allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return sendStoredFile(reply, info);
  });

  app.get('/files/*', async (request, reply) => {
    const userId = (request as any).user!.userId;
    const storedName = decodeURIComponent(((request.params as Record<string, string>)['*'] || '').trim());
    if (!storedName) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const info = await getStoredFileAccessInfo(storedName);
    if (!info) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const allowed = await canUserAccessFileWorkspace(info.workspaceId, userId);
    if (!allowed) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    return sendStoredFile(reply, info);
  });
}
