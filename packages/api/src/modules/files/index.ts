import type { FastifyInstance } from 'fastify';
import { filesReadController, filesUploadController } from './controller.js';

export default async function filesModule(app: FastifyInstance) {
  app.register(filesUploadController, { prefix: '/api/v1' });
  app.register(filesReadController, { prefix: '/api/v1' });
  app.register(filesReadController);
}
