import type { FastifyInstance } from "fastify";
import chatController from "./controller.js";

export default async function chatModule(app: FastifyInstance) {
  await app.register(chatController);
}
