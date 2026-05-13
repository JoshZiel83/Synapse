import type { FastifyInstance } from "fastify"
import { registerWorkspaceRoutes } from "./controller.js"

export default async function workspaceModule(fastify: FastifyInstance) {
  await registerWorkspaceRoutes(fastify)
}
