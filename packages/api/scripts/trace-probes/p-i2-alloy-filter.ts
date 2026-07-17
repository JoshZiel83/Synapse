/**
 * P-I2 — Alloy health-span filter (trace remediation plan §7, §4.I change 8).
 *
 * Boots the REPO's real `infrastructure/observability/config.alloy` on the
 * pinned `grafana/alloy:v1.5.1` image (the only mutation: the Tempo exporter
 * endpoint is rewritten to a local OTLP catcher standing in for Tempo) and
 * asserts:
 *
 *   1. the config LOADS — `otelcol.processor.filter "drop_probe_spans"` builds
 *      at default stability and the OTLP pipeline comes up;
 *   2. an OTLP-posted span with `url.path == "/healthz"` (and the legacy
 *      `http.target == "/api/v1/health"` variant) is DROPPED;
 *   3. a normal span is DELIVERED through the same pipeline.
 *
 * Requires a working docker daemon (the image is already pinned by
 * docker-compose.yml). Run from packages/api:
 *   npx tsx scripts/trace-probes/p-i2-alloy-filter.ts
 */
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { check, finish, startOtlpCatcher } from "./_shared.js"

const CONFIG_PATH = fileURLToPath(
  new URL(
    "../../../../infrastructure/observability/config.alloy",
    import.meta.url
  )
)
const IMAGE = "grafana/alloy:v1.5.1" // pinned in docker-compose.yml
const CONTAINER = `p-i2-alloy-${process.pid}`

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex")
}

function otlpSpan(name: string, attrs: Record<string, string>) {
  const now = String(Date.now() * 1e6)
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "p-i2-probe" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "p-i2" },
            spans: [
              {
                traceId: hex(16),
                spanId: hex(8),
                name,
                kind: 2,
                startTimeUnixNano: now,
                endTimeUnixNano: now,
                attributes: Object.entries(attrs).map(([key, v]) => ({
                  key,
                  value: { stringValue: v },
                })),
              },
            ],
          },
        ],
      },
    ],
  }
}

async function postSpan(
  otlpUrl: string,
  name: string,
  attrs: Record<string, string>
): Promise<number> {
  const res = await fetch(`${otlpUrl}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(otlpSpan(name, attrs)),
  })
  return res.status
}

async function main() {
  // The catcher must be reachable FROM the container via host-gateway.
  const catcher = await startOtlpCatcher("0.0.0.0")
  const catcherPort = new URL(catcher.url).port

  // Real config verbatim except the Tempo endpoint → the catcher. Assert the
  // filter block is present in the REAL file before rewriting (so the probe
  // fails loudly if the config regresses rather than silently passing spans).
  const realConfig = fs.readFileSync(CONFIG_PATH, "utf8")
  check(
    "config.alloy declares otelcol.processor.filter drop_probe_spans",
    realConfig.includes('otelcol.processor.filter "drop_probe_spans"')
  )
  check(
    "receiver routes traces through the filter (not straight to tempo)",
    realConfig.includes("otelcol.processor.filter.drop_probe_spans.input")
  )
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-i2-alloy-"))
  const tmpConfig = path.join(tmpDir, "config.alloy")
  fs.writeFileSync(
    tmpConfig,
    realConfig.replace(
      "http://tempo:4318",
      `http://host.docker.internal:${catcherPort}`
    )
  )

  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    CONTAINER,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    "127.0.0.1::4318",
    "-v",
    `${tmpConfig}:/etc/alloy/config.alloy:ro`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "-e",
    "COMPOSE_PROJECT_NAME=p-i2-none",
    IMAGE,
    "run",
    "--server.http.listen-addr=0.0.0.0:12345",
    "/etc/alloy/config.alloy"
  )

  try {
    const mapped = docker("port", CONTAINER, "4318/tcp").split("\n")[0]!.trim()
    const otlpUrl = `http://${mapped.replace("0.0.0.0", "127.0.0.1")}`

    // Wait for the OTLP receiver to come up (proves the config LOADED — a
    // component build failure keeps the whole pipeline down).
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      try {
        up = (await postSpan(otlpUrl, "pi2-warmup", {})) === 200
      } catch {
        /* connection refused while booting */
      }
      if (!up) await sleep(500)
    }
    check("alloy booted with the real config (OTLP receiver answering)", up)

    const normalMarker = `pi2-normal-${hex(4)}`
    const healthMarker = `pi2-health-${hex(4)}`
    const legacyMarker = `pi2-legacy-${hex(4)}`
    const routeMarker = `pi2-route-${hex(4)}`

    check(
      "normal span accepted",
      (await postSpan(otlpUrl, normalMarker, {
        "url.path": "/api/v1/chat",
      })) === 200
    )
    check(
      "healthz span accepted at the receiver (dropped later, not rejected)",
      (await postSpan(otlpUrl, healthMarker, { "url.path": "/healthz" })) ===
        200
    )
    check(
      "legacy-semconv health span accepted",
      (await postSpan(otlpUrl, legacyMarker, {
        "http.target": "/api/v1/health",
      })) === 200
    )
    check(
      "http.route health span accepted",
      (await postSpan(otlpUrl, routeMarker, { "http.route": "/healthz" })) ===
        200
    )

    // Wait until the NORMAL span arrives at the catcher, then settle.
    let delivered = false
    for (let i = 0; i < 60 && !delivered; i++) {
      delivered = catcher.count(normalMarker) > 0
      if (!delivered) await sleep(500)
    }
    check("normal span DELIVERED to the tempo exporter target", delivered)
    await sleep(3000) // settle: give any (wrongly) unfiltered span time to flush

    check(
      "url.path==/healthz span DROPPED",
      catcher.count(healthMarker) === 0,
      catcher.count(healthMarker)
    )
    check(
      "http.target==/api/v1/health span DROPPED",
      catcher.count(legacyMarker) === 0,
      catcher.count(legacyMarker)
    )
    check(
      "http.route==/healthz span DROPPED",
      catcher.count(routeMarker) === 0,
      catcher.count(routeMarker)
    )
  } finally {
    try {
      docker("rm", "-f", CONTAINER)
    } catch {
      /* already gone */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
    await catcher.close()
  }

  finish("P-I2 (alloy health-span filter)")
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
