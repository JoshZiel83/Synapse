// Browser auto-report ingest: POST /api/v1/reports
//
// Receives the reports browsers send OUT-OF-BAND with NO client JS — NEL
// network-layer failures (DNS/TCP/TLS, which never reach the server so no
// server log or beacon could see them), CSP violations, deprecations,
// interventions, and crashes — and re-emits each into the api's single pino
// stream (-> Alloy -> Loki) under domain:"server", component:"report-ingest".
// Complements POST /api/v1/logs (which is the session/device-authed client log
// path); this one is the browser's *automatic* telemetry channel.
//
// AUTH: UNAUTHENTICATED BY DESIGN. The browser sends these after navigation or
// crash with no reliable session/CSRF (Reporting API credentials="same-origin",
// window=no-window). So EVERY field is attacker-controlled + untrusted:
//   - closed `type` allowlist (normalize.ts), size/count caps, per-IP rate limit
//   - structured fields ONLY; attacker strings (url/body/sample/stack) are NEVER
//     interpolated into the log message (log-injection) nor promoted to a Loki
//     label (cardinality). Only the allowlisted `reportType` is low-cardinality.
//   - cookies (if same-origin) are ignored for authz and never logged.
//   - the path is EXCLUDED from the audit middleware (see
//     infrastructure/middleware/audit.ts) so a flood can't amplify DB writes.
//
// Same-origin (served under the same nginx as the app) so no CORS preflight is
// needed; the app's global CORS already covers any cross-origin case.
//
// No redaction (out of scope per the logging-refactor locked decision); reports
// may contain URLs/referrers — see docs/logging-refactor/06-...md §2.3 (PII).
import type { FastifyInstance, FastifyRequest } from "fastify"
import { logger } from "../../infrastructure/logger/index.js"
import { wireRoute } from "../../infrastructure/http/route.js"
import {
  parseCspReport,
  parseReportsJson,
  type NormalizedReport,
} from "./normalize.js"

const reportLog = logger.child({
  domain: "server",
  component: "report-ingest",
})

const BODY_LIMIT = 64 * 1024
const CT_REPORTS = "application/reports+json"
const CT_CSP = "application/csp-report"

/**
 * Encapsulated (NOT fastify-plugin): the custom content-type parsers below are
 * scoped to this plugin instead of polluting the global parser table. The
 * route-level rate limit still works because @fastify/rate-limit is registered
 * on an ancestor (the root app).
 */
export default async function reportsModule(app: FastifyInstance) {
  // Reporting API / NEL bodies are application/reports+json and legacy CSP is
  // application/csp-report — NEITHER is application/json, so Fastify's default
  // JSON parser never fires and every report would 415 without these.
  const parseJsonString = (
    _req: FastifyRequest,
    body: string,
    done: (err: Error | null, value?: unknown) => void
  ) => {
    try {
      done(null, body.length ? JSON.parse(body) : undefined)
    } catch {
      // Malformed JSON is treated as zero reports by the handler, not a 500.
      done(null, undefined)
    }
  }
  app.addContentTypeParser(
    CT_REPORTS,
    { parseAs: "string", bodyLimit: BODY_LIMIT },
    parseJsonString
  )
  app.addContentTypeParser(
    CT_CSP,
    { parseAs: "string", bodyLimit: BODY_LIMIT },
    parseJsonString
  )

  wireRoute(
    app,
    "POST",
    "/api/v1/reports",
    {
      options: {
        bodyLimit: BODY_LIMIT,
        // Unauthenticated + attacker-controllable -> coarse per-IP cap. v1 sends
        // more (smaller) requests than v0, so the cap is generous but bounded.
        // The shared keyGenerator (index.ts) keys on the nginx-set X-Real-IP
        // (not the spoofable leftmost X-Forwarded-For), so the cap actually
        // holds per client here. Per-instance (in-memory store) — see §7 of the
        // plan for the shared-store follow-up.
        config: { rateLimit: { max: 240, timeWindow: "1 minute" } },
      },
    },
    async (request: FastifyRequest, reply) => {
      const contentType = (request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase()

      let reports: NormalizedReport[]
      if (contentType === CT_CSP) {
        reports = parseCspReport(request.body)
      } else if (contentType === CT_REPORTS) {
        reports = parseReportsJson(request.body)
      } else {
        return reply.status(415).send({
          error: "unsupported_media_type",
          code: "unsupported_media_type",
        })
      }

      for (const r of reports) {
        const level =
          r.reportType === "network-error" || r.reportType === "crash"
            ? "warn"
            : "info"
        // Structured fields ONLY. `reportType` is the closed allowlist value, so
        // it is the one safe thing in the message. url/body are attacker-
        // controlled -> structured fields, never the message, never a label.
        reportLog[level](
          {
            source: "browser-report",
            reportType: r.reportType,
            reportUrl: r.url,
            reportAge: r.age,
            userAgent: r.userAgent,
            payload: r.body,
          },
          `browser report: ${r.reportType}`
        )
      }

      // The browser ignores the response body; 202 = accepted for processing.
      return reply.status(202).send({ accepted: reports.length })
    }
  )
}
