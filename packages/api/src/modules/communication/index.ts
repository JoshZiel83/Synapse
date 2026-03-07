import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerCommunicationRoutes } from './controller.js';

export default fp(
  async function communicationModule(app: FastifyInstance) {
    registerCommunicationRoutes(app);
  },
  { name: 'communication-module' },
);
