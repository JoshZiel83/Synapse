import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { registerModelGroupRoutes } from "./controller.js"

export default fp(
  async function modelGroupsModule(app: FastifyInstance) {
    registerModelGroupRoutes(app)
  },
  { name: "model-groups-module" }
)
