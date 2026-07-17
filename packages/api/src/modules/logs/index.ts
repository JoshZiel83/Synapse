// Client log ingest endpoint: POST /api/v1/logs
//
// Receives batched structured log records from the BROWSER (web-next) and
// react-native-WEB (mobile-web static export, no Node server) — the surfaces
// that authenticate with a user session — and re-emits each into the api's
// single pino stream (so they flow into Alloy -> Loki with the same shape as
// server logs). Tagged `source: "client"` + the authenticated user/workspace.
//
// AUTH: a user session (browser / mobile-web) OR a short-lived HMAC device
// log-ingest token (device-runtime / daemon). Devices can't use a session
// (they authenticate to the control plane via Ed25519 challenge-response), so
// the server mints a bearer token in the device.hello ack (see device-token.ts)
// which they send here as `Authorization: Bearer <token>`.
//
// No redaction (out of scope per locked decision D3). Records are size/count
// capped to bound abuse; per-record fields are passed through as structured
// pino fields.
//
// DEGRADE-NOT-REJECT: trace_id degrades at the field level and malformed
// records are salvaged per record — see ingest-schema.ts (plan §4.I change 5,
// adjudication 11/12 + the §3c receiver rule).
import type { FastifyInstance, FastifyRequest } from "fastify"
import fp from "fastify-plugin"
import { logger } from "../../infrastructure/logger/index.js"
import { wireRoute } from "../../infrastructure/http/route.js"
import { authenticateRequestSession } from "../auth/service.js"
import { verifyRuntimeLogToken } from "./device-token.js"
import { LEVELS, salvageLogBatch, type Level } from "./ingest-schema.js"

const MAX_FIELD_BYTES = 16_000

const ingestLog = logger.child({ domain: "server", component: "log-ingest" })

function clampLevel(level: Level): Level {
  return LEVELS.includes(level) ? level : "info"
}

export default fp(
  async function logsModule(app: FastifyInstance) {
    wireRoute(
      app,
      "POST",
      "/api/v1/logs",
      {
        options: {
          // Bound body size defensively (the global multipart limit doesn't
          // cover JSON); a batch over this is rejected before parsing.
          bodyLimit: 512 * 1024,
          // Coarse per-IP rate limit to bound log-ingest abuse (per-request
          // auth is enforced in the handler below).
          config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
        },
      },
      async (request: FastifyRequest, reply) => {
        // Auth: a user session (browser / mobile-web) OR a device log-ingest
        // bearer token (device-runtime / daemon, minted at control-plane hello).
        const session = await authenticateRequestSession(request)
        let base
        if (session) {
          base = ingestLog.child({ source: "client", userId: session.user.id })
        } else {
          const authz = request.headers.authorization
          const token =
            typeof authz === "string" && authz.startsWith("Bearer ")
              ? authz.slice("Bearer ".length)
              : null
          const device = token ? verifyRuntimeLogToken(token, Date.now()) : null
          if (!device) {
            return reply
              .status(401)
              .send({ error: "unauthorized", code: "unauthorized" })
          }
          base = ingestLog.child({
            source: "device",
            runtimeId: device.runtimeId,
            serviceId: device.serviceId,
          })
        }

        // Per-record salvage (ingest-schema.ts): only a malformed batch
        // ENVELOPE is a 400; malformed records are counted, valid ones kept.
        const batch = salvageLogBatch(request.body)
        if (!batch) {
          return reply
            .status(400)
            .send({ error: "invalid log batch", code: "invalid_request" })
        }

        for (const record of batch.records) {
          const level = clampLevel(record.level)
          // Cap the structured payload to bound abuse; drop on overflow.
          let fields: Record<string, unknown> | undefined = record.fields
          if (fields) {
            try {
              if (JSON.stringify(fields).length > MAX_FIELD_BYTES) {
                fields = { truncated: true }
              }
            } catch {
              fields = { unserializable: true }
            }
          }
          // Namespace ALL client-controlled data under reserved keys so it can
          // never collide with (and last-wins-override) the TRUSTED attribution
          // on `base` (source/userId/runtimeId/serviceId) or the server's own
          // `trace_id` (from the logger mixin). A client must not be able to
          // forge provenance or attach to a victim's trace.
          base[level](
            {
              clientDomain: record.domain,
              clientComponent: record.component,
              clientTime: record.time,
              clientTraceId: record.trace_id,
              payload: fields,
            },
            record.msg
          )
        }

        return reply.status(202).send({
          ok: true,
          accepted: batch.records.length,
          rejected: batch.rejected,
        })
      }
    )
  },
  { name: "logs-module" }
)
