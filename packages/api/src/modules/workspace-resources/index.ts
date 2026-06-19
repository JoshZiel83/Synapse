import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { registerWorkspaceResourceRoutes } from "./controller.js"

export default fp(
  async function workspaceResourcesModule(app: FastifyInstance) {
    registerWorkspaceResourceRoutes(app)
  },
  { name: "workspace-resources-module" }
)
