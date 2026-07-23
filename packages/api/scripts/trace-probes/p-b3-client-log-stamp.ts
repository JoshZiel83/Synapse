// P-B3 (client-log trace correlation) — round-2 addition beyond the §7 manifest.
//
// F14: client loggers stamp `trace_id` at emit time; the ingest RecordSchema
// degrades it field-level and the route re-emits it as `clientTraceId`; and the
// Grafana derived field turns that into a clickable Loki→Tempo link. This probe
// closes the loop without a live backend: a captured trace id survives
// `salvageLogBatch`, a non-canonical / all-zero id degrades to absent WITHOUT
// dropping the record, and BOTH `matcherRegex` values read out of
// infrastructure/observability/grafana-datasources.yaml match real pino-shaped
// lines and do not cross-match.
//
// Run: npx tsx scripts/trace-probes/p-b3-client-log-stamp.ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { salvageLogBatch } from "../../src/modules/logs/ingest-schema.js"
import { check, finish } from "./_shared.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const ALL_ZERO = "0".repeat(32)

// ── salvage: a valid captured trace id survives and lands ready for clientTraceId
{
  const batch = salvageLogBatch({
    records: [
      { level: "info", domain: "web.client", msg: "ok", trace_id: TRACE_ID },
      { level: "warn", domain: "web.client", msg: "zero", trace_id: ALL_ZERO },
      { level: "error", domain: "web.client", msg: "bad", trace_id: "not-hex" },
    ],
  })
  check("salvage: envelope accepted", batch !== null)
  check(
    "salvage: all three records survive (field-level degrade, none dropped)",
    batch?.records.length === 3 && batch?.rejected === 0,
    batch
  )
  check(
    "salvage: a valid captured trace id is preserved (re-emitted as clientTraceId)",
    batch?.records[0]?.trace_id === TRACE_ID
  )
  check(
    "salvage: an all-zero trace id degrades to absent",
    batch?.records[1]?.trace_id === undefined
  )
  check(
    "salvage: a non-canonical trace id degrades to absent",
    batch?.records[2]?.trace_id === undefined
  )
}

// ── Grafana derived fields: both regexes match real pino lines, no cross-match
{
  const yamlPath = fileURLToPath(
    new URL(
      "../../../../infrastructure/observability/grafana-datasources.yaml",
      import.meta.url
    )
  )
  const yaml = readFileSync(yamlPath, "utf8")
  const patterns = [...yaml.matchAll(/matcherRegex:\s*'([^']+)'/g)].map(
    (m) => m[1]!
  )
  const serverPattern = patterns.find((p) => p.includes('"trace_id":"'))
  const clientPattern = patterns.find((p) => p.includes('"clientTraceId":"'))
  check(
    "grafana: both a trace_id and a clientTraceId derived field are configured",
    Boolean(serverPattern && clientPattern),
    patterns
  )

  // Real pino-shaped lines: the server mixin's own trace_id, and the /logs route
  // re-emitting the client's id under clientTraceId.
  const serverLine = `{"level":30,"time":1,"trace_id":"${TRACE_ID}","msg":"server"}`
  const clientLine = `{"level":30,"time":1,"clientDomain":"web.client","clientTraceId":"${TRACE_ID}","msg":"client"}`

  const serverRe = new RegExp(serverPattern!)
  const clientRe = new RegExp(clientPattern!)

  check(
    "grafana: trace_id regex matches the server line",
    serverRe.exec(serverLine)?.[1] === TRACE_ID
  )
  check(
    "grafana: trace_id regex does NOT match a clientTraceId line (no cross-match)",
    !serverRe.test(clientLine)
  )
  check(
    "grafana: clientTraceId regex matches the client line",
    clientRe.exec(clientLine)?.[1] === TRACE_ID
  )
  check(
    "grafana: clientTraceId regex does NOT match a server trace_id line",
    !clientRe.test(serverLine)
  )
}

finish("P-B3")
