// Shared harness for the P-A probes (§7 of
// docs/trace-correctness-remediation-plan-2026-07-12.md): a local OTLP catcher
// (stands in for Alloy/Tempo — no live backend needed), a local Sentry
// envelope catcher (stands in for a Sentry server), and a child-process runner
// for src/instrumentation.boot-probe.ts. Each probe is standalone:
//   npx tsx scripts/trace-probes/p-aN-*.ts
import http from "node:http"
import net from "node:net"
import zlib from "node:zlib"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export const TSX_BIN = fileURLToPath(
  new URL("../../../../node_modules/.bin/tsx", import.meta.url)
)
export const API_DIR = fileURLToPath(new URL("../..", import.meta.url))
export const BOOT_PROBE = fileURLToPath(
  new URL("../../src/instrumentation.boot-probe.ts", import.meta.url)
)

let pass = 0
let fail = 0
export function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++
    console.log(`PASS ${label}`)
  } else {
    fail++
    console.error(`FAIL ${label}`, detail ?? "")
  }
}

export function finish(name: string): never {
  console.log(`\n${name}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("error", reject)
    req.on("end", () => {
      let body = Buffer.concat(chunks)
      const encoding = req.headers["content-encoding"]
      if (encoding === "gzip") body = zlib.gunzipSync(body)
      else if (encoding === "deflate") body = zlib.inflateSync(body)
      resolve(body)
    })
  })
}

// --- OTLP catcher -----------------------------------------------------------
// Accepts OTLP/HTTP-proto POSTs. Probes assert on the raw payload bytes: span
// names, attribute KEYS, and attribute string VALUES are embedded as
// length-prefixed UTF-8 in the protobuf, so substring counting is exact enough
// for unique probe-chosen markers.

export interface OtlpCatcher {
  url: string
  posts: Buffer[]
  text(): string
  count(marker: string): number
  close(): Promise<void>
}

export async function startOtlpCatcher(
  // P-I2 binds 0.0.0.0 so a docker container can reach it via host-gateway.
  bindHost = "127.0.0.1"
): Promise<OtlpCatcher> {
  const posts: Buffer[] = []
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      posts.push(body)
      res.writeHead(200, { "content-type": "application/x-protobuf" })
      res.end()
    })
  })
  server.listen(0, bindHost)
  await once(server, "listening")
  const { port } = server.address() as net.AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    text() {
      return Buffer.concat(posts).toString("latin1")
    },
    count(marker: string) {
      const haystack = this.text()
      let n = 0
      for (
        let i = haystack.indexOf(marker);
        i !== -1;
        i = haystack.indexOf(marker, i + 1)
      ) {
        n++
      }
      return n
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

// --- Sentry envelope catcher -------------------------------------------------

export interface SentryEnvelopeItem {
  header: Record<string, unknown>
  payload: unknown
}

export interface SentryCatcher {
  dsn: string
  items: SentryEnvelopeItem[]
  itemsOfType(type: string): SentryEnvelopeItem[]
  close(): Promise<void>
}

function parseEnvelope(body: string, into: SentryEnvelopeItem[]): void {
  const lines = body.split("\n").filter((l) => l.length > 0)
  // line 0 = envelope header; then alternating item-header / payload lines.
  for (let i = 1; i + 1 < lines.length; i += 2) {
    try {
      const header = JSON.parse(lines[i]!) as Record<string, unknown>
      let payload: unknown = lines[i + 1]
      try {
        payload = JSON.parse(lines[i + 1]!)
      } catch {
        /* non-JSON payload (attachment) — keep raw */
      }
      into.push({ header, payload })
    } catch {
      /* skip malformed line pair */
    }
  }
}

export async function startSentryCatcher(): Promise<SentryCatcher> {
  const items: SentryEnvelopeItem[] = []
  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      parseEnvelope(body.toString("utf8"), items)
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as net.AddressInfo
  return {
    dsn: `http://examplepublickey@127.0.0.1:${port}/1`,
    items,
    itemsOfType(type: string) {
      return items.filter((i) => i.header.type === type)
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

// --- boot-probe child runner --------------------------------------------------

/** Baseline: neutralize every observability var the repo .env might set (dotenv
 * never overrides already-set vars, and instrumentation.ts treats empty string
 * as unset per the OTel env spec). */
const BASELINE_ENV: Record<string, string> = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
  OTEL_SERVICE_NAME: "",
  OTEL_TRACES_SAMPLER: "",
  OTEL_TRACES_SAMPLER_ARG: "",
  OTEL_SDK_DISABLED: "",
  OTEL_LOG_LEVEL: "",
  OTEL_RESOURCE_ATTRIBUTES: "",
  OTEL_SEMCONV_STABILITY_OPT_IN: "",
  SENTRY_DSN: "",
  SENTRY_TRACES_SAMPLE_RATE: "",
  SYNAPSE_TRACE_FIRST_PARTY_HOSTS: "",
}

export function baselineEnv(
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  return { ...process.env, ...BASELINE_ENV, ...overrides }
}

export interface BootProbeRun {
  code: number | null
  stdout: string
  stderr: string
  bootOk: boolean
  result?: {
    ping: { status: number; recording?: boolean }
    health: { status: number; recording?: boolean }
  }
}

export async function runBootProbe(
  overrides: Record<string, string>
): Promise<BootProbeRun> {
  const child = spawn(TSX_BIN, [BOOT_PROBE], {
    cwd: API_DIR,
    env: baselineEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  const [code] = (await once(child, "exit")) as [number | null]
  clearTimeout(timer)
  const resultLine = stdout
    .split("\n")
    .find((l) => l.startsWith("BOOT_RESULT "))
  return {
    code,
    stdout,
    stderr,
    bootOk: stdout.includes("BOOT_OK"),
    result: resultLine
      ? (JSON.parse(resultLine.slice("BOOT_RESULT ".length)) as {
          ping: { status: number; recording?: boolean }
          health: { status: number; recording?: boolean }
        })
      : undefined,
  }
}
