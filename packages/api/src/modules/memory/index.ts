import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerMemoryRoutes } from './controller.js';

export default fp(
  async function memoryModule(app: FastifyInstance) {
    registerMemoryRoutes(app);
  },
  { name: 'memory-module' },
);
