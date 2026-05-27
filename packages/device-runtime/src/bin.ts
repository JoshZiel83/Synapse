#!/usr/bin/env node
// synapse-device CLI — subcommands per docs/device-runtime-v3.md §10.4:
//
//   synapse-device pair               # interactive pairing (local_qr)
//   synapse-device run                # daemon (default)
//   synapse-device rekey              # re-key existing device_runtime
//   synapse-device bootstrap          # cloud sandbox boot
//   synapse-device claim-daemon       # attach remote_agent_daemon (§5.4)
//   synapse-device status             # query status (stub)
//
// v3.0 ships with `run`, `pair`, and `status` end-to-end. `rekey`,
// `bootstrap`, `claim-daemon` are wired but defer to PR #5/#12 for full UX.

import { createFileBackedBroker } from "./broker.js"
import { pair, rekeyDeviceRuntime } from "./pairing.js"
import { runDeviceRuntime } from "./runtime.js"
import { bootstrapCloudDevice } from "./cloud-bootstrap.js"
import { createFilesystemBuiltin } from "./builtins/filesystem.js"
import { createCommandlineBuiltin } from "./builtins/commandline.js"
import { createCuaBuiltin } from "./builtins/cua.js"
import { createBrowserBuiltin } from "./builtins/browser.js"
import { createChromeDevtoolsMcpBuiltin } from "./builtins/chrome-devtools-mcp.js"
import { createFrpTunnelAdapter } from "./tunnel/frp.js"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CatalogProvider } from "./types.js"

interface CliArgs {
  cmd: string
  /** Single-value flags. Last write wins for duplicates of non-repeatable flags. */
  flags: Map<string, string>
  /** Repeatable flags (currently --browser-mcp-arg). */
  repeatableFlags: Map<string, string[]>
}

/**
 * Flags that may be supplied multiple times and should be collected as an array.
 * Anything not in this set defaults to single-value semantics with last-write-wins.
 */
const REPEATABLE_FLAGS = new Set(["browser-mcp-arg"])

function parseArgs(argv: string[]): CliArgs {
  const cmd = argv[0] ?? "run"
  const flags = new Map<string, string>()
  const repeatableFlags = new Map<string, string[]>()
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=")
      const name = eq > 0 ? tok.slice(2, eq) : tok.slice(2)
      const value = eq > 0 ? tok.slice(eq + 1) : (argv[++i] ?? "")
      if (REPEATABLE_FLAGS.has(name)) {
        const arr = repeatableFlags.get(name) ?? []
        arr.push(value)
        repeatableFlags.set(name, arr)
      } else {
        flags.set(name, value)
      }
    }
  }
  return { cmd, flags, repeatableFlags }
}

function getFlag(flags: Map<string, string>, name: string, fallback?: string) {
  return flags.get(name) ?? fallback
}

function getBoolFlag(
  flags: Map<string, string>,
  name: string,
  defaultValue: boolean
): boolean {
  const raw = flags.get(name)
  if (raw === undefined) return defaultValue
  if (raw === "" || raw === "true") return true
  if (raw === "false") return false
  return defaultValue
}

/**
 * Look for synapse-device-cua-helper alongside the runtime install. Returns
 * the first existing path; null if none found. Covers two common layouts:
 *   1. Monorepo dev: <repo>/sidecars/cua/synapse-device-cua-helper
 *   2. Packaged release: <bin-dir>/synapse-device-cua-helper next to the
 *      `synapse-device` JS bundle.
 */
function autoDiscoverCuaHelperPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(
      here,
      "..",
      "..",
      "..",
      "sidecars",
      "cua",
      "synapse-device-cua-helper"
    ),
    resolve(here, "..", "..", "sidecars", "cua", "synapse-device-cua-helper"),
    join(here, "synapse-device-cua-helper"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Parse SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS into a kid → PEM map. Format:
 *   <kid1>:<base64-PEM1>,<kid2>:<base64-PEM2>
 * Empty input returns an empty map (no envelope verification — loopback only).
 */
function parseTrustedServerKeys(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  if (!raw.trim()) return out
  for (const segment of raw.split(",")) {
    const idx = segment.indexOf(":")
    if (idx <= 0) continue
    const kid = segment.slice(0, idx).trim()
    const pemB64 = segment.slice(idx + 1).trim()
    if (!kid || !pemB64) continue
    try {
      const pem = Buffer.from(pemB64, "base64").toString("utf8")
      if (pem.includes("BEGIN PUBLIC KEY")) out.set(kid, pem)
    } catch {
      /* ignore malformed segment */
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const serverOrigin =
    getFlag(args.flags, "server", process.env.SYNAPSE_SERVER_ORIGIN) ??
    "http://localhost:3001"
  const broker = createFileBackedBroker({
    brokerDir: getFlag(args.flags, "broker-dir"),
  })

  switch (args.cmd) {
    case "pair": {
      const code = getFlag(args.flags, "code")
      if (!code) {
        console.error("synapse-device pair: --code <pairing_code> is required")
        process.exit(2)
      }
      const result = await pair({
        serverOrigin,
        broker,
        pairingCode: code,
        mode: "local_qr",
        title: getFlag(args.flags, "title", "My Device"),
        clientVersion: "0.1.0-device-runtime-v3",
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "run": {
      const providers: CatalogProvider[] = [
        createFilesystemBuiltin({
          rootPath: getFlag(args.flags, "fs-root"),
        }),
        createCommandlineBuiltin(),
      ]
      const cuaHelperPath =
        getFlag(args.flags, "cua-helper") ??
        process.env.SYNAPSE_DEVICE_CUA_HELPER_PATH ??
        autoDiscoverCuaHelperPath()
      if (cuaHelperPath && existsSync(cuaHelperPath)) {
        providers.push(createCuaBuiltin({ helperPath: cuaHelperPath }))
      } else if (getFlag(args.flags, "cua") === "off") {
        // explicit opt-out — no-op
      }
      // ── Browser provider selection (v3.1) ────────────────────────────
      // --browser-provider=lite | chrome-devtools (default lite).
      //   lite: keep the v3.0 CDP-based browser builtin. Driven by
      //         --browser-cdp only.
      //   chrome-devtools: wrap the official `chrome-devtools-mcp` sidecar
      //         (8 narrow exposures, operation-aware authz). Defaults
      //         lean safe: --isolated, headless=false, redact-network-
      //         headers, no usage stats/CrUX, all categories off, neither
      //         extensions nor webmcp. High-risk flags
      //         (--browser-url, --browser-proxy-server,
      //         --browser-accept-insecure-certs, --browser-user-data-dir,
      //         --browser-isolated=false) each emit a once-per-process warn.
      const browserProvider =
        getFlag(args.flags, "browser-provider", "lite") ?? "lite"
      const browserCdp = getFlag(args.flags, "browser-cdp")
      if (browserProvider === "lite") {
        if (browserCdp) {
          providers.push(createBrowserBuiltin({ cdpEndpoint: browserCdp }))
        }
        // Warn-and-ignore for chrome-devtools-only flags under lite.
        const chromeOnlyFlags = [
          "browser-mcp-command",
          "browser-headless",
          "browser-isolated",
          "browser-user-data-dir",
          "browser-executable-path",
          "browser-channel",
          "browser-url",
          "browser-proxy-server",
          "browser-accept-insecure-certs",
          "browser-allow-script",
          "browser-allow-network",
          "browser-allow-performance",
        ]
        for (const flag of chromeOnlyFlags) {
          if (args.flags.has(flag)) {
            console.warn(
              `[bin] ignoring --${flag} because --browser-provider=lite`
            )
          }
        }
        if (args.repeatableFlags.has("browser-mcp-arg")) {
          console.warn(
            `[bin] ignoring --browser-mcp-arg because --browser-provider=lite`
          )
        }
      } else if (browserProvider === "chrome-devtools") {
        if (browserCdp) {
          console.warn(
            `[bin] ignoring --browser-cdp because --browser-provider=chrome-devtools`
          )
        }
        const mcpCommandPath = getFlag(args.flags, "browser-mcp-command")
        const mcpExtraArgs = args.repeatableFlags.get("browser-mcp-arg") ?? []
        const mcpCommand = mcpCommandPath
          ? { command: mcpCommandPath, args: [] }
          : undefined
        providers.push(
          createChromeDevtoolsMcpBuiltin({
            mcpCommand,
            mcpExtraArgs,
            headless: getBoolFlag(args.flags, "browser-headless", false),
            isolatedProfile: getBoolFlag(args.flags, "browser-isolated", true),
            userDataDir: getFlag(args.flags, "browser-user-data-dir"),
            executablePath: getFlag(args.flags, "browser-executable-path"),
            channel: getFlag(args.flags, "browser-channel") as
              | "stable"
              | "beta"
              | "dev"
              | "canary"
              | undefined,
            browserUrl: getFlag(args.flags, "browser-url"),
            proxyServer: getFlag(args.flags, "browser-proxy-server"),
            acceptInsecureCerts: args.flags.has(
              "browser-accept-insecure-certs"
            ),
            allowScript: args.flags.has("browser-allow-script"),
            allowNetwork: args.flags.has("browser-allow-network"),
            allowPerformance: args.flags.has("browser-allow-performance"),
          })
        )
      } else {
        console.warn(
          `[bin] unknown --browser-provider=${browserProvider}; no browser provider registered`
        )
      }
      // Parse trusted server keys: env value is "<kid>:<base64-PEM>,..." so
      // multiple kids can be carried for rotation. The runtime refuses to
      // invoke any tool whose envelope can't be verified against one of these
      // keys — set to empty string for loopback smoke tests only.
      const trustedServerKeys = parseTrustedServerKeys(
        getFlag(args.flags, "trusted-server-keys") ??
          process.env.SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS ??
          ""
      )
      // Auto-wire the frp tunnel when the operator provides the edge config.
      // Without this, the runtime would connect to the control-plane but
      // never register a tunnel endpoint, and every dispatched tool call
      // would fail with no_tunnel_endpoint. The four flags can all come
      // from env (SYNAPSE_TUNNEL_*) so packaged binaries don't need flags.
      const tunnelServerAddr =
        getFlag(args.flags, "tunnel-server-addr") ??
        process.env.SYNAPSE_TUNNEL_SERVER_ADDR
      const tunnelServerPortRaw =
        getFlag(args.flags, "tunnel-server-port") ??
        process.env.SYNAPSE_TUNNEL_SERVER_PORT
      const tunnelAuthToken =
        getFlag(args.flags, "tunnel-auth-token") ??
        process.env.SYNAPSE_TUNNEL_AUTH_TOKEN
      const tunnelVhost =
        getFlag(args.flags, "tunnel-vhost") ??
        process.env.SYNAPSE_TUNNEL_VHOST_HOST
      const tunnelRegistrationToken =
        getFlag(args.flags, "tunnel-registration-token") ??
        process.env.SYNAPSE_TUNNEL_REGISTRATION_TOKEN
      let tunnel: { adapter: any; registrationToken: string } | undefined
      // Server-issued tunnel path token (delivered via device.hello ack)
      // takes precedence; the env-supplied registrationToken is a fallback
      // for environments where the server hasn't started issuing one. Both
      // path token and adapter config (server addr / port / auth / vhost)
      // must be present for the runtime to even attempt frpc.
      //
      // The runtime handle is created AFTER the adapter, so we wire the
      // adapter's onUnexpectedExit through a mutable closure: bin.ts
      // populates `runtimeRef.handle` once runDeviceRuntime resolves; if
      // frpc dies later, the callback fires runtimeRef.handle.notifyTunnelDown
      // so the API stops routing dispatches to a dead tunnel.
      const runtimeRef: {
        handle: { notifyTunnelDown(reason: string): void } | null
      } = { handle: null }
      if (
        tunnelServerAddr &&
        tunnelServerPortRaw &&
        tunnelAuthToken &&
        tunnelVhost
      ) {
        const tunnelServerPort = Number.parseInt(tunnelServerPortRaw, 10)
        if (Number.isFinite(tunnelServerPort)) {
          tunnel = {
            adapter: createFrpTunnelAdapter({
              serverAddr: tunnelServerAddr,
              serverPort: tunnelServerPort,
              authToken: tunnelAuthToken,
              vhostHost: tunnelVhost,
              frpcPath: getFlag(args.flags, "frpc-path") ?? "frpc",
              onUnexpectedExit: ({ code, signal }) => {
                runtimeRef.handle?.notifyTunnelDown(
                  `frpc exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
                )
              },
            }),
            registrationToken: tunnelRegistrationToken ?? "",
          }
        }
      }
      const handle = await runDeviceRuntime({
        serverOrigin,
        broker,
        clientVersion: "0.1.0-device-runtime-v3",
        initialCatalog: providers,
        trustedServerKeys,
        tunnel,
      })
      // Now that the runtime is up, hook its notifyTunnelDown into the
      // closure the frp adapter captured at construction time. The cast
      // is safe because notifyTunnelDown was added to EmbeddedRuntimeHandle
      // alongside this wiring (see runtime.ts).
      runtimeRef.handle = handle as unknown as {
        notifyTunnelDown(reason: string): void
      }
      process.on("SIGINT", () => {
        void handle.stop()
      })
      process.on("SIGTERM", () => {
        void handle.stop()
      })
      await handle.done
      return
    }
    case "rekey": {
      const deviceId = getFlag(args.flags, "device-id")
      if (!deviceId) {
        console.error("synapse-device rekey: --device-id is required")
        process.exit(2)
      }
      const result = await rekeyDeviceRuntime({
        serverOrigin,
        broker,
        deviceId,
        clientVersion: "0.1.0-device-runtime-v3",
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "status": {
      const identity = await broker.loadDeviceIdentity()
      console.log(
        JSON.stringify(
          {
            broker_file: broker.brokerFilePath,
            identity,
          },
          null,
          2
        )
      )
      return
    }
    case "bootstrap": {
      const token = getFlag(args.flags, "bootstrap-token")
      if (!token) {
        console.error(
          "synapse-device bootstrap: --bootstrap-token <token> is required"
        )
        process.exit(2)
      }
      const result = await bootstrapCloudDevice({
        serverOrigin,
        broker,
        bootstrapToken: token,
        clientVersion: "0.1.0-device-runtime-v3",
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    case "claim-daemon": {
      console.error(
        `synapse-device ${args.cmd}: not yet wired in v3.0 CLI; use the dashboard "Attach remote agent daemon" button (PR #5+)`
      )
      process.exit(2)
      return
    }
    default: {
      console.error(`unknown command: ${args.cmd}`)
      process.exit(2)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
