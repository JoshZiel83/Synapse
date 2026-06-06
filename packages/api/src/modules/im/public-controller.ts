import type { FastifyInstance } from "fastify"
import { getTransportAccountById } from "./service.js"
import { tryGetConnector } from "./connectors/registry.js"
import { ingestInboundEnvelope } from "./service/ingest.js"

export default async function imPublicController(app: FastifyInstance) {
  /**
   * Generic IM webhook entry point — dispatches to the registered
   * TransportConnector for the given transport_kind.
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
        // Plumb the raw request bytes so connectors that verify a
        // signature over the original payload (QQ Ed25519, future
        // platforms) can do so. Re-encoding `request.body` would
        // change whitespace / key order and break signatures.
        rawBody: (request as unknown as { rawBody?: string }).rawBody,
        emitInbound: async (envelope) => {
          await ingestInboundEnvelope({ account, envelope })
        },
      })
      return reply.status(result.statusCode).send(result.body)
    }
  )
}
