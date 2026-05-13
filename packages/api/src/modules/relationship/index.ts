import type { FastifyInstance } from "fastify"
import relationshipController from "./controller.js"

export default async function relationshipModule(app: FastifyInstance) {
  await app.register(relationshipController)
}
