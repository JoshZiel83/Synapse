// runtime-authorizations module wrapper. Registers the manual grant endpoint
// (plan §Phase 3, §clarification #18 controller registration).

import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { registerManualRuntimeAuthorizationGrantRoutes } from "./manual-grants.controller.js"

export default fp(
  async function runtimeAuthorizationsModule(app: FastifyInstance) {
    registerManualRuntimeAuthorizationGrantRoutes(app)
  },
  { name: "runtime-authorizations-module" }
)

export * from "./service.js"
