import type { FastifyInstance } from 'fastify';
import { workEngineController } from './controller.js';

export default async function workEngineModule(app: FastifyInstance) {
  app.register(workEngineController, { prefix: '/api/v1/workspaces/:workspaceId/work-items' });
}
