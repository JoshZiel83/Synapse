import type { FastifyInstance } from 'fastify';
import { registerPlatformRoutes } from './controller.js';

export default async function platformModule(app: FastifyInstance) {
  registerPlatformRoutes(app);
}
