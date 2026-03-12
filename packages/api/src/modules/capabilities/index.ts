import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerCapabilityRoutes } from './controller.js';

export default fp(
  async function capabilitiesModule(app: FastifyInstance) {
    registerCapabilityRoutes(app);
  },
  { name: 'capabilities-module' },
);
