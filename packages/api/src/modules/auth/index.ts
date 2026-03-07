import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { registerAuthRoutes } from './controller.js';

const authModule: FastifyPluginAsync = async (app: FastifyInstance) => {
  registerAuthRoutes(app);
};

export default authModule;
