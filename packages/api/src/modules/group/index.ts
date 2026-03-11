import type { FastifyInstance } from 'fastify';
import groupController from './controller.js';

export default async function groupModule(app: FastifyInstance) {
  await app.register(groupController);
}
