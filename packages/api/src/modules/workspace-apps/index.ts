import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { registerWorkspaceAppRoutes } from "./controller.js"

export default fp(
  async function workspaceAppsModule(app: FastifyInstance) {
    registerWorkspaceAppRoutes(app)
  },
  { name: "workspace-apps-module" }
)
