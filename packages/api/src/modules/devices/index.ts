import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"
import { registerDeviceRoutes } from "./controller.js"
import { registerDeviceControlPlaneRoutes } from "./control-plane.js"

export default fp(
  async function devicesModule(app: FastifyInstance) {
    registerDeviceRoutes(app)
    registerDeviceControlPlaneRoutes(app)
  },
  { name: "devices-module" }
)

export * from "./service.js"
export * from "./tunnel-registry.js"
