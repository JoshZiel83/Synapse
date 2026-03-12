import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerSkillRoutes } from './controller.js';

export default fp(
  async function skillsModule(app: FastifyInstance) {
    registerSkillRoutes(app);
  },
  { name: 'skills-module' },
);
