// P-A8 (OTel env compliance) — §4.A of
// docs/trace-correctness-remediation-plan-2026-07-12.md:
//   - the export gate honors the per-signal OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
//     variant alone (previously only the base endpoint enabled export);
//   - neither endpoint set ⇒ spans created but nothing exported;
//   - OTEL_RESOURCE_ATTRIBUTES honored via envDetector, and the explicit
//     service.namespace=synapse resource attribute is present;
//   - a dead OTLP endpoint surfaces as diag ERROR output (export failures were
//     previously fully silent).
// Run: npx tsx scripts/trace-probes/p-a8-env-compliance.ts
import { check, finish, runBootProbe, startOtlpCatcher } from "./_shared.js"

// --- 1: per-signal _TRACES_ENDPOINT alone enables export ---------------------
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    // Per-signal form is used AS-IS (no /v1/traces suffix appended).
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${otlp.url}/v1/traces`,
  })
  check("_TRACES_ENDPOINT-only: child exits 0", run.code === 0, run.stderr)
  check(
    "_TRACES_ENDPOINT-only: spans exported",
    otlp.posts.length > 0 && otlp.text().includes("GET /ping")
  )
  await otlp.close()
}

// --- 2: neither endpoint ⇒ spans created, nothing exported -------------------
{
  const run = await runBootProbe({})
  check("no-endpoint: child exits 0", run.code === 0, run.stderr)
  check(
    "no-endpoint: spans still created (recording route span)",
    run.result?.ping.recording === true,
    run.result
  )
}

// --- 3: OTEL_RESOURCE_ATTRIBUTES + explicit resource attributes --------------
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    OTEL_RESOURCE_ATTRIBUTES: "synapse.probe=pa8-env-marker",
    OTEL_SERVICE_NAME: "pa8-service",
  })
  check("resource case: child exits 0", run.code === 0, run.stderr)
  const payload = otlp.text()
  check(
    "OTEL_RESOURCE_ATTRIBUTES honored (envDetector)",
    payload.includes("synapse.probe") && payload.includes("pa8-env-marker")
  )
  check(
    "explicit service.namespace=synapse resource attribute present",
    payload.includes("service.namespace") && payload.includes("synapse")
  )
  check(
    "OTEL_SERVICE_NAME wins as service.name",
    payload.includes("pa8-service")
  )
  await otlp.close()
}

// --- 4: dead OTLP endpoint ⇒ diag ERROR on stderr (not silent) ---------------
{
  const run = await runBootProbe({
    // Nothing listens here; the exporter must fail LOUDLY at default log level.
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
  })
  check("dead-endpoint: child still exits 0", run.code === 0)
  check(
    "dead-endpoint: export failure surfaces as diag ERROR output",
    /error|failed|ECONNREFUSED/i.test(run.stderr),
    run.stderr.slice(0, 400)
  )
}

// --- 5 (F13): OTEL_TRACES_EXPORTER=none ⇒ endpoint set but ZERO spans exported
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    OTEL_TRACES_EXPORTER: "none",
  })
  check("exporter=none: child exits 0", run.code === 0, run.stderr)
  check(
    "exporter=none: NOTHING is exported despite the endpoint (off switch)",
    otlp.posts.length === 0,
    `${otlp.posts.length} posts`
  )
  await otlp.close()
}

// --- 6 (F13): OTEL_TRACES_EXPORTER=otlp ⇒ export ON (explicit affirmative) ----
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    OTEL_TRACES_EXPORTER: "otlp",
  })
  check("exporter=otlp: child exits 0", run.code === 0, run.stderr)
  check(
    "exporter=otlp: spans exported",
    otlp.posts.length > 0 && otlp.text().includes("GET /ping")
  )
  await otlp.close()
}

// --- 7 (F13): OTEL_TRACES_EXPORTER=bogus ⇒ export still ON + diag ERROR -------
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    OTEL_TRACES_EXPORTER: "bogus",
  })
  check("exporter=bogus: child exits 0", run.code === 0, run.stderr)
  check(
    "exporter=bogus: treated as unset ⇒ spans still exported",
    otlp.posts.length > 0
  )
  check(
    "exporter=bogus: surfaces the OTEL_TRACES_EXPORTER diag ERROR line",
    /OTEL_TRACES_EXPORTER/i.test(run.stderr),
    run.stderr.slice(0, 400)
  )
  await otlp.close()
}

// --- 8 (F13 precedence): OTEL_RESOURCE_ATTRIBUTES service.name wins alone -----
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    // OTEL_SERVICE_NAME neutralized to "" by the baseline ⇒ RA's service.name
    // must win (pre-fix the house literal merged last and forced synapse-api).
    OTEL_RESOURCE_ATTRIBUTES:
      "service.name=ra-service-marker,service.namespace=ns-override-marker",
  })
  check("precedence RA-only: child exits 0", run.code === 0, run.stderr)
  const payload = otlp.text()
  check(
    "precedence: OTEL_RESOURCE_ATTRIBUTES service.name wins when OTEL_SERVICE_NAME unset",
    payload.includes("ra-service-marker")
  )
  check(
    "precedence: OTEL_RESOURCE_ATTRIBUTES service.namespace overrides the house default",
    payload.includes("ns-override-marker")
  )
  await otlp.close()
}

// --- 9 (F13 precedence): OTEL_SERVICE_NAME beats OTEL_RESOURCE_ATTRIBUTES -----
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({
    OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url,
    OTEL_SERVICE_NAME: "svc-name-marker",
    OTEL_RESOURCE_ATTRIBUTES: "service.name=ra-loser-marker",
  })
  check("precedence SVC>RA: child exits 0", run.code === 0, run.stderr)
  const payload = otlp.text()
  check(
    "precedence: OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES service.name",
    payload.includes("svc-name-marker")
  )
  await otlp.close()
}

// --- 10 (F13 precedence): neither set ⇒ synapse-api / synapse fallback --------
{
  const otlp = await startOtlpCatcher()
  const run = await runBootProbe({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.url })
  check("precedence default: child exits 0", run.code === 0, run.stderr)
  const payload = otlp.text()
  check(
    "precedence: neither env set ⇒ service.name=synapse-api",
    payload.includes("synapse-api")
  )
  check(
    "precedence: neither env set ⇒ service.namespace=synapse",
    payload.includes("service.namespace") && payload.includes("synapse")
  )
  await otlp.close()
}

finish("P-A8")
