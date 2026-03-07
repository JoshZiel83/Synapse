import type { FastifyInstance } from 'fastify';
import { secretaryController } from './controller.js';

export default async function secretaryModule(app: FastifyInstance) {
  app.register(secretaryController, { prefix: '/api/v1/workspaces/:workspaceId/secretary' });
}

export { findSecretary, processUserMessage, getConversation, clearConversation } from './service.js';
