import type { FastifyInstance } from "fastify";
import conversationController from "./controller.js";

export default async function conversationModule(app: FastifyInstance) {
  await app.register(conversationController);
}
