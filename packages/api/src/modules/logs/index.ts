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
import type { FastifyInstance, FastifyRequest } from "fastify"
import fp from "fastify-plugin"
import { z } from "zod"
import { logger } from "../../infrastructure/logger/index.js"
import { authenticateRequestSession } from "../auth/service.js"
import { verifyDeviceLogToken } from "./device-token.js"

const LEVELS = ["debug", "info", "warn", "error"] as const
type Level = (typeof LEVELS)[number]

const MAX_RECORDS = 200
const MAX_MSG_LEN = 4_000
const MAX_FIELD_BYTES = 16_000

const ingestLog = logger.child({ domain: "server", component: "log-ingest" })

const RecordSchema = z
  .object({
    level: z.enum(LEVELS).default("info"),
    // Client-side domain/component (their own taxonomy, e.g. web.client.*); kept
    // as fields, not forced into the api LOG_DOMAINS enum.
    domain: z.string().max(120).optional(),
    component: z.string().max(120).optional(),
    msg: z.string().max(MAX_MSG_LEN).default(""),
    time: z.string().max(64).optional(),
    trace_id: z.string().max(64).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strip()

const BodySchema = z.object({
  records: z.array(RecordSchema).max(MAX_RECORDS),
})

function clampLevel(level: Level): Level {
  return LEVELS.includes(level) ? level : "info"
}

export default fp(
  async function logsModule(app: FastifyInstance) {
    app.post(
      "/api/v1/logs",
      {
        // Bound body size defensively (the global multipart limit doesn't cover
        // JSON); a batch over this is rejected before parsing.
        bodyLimit: 512 * 1024,
        // Coarse per-IP rate limit to bound log-ingest abuse (per-request auth
        // is enforced in the handler below).
        config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
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
          const device = token ? verifyDeviceLogToken(token, Date.now()) : null
          if (!device) {
            return reply
              .status(401)
              .send({ error: "unauthorized", code: "unauthorized" })
          }
          base = ingestLog.child({
            source: "device",
            deviceId: device.deviceId,
            serviceId: device.serviceId,
          })
        }

        const parsed = BodySchema.safeParse(request.body)
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid log batch", code: "invalid_request" })
        }

        for (const record of parsed.data.records) {
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
          // on `base` (source/userId/deviceId/serviceId) or the server's own
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

        return reply
          .status(202)
          .send({ ok: true, accepted: parsed.data.records.length })
      }
    )
  },
  { name: "logs-module" }
)
