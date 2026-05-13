import type { FastifyInstance } from "fastify"
import { organizationController } from "./controller.js"

export default async function organizationModule(app: FastifyInstance) {
  app.register(organizationController, {
    prefix: "/api/v1/workspaces/:workspaceId/actors",
  })
}
