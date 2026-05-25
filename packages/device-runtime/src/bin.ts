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
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CatalogProvider } from "./types.js"

interface CliArgs {
  cmd: string
  flags: Map<string, string>
}

function parseArgs(argv: string[]): CliArgs {
  const cmd = argv[0] ?? "run"
  const flags = new Map<string, string>()
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=")
      if (eq > 0) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1))
      } else {
        flags.set(tok.slice(2), argv[++i] ?? "")
      }
    }
  }
  return { cmd, flags }
}

function getFlag(flags: Map<string, string>, name: string, fallback?: string) {
  return flags.get(name) ?? fallback
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
    resolve(here, "..", "..", "..", "sidecars", "cua", "synapse-device-cua-helper"),
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
      const browserCdp = getFlag(args.flags, "browser-cdp")
      if (browserCdp) {
        providers.push(createBrowserBuiltin({ cdpEndpoint: browserCdp }))
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
      const handle = await runDeviceRuntime({
        serverOrigin,
        broker,
        clientVersion: "0.1.0-device-runtime-v3",
        initialCatalog: providers,
        trustedServerKeys,
      })
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
