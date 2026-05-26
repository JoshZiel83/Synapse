import type { FastifyInstance } from "fastify"
import { getTransportAccountById } from "./service.js"
import { tryGetConnector } from "./connectors/registry.js"
import { ingestInboundEnvelope } from "./service/ingest.js"
import { handleFeishuWebhookRequest } from "./runtime.js"

export default async function imPublicController(app: FastifyInstance) {
  /**
   * Generic IM webhook entry point — dispatches to the registered
   * TransportConnector for the given transport_kind. Replaces the
   * Feishu-specific path /api/v1/im/public/feishu/accounts/:accountId/webhook,
   * which remains live below as a legacy alias.
   */
  app.post<{
    Params: { transportKind: string; accountId: string }
    Body: unknown
  }>(
    "/api/v1/im/webhooks/:transportKind/:accountId",
    async (request, reply) => {
      const account = await getTransportAccountById(request.params.accountId)
      if (!account || account.transportKind !== request.params.transportKind) {
        return reply
          .status(404)
          .send({ error: "transport account not found for that kind" })
      }
      if (account.status !== "active") {
        return reply
          .status(404)
          .send({ error: "transport account is not active" })
      }
      if (account.connectionMode !== "webhook") {
        return reply.status(409).send({
          error: "transport account is not configured for webhook mode",
        })
      }
      const connector = tryGetConnector(account.transportKind)
      if (!connector || !connector.handleWebhook) {
        return reply
          .status(501)
          .send({ error: `${account.transportKind} has no webhook handler` })
      }
      const result = await connector.handleWebhook({
        account,
        headers: request.headers as Record<string, unknown>,
        body: request.body,
        rawBody: (request as unknown as { rawBody?: string }).rawBody,
        emitInbound: async (envelope) => {
          await ingestInboundEnvelope({ account, envelope })
        },
      })
      return reply.status(result.statusCode).send(result.body)
    }
  )

  /**
   * Legacy Feishu-specific webhook URL kept for already-deployed Feishu app
   * event-subscription configurations. New deployments should point at the
   * generic /api/v1/im/webhooks/feishu/:accountId path above.
   */
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
        rawBody: (request as unknown as { rawBody?: string }).rawBody,
      })
      return reply.status(result.statusCode).send(result.body)
    }
  )
}
