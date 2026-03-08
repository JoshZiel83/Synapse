import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { registerMcpPluginRoutes } from './controller.js';

export default fp(
  async function mcpPluginsModule(app: FastifyInstance) {
    registerMcpPluginRoutes(app);
  },
  { name: 'mcp-plugins-module' },
);
