import type { FastifyInstance } from "fastify"
import imController from "./controller.js"
import imPublicController from "./public-controller.js"

// Single registration entrypoint. Add new connectors to register-all.ts;
// never side-effect register from here directly — the capability contract
// tests pull the same file so any drift is caught.
import "./connectors/register-all.js"

export default async function imModule(app: FastifyInstance) {
  await app.register(imPublicController)
  await app.register(imController)
}
