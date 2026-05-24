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
      const handle = await runDeviceRuntime({
        serverOrigin,
        broker,
        clientVersion: "0.1.0-device-runtime-v3",
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
    case "bootstrap":
    case "claim-daemon": {
      console.error(
        `synapse-device ${args.cmd}: implementation lands in PR #12 / PR #5; this is a v3.0 stub`
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
