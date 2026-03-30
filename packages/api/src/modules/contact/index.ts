import type { FastifyInstance } from "fastify";
import contactController from "./controller.js";

export default async function contactModule(app: FastifyInstance) {
  await app.register(contactController);
}
