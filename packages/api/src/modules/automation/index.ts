import type { FastifyInstance } from "fastify"
import automationController from "./controller.js"

export default async function automationModule(app: FastifyInstance) {
  await app.register(automationController)
}
