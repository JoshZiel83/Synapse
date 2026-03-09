import type { FastifyInstance } from 'fastify';
import { filesController } from './controller.js';

export default async function filesModule(app: FastifyInstance) {
  app.register(filesController, { prefix: '/api/v1' });
}
