// Relay harness: pair a synapse-relay process with a running API instance,
// then start the relay normally with extra mock MCP servers injected.

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const INTEGRATION_DIR = join(__dirname, "..")
const WORKTREE_ROOT = join(INTEGRATION_DIR, "../../../..")

export const RELAY_BIN_PATH = join(INTEGRATION_DIR, ".cache/synapse-relay")
export const MCP_SERVERS_DIR = join(INTEGRATION_DIR, "mocks/mcp-servers")

export interface MockMcpServerSpec {
  name: string
  // basename of the .mjs file under mocks/mcp-servers/, e.g. "image-base64.mjs"
  script: string
  env?: Record<string, string>
}

export interface RelayHandle {
  proc: ChildProcessWithoutNullStreams
  homeDir: string
  configPath: string
  deviceId: string
  stop: () => Promise<void>
}

async function createPairingSession(opts: {
  apiBaseUrl: string
  sessionToken: string
  workspaceId: string
  title?: string
}): Promise<string> {
  const res = await fetch(
    `${opts.apiBaseUrl}/api/v1/workspaces/${opts.workspaceId}/mcp/relays/pairing-sessions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.sessionToken}`,
      },
      body: JSON.stringify({ title: opts.title ?? "int-test-relay" }),
    }
  )
  if (res.status !== 201) {
    const body = await res.text()
    throw new Error(`createPairingSession failed (${res.status}): ${body}`)
  }
  const json = (await res.json()) as { pairing?: { pairingCode?: string } }
  const code = json?.pairing?.pairingCode
  if (!code) {
    throw new Error(
      `createPairingSession returned no pairingCode: ${JSON.stringify(json)}`
    )
  }
  return code
}

function runPair(opts: {
  apiBaseUrl: string
  pairingCode: string
  homeDir: string
  displayName?: string
}): void {
  const result = spawnSync(
    RELAY_BIN_PATH,
    [
      "--pair",
      `--server-base-url=${opts.apiBaseUrl}`,
      `--pairing-code=${opts.pairingCode}`,
      `--display-name=${opts.displayName ?? "int-test-relay"}`,
    ],
    {
      env: { ...process.env, HOME: opts.homeDir },
      cwd: opts.homeDir,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  if (result.status !== 0) {
    throw new Error(
      `synapse-relay --pair failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
    )
  }
}

function loadConfigYaml(configPath: string): {
  lines: string[]
  deviceId: string
} {
  const raw = readFileSync(configPath, "utf8")
  const deviceMatch = raw.match(/^\s*device_id:\s*"?([^"\s]+)"?/m)
  if (!deviceMatch) {
    throw new Error(`config.yaml at ${configPath} has no device_id:\n${raw}`)
  }
  return { lines: raw.split("\n"), deviceId: deviceMatch[1] }
}

function injectMcpServers(
  configPath: string,
  servers: MockMcpServerSpec[]
): void {
  if (servers.length === 0) return
  let raw = readFileSync(configPath, "utf8")

  // YAML block for the new servers (must be indented like the existing list).
  const block = servers
    .map((s) => {
      const envLines = Object.entries(s.env || {})
        .map(([k, v]) => `        ${k}: "${v}"`)
        .join("\n")
      return [
        `    - name: "${s.name}"`,
        `      transport: "stdio"`,
        `      command: "node"`,
        `      args: ["${join(MCP_SERVERS_DIR, s.script)}"]`,
        ...(envLines ? [`      env:`, envLines] : []),
      ].join("\n")
    })
    .join("\n")

  // Replace the `servers: []` line (empty list) with `servers:` + entries.
  if (/^servers:\s*\[\]\s*$/m.test(raw)) {
    raw = raw.replace(/^servers:\s*\[\]\s*$/m, `servers:\n${block}`)
  } else if (/^servers:\s*\n/m.test(raw)) {
    raw = raw.replace(/^servers:\s*\n/m, `servers:\n${block}\n`)
  } else {
    raw = raw.replace(/\s*$/, "\n") + `servers:\n${block}\n`
  }

  writeFileSync(configPath, raw, "utf8")
}

export async function pairAndStartRelay(opts: {
  apiBaseUrl: string
  sessionToken: string
  workspaceId: string
  displayName?: string
  mcpServers: MockMcpServerSpec[]
  silent?: boolean
}): Promise<RelayHandle> {
  const homeDir = mkdtempSync(join(tmpdir(), "synapse-int-test-relay-home-"))

  // synapse-relay --pair calls config.LoadOrDefault(path), which still fails
  // if the file doesn't exist. Pre-create an empty config in the profile dir.
  const profileDir = join(
    homeDir,
    ".synapse/relay/cli/profiles/standalone-default"
  )
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, "config.yaml"), "log_level: info\n", "utf8")

  const pairingCode = await createPairingSession({
    apiBaseUrl: opts.apiBaseUrl,
    sessionToken: opts.sessionToken,
    workspaceId: opts.workspaceId,
    title: opts.displayName,
  })

  runPair({
    apiBaseUrl: opts.apiBaseUrl,
    pairingCode,
    homeDir,
    displayName: opts.displayName,
  })

  const configPath = join(
    homeDir,
    ".synapse/relay/cli/profiles/standalone-default/config.yaml"
  )
  const { deviceId } = loadConfigYaml(configPath)
  injectMcpServers(configPath, opts.mcpServers)

  const proc = spawn(RELAY_BIN_PATH, ["-c", configPath], {
    env: { ...process.env, HOME: homeDir },
    cwd: homeDir,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let exited = false
  proc.on("exit", () => {
    exited = true
  })

  if (!opts.silent) {
    proc.stdout.on("data", (b) => process.stderr.write(`[relay stdout] ${b}`))
    proc.stderr.on("data", (b) => process.stderr.write(`[relay stderr] ${b}`))
  }

  // Wait a bit for the relay to connect + advertise catalog.
  await new Promise((r) => setTimeout(r, 2500))
  if (exited) {
    throw new Error(
      "synapse-relay exited before reaching steady state. Check logs above."
    )
  }

  return {
    proc,
    homeDir,
    configPath,
    deviceId,
    stop: async () => {
      if (!exited) {
        proc.kill("SIGTERM")
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            try {
              proc.kill("SIGKILL")
            } catch {}
            resolve()
          }, 5000)
          proc.once("exit", () => {
            clearTimeout(t)
            resolve()
          })
        })
      }
      try {
        proc.stdout?.destroy()
      } catch {}
      try {
        proc.stderr?.destroy()
      } catch {}
      try {
        rmSync(homeDir, { recursive: true, force: true })
      } catch {}
    },
  }
}

export async function waitForRelayDeviceReady(opts: {
  apiBaseUrl: string
  sessionToken: string
  workspaceId: string
  deviceId: string
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const res = await fetch(
      `${opts.apiBaseUrl}/api/v1/workspaces/${opts.workspaceId}/mcp/relays`,
      {
        headers: { authorization: `Bearer ${opts.sessionToken}` },
      }
    )
    if (res.status === 200) {
      const json = (await res.json()) as {
        devices?: Array<{ deviceId?: string; id?: string }>
      }
      const found = json.devices?.find(
        (d) => d.deviceId === opts.deviceId || d.id === opts.deviceId
      )
      if (found) return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`relay device ${opts.deviceId} did not appear within timeout`)
}
