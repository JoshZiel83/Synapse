import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { workspaceMiddleware } from '../../infrastructure/middleware/workspace.js';
import { uploadFile } from './service.js';

export async function filesController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', workspaceMiddleware);

  // POST /workspaces/:workspaceId/files — multipart file upload
  app.post<{
    Params: { workspaceId: string };
  }>('/workspaces/:workspaceId/files', async (request, reply) => {
    const { workspaceId } = request.params;
    const userId = (request as any).user!.userId;

    let data;
    try {
      data = await request.file();
    } catch (err: any) {
      return reply.status(413).send({ error: 'File too large (max 25MB)' });
    }
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    let buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err: any) {
      return reply.status(413).send({ error: 'File too large (max 25MB)' });
    }
    const originalName = data.filename;
    const mimeType = data.mimetype;

    const record = await uploadFile(buffer, originalName, mimeType, workspaceId, userId);

    return reply.status(201).send(record);
  });
}
