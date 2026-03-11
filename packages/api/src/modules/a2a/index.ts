import type { FastifyInstance } from 'fastify';
import { a2aManagementController, a2aProtocolController } from './controller.js';

export default async function a2aModule(fastify: FastifyInstance) {
  await a2aManagementController(fastify);
  await a2aProtocolController(fastify);
}
