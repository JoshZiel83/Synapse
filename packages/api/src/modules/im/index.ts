import type { FastifyInstance } from "fastify";
import imController from "./controller.js";
import imPublicController from "./public-controller.js";

export default async function imModule(app: FastifyInstance) {
  await app.register(imPublicController);
  await app.register(imController);
}
