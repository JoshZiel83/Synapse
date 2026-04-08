import type { FastifyInstance } from "fastify";
import remoteAgentsController from "./controller.js";

export default async function remoteAgentsModule(app: FastifyInstance) {
  await app.register(remoteAgentsController);
}
