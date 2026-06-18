import type { FastifyInstance } from "fastify"
import { wireRoute } from "../../infrastructure/http/route.js"
import { getTransportAccountById } from "./service.js"
import { tryGetConnector } from "./connectors/registry.js"
import { ingestInboundEnvelope } from "./service/ingest.js"

export default async function imPublicController(app: FastifyInstance) {
  /**
   * Generic IM webhook entry point — dispatches to the registered
   * TransportConnector for the given transport_kind.
   *
   * WIRE route (machine/webhook-facing): the connector dictates the exact
   * status code + bare body the external platform expects (e.g. echo
   * challenges, ack payloads), so it is never wrapped in `{ data }`.
   */
  wireRoute(
    app,
    "POST",
    "/api/v1/im/webhooks/:transportKind/:accountId",
    {},
    async (request, reply) => {
      const params = request.params as {
        transportKind: string
        accountId: string
      }
      const account = await getTransportAccountById(params.accountId)
      if (!account || account.transportKind !== params.transportKind) {
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

  /**
   * HTTP GET webhook-verification handshake — dispatches to the
   * connector's optional `handleWebhookVerification`. The canonical case
   * is WhatsApp Cloud: Meta calls
   * `GET …/webhooks/whatsapp/:accountId?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
   * once at subscription time and expects `hub.challenge` echoed back.
   *
   * Kept as a SEPARATE wire route from the POST event handler because the
   * POST route carries no verification semantics, and platforms that
   * register their webhook out-of-band (Telegram `setWebhook`) never hit
   * this GET — for them `tryGetConnector(...).handleWebhookVerification`
   * is undefined and we reply 501.
   */
  wireRoute(
    app,
    "GET",
    "/api/v1/im/webhooks/:transportKind/:accountId",
    {},
    async (request, reply) => {
      const params = request.params as {
        transportKind: string
        accountId: string
      }
      const account = await getTransportAccountById(params.accountId)
      if (!account || account.transportKind !== params.transportKind) {
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
      if (!connector || !connector.handleWebhookVerification) {
        return reply.status(501).send({
          error: `${account.transportKind} has no webhook verification handler`,
        })
      }
      const result = await connector.handleWebhookVerification({
        account,
        query: (request.query as Record<string, unknown>) ?? {},
        headers: request.headers as Record<string, unknown>,
      })
      return reply.status(result.statusCode).send(result.body)
    }
  )
}
