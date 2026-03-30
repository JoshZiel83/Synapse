import type { FastifyInstance } from "fastify";
import conversationController from "./controller.js";
import threadController from "./thread-controller.js";

export default async function conversationModule(app: FastifyInstance) {
  await app.register(threadController);
  await app.register(conversationController);
}
