import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"

import { registerInstallerRoutes } from "./controller.js"

export default fp(
  async function installerModule(app: FastifyInstance) {
    registerInstallerRoutes(app)
  },
  { name: "installer-module" }
)

export * from "./install-command.js"
