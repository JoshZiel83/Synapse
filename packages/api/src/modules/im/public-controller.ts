import type { FastifyInstance } from "fastify"
import { handleFeishuWebhookRequest } from "./runtime.js"

export default async function imPublicController(app: FastifyInstance) {
  app.post<{
    Params: { accountId: string }
    Body: unknown
  }>(
    "/api/v1/im/public/feishu/accounts/:accountId/webhook",
    async (request, reply) => {
      const result = await handleFeishuWebhookRequest({
        accountId: request.params.accountId,
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      })
      return reply.status(result.statusCode).send(result.body)
    }
  )
}
