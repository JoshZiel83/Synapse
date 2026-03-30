import type { FastifyInstance } from "fastify";
import threadController from "./thread-controller.js";

export default async function conversationModule(app: FastifyInstance) {
  await app.register(threadController);
}
