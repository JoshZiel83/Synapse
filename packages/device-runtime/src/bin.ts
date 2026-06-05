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
import { bwrapAvailable } from "./terminal/sandbox-confinement.js"
import { createCuaBuiltin } from "./builtins/cua.js"
import { createBrowserBuiltin } from "./builtins/browser.js"
import { createChromeDevtoolsMcpBuiltin } from "./builtins/chrome-devtools-mcp.js"
import { createFrpTunnelAdapter } from "./tunnel/frp.js"
import { createNoopTunnelAdapter } from "./tunnel/noop.js"
import {
  defaultPrestageDirs,
  installBundles,
  summarizeInstallReport,
} from "./bundles/install.js"
import {
  defaultManifestPath,
  defaultPackageRoot,
  defaultToolchainDir,
  loadManifestFromPath,
} from "./bundles/manifest-loader.js"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { CatalogProvider } from "./types.js"
import type { TerminalPlatform } from "./terminal/types.js"
import { resolveSidecarPath } from "./builtins/fs-helper-resolve.js"

// Argv parsing + getFlag live in cli-args.ts so unit tests can
// exercise the parsing rules without triggering bin.ts's top-level
// `main()` call.
import type { CliArgs } from "./cli-args.js"
import { parseArgs, getFlag } from "./cli-args.js"
export { parseArgs, getFlag } from "./cli-args.js"
export type { CliArgs } from "./cli-args.js"

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
 * the first existing path; undefined if none found. Covers two common layouts:
 *   1. Monorepo dev: <repo>/sidecars/cua/synapse-device-cua-helper
 *   2. Packaged release: <bin-dir>/synapse-device-cua-helper next to the
 *      `synapse-device` JS bundle.
 */
function autoDiscoverCuaHelperPath(): string | undefined {
  return resolveSidecarPath({
    roots: sidecarRoots("cua"),
    // cua ships a flat binary (no target/release layout): bare name only.
    suffixes: ["synapse-device-cua-helper"],
    mode: "release-first",
  })
}

function autoDiscoverFsHelperPath(): string | undefined {
  return resolveSidecarPath({
    roots: sidecarRoots("fs-helper"),
    suffixes: [
      join("target", "release", "synapse-device-fs-helper"),
      "synapse-device-fs-helper",
    ],
    mode: "release-first",
  })
}

/**
 * Candidate roots for a sidecar dir, anchored on this file's location:
 *   - <repo>/sidecars/<dir> at the two monorepo depths (src vs dist), and
 *   - the bin directory itself (packaged release: binary flat next to the JS
 *     bundle), so a bare-name suffix resolves alongside the install.
 */
function sidecarRoots(sidecarDir: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    resolve(here, "..", "..", "..", "sidecars", sidecarDir),
    resolve(here, "..", "..", "sidecars", sidecarDir),
    here,
  ]
}

function isOn(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === "on" || value === "true" || value === "1"
}

function isOff(value: string | undefined): boolean {
  return value === "off" || value === "false" || value === "0"
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
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
      // ─── Filesystem builtin config (full v3 surface) ───
      const fsRoot = getFlag(args.flags, "fs-root")
      const fsHelperPath =
        getFlag(args.flags, "fs-helper") ??
        process.env.SYNAPSE_DEVICE_FS_HELPER_PATH ??
        autoDiscoverFsHelperPath()
      const brokerDir = getFlag(args.flags, "broker-dir")
      const fsWorkDir =
        getFlag(args.flags, "fs-work-dir") ??
        process.env.SYNAPSE_DEVICE_FS_WORK_DIR ??
        // Default: <dirname(broker file)>/fs. The broker always has a file
        // path even when --broker-dir wasn't passed (createFileBackedBroker
        // picks the OS-conventional location), so this default works in
        // every deployment without requiring extra flags.
        join(dirname(broker.brokerFilePath), "fs")
      const fsTika =
        getFlag(args.flags, "fs-tika-endpoint") ??
        process.env.SYNAPSE_DEVICE_FS_TIKA_ENDPOINT
      const fsEnableWrite = isOn(
        getFlag(args.flags, "fs-enable-write") ??
          process.env.SYNAPSE_DEVICE_FS_ENABLE_WRITE,
        false
      )
      const fsEnableDelete = isOn(
        getFlag(args.flags, "fs-enable-delete") ??
          process.env.SYNAPSE_DEVICE_FS_ENABLE_DELETE,
        false
      )
      const fsDisableRead = isOn(
        getFlag(args.flags, "fs-disable-read") ??
          process.env.SYNAPSE_DEVICE_FS_DISABLE_READ,
        false
      )
      const fsDisableHistory = isOn(
        getFlag(args.flags, "fs-disable-history") ??
          process.env.SYNAPSE_DEVICE_FS_DISABLE_HISTORY,
        false
      )
      const fsAllowUnversioned = isOn(
        getFlag(args.flags, "fs-allow-unversioned-write") ??
          process.env.SYNAPSE_DEVICE_FS_ALLOW_UNVERSIONED_WRITE,
        false
      )
      // --cmd-sandbox: confine every commandline invocation in a bwrap jail
      // rooted at the fs-root (no network, host FS unreachable outside the
      // mount points). Set by the platform's sandbox provisioner. Linux-only.
      const cmdSandbox = isOn(
        getFlag(args.flags, "cmd-sandbox") ??
          process.env.SYNAPSE_DEVICE_CMD_SANDBOX,
        false
      )
      // --cmd-sandbox-share-net: do NOT --unshare-net in the bwrap jail; the
      // command shares the runtime's netns and network isolation is the
      // container's job (Docker without CAP_NET_ADMIN, where --unshare-net's
      // loopback bring-up fails). Only meaningful with --cmd-sandbox.
      const cmdSandboxShareNet = isOn(
        getFlag(args.flags, "cmd-sandbox-share-net") ??
          process.env.SYNAPSE_DEVICE_CMD_SANDBOX_SHARE_NET,
        false
      )
      const fsDisableLiveSearch = isOn(
        getFlag(args.flags, "fs-disable-live-search") ??
          process.env.SYNAPSE_DEVICE_FS_DISABLE_LIVE_SEARCH,
        false
      )
      const fsDisableIndex = isOn(
        getFlag(args.flags, "fs-disable-index") ??
          process.env.SYNAPSE_DEVICE_FS_DISABLE_INDEX,
        false
      )
      const fsIndexIgnore =
        getFlag(args.flags, "fs-index-ignore") ??
        process.env.SYNAPSE_DEVICE_FS_INDEX_IGNORE
      const fsMaxReadMb = parseIntEnv(
        getFlag(args.flags, "fs-max-read-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_READ_MB,
        10
      )
      const fsMaxWriteMb = parseIntEnv(
        getFlag(args.flags, "fs-max-write-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_WRITE_MB,
        50
      )
      const fsMaxEditMb = parseIntEnv(
        getFlag(args.flags, "fs-max-edit-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_EDIT_MB,
        50
      )
      const fsMaxHashMb = parseIntEnv(
        getFlag(args.flags, "fs-max-hash-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_HASH_MB,
        fsMaxReadMb
      )
      const fsMaxExtractMb = parseIntEnv(
        getFlag(args.flags, "fs-max-extract-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_EXTRACT_MB,
        50
      )
      const fsMaxSnapshotMb = parseIntEnv(
        getFlag(args.flags, "fs-max-snapshot-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_SNAPSHOT_MB,
        500
      )
      const fsMaxHistoryList = parseIntEnv(
        getFlag(args.flags, "fs-max-history-list") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_HISTORY_LIST,
        200
      )
      const fsMaxSearchLimit = parseIntEnv(
        getFlag(args.flags, "fs-max-search-limit") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_SEARCH_LIMIT,
        200
      )
      const fsMaxOffset = parseIntEnv(
        getFlag(args.flags, "fs-max-offset") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_OFFSET,
        10_000
      )
      const fsMaxDiffSourceMb = parseIntEnv(
        getFlag(args.flags, "fs-max-diff-source-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_DIFF_SOURCE_MB,
        5
      )
      const fsMaxDiffOutputMb = parseIntEnv(
        getFlag(args.flags, "fs-max-diff-output-mb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_DIFF_OUTPUT_MB,
        1
      )
      const fsMaxHistoryGb = parseIntEnv(
        getFlag(args.flags, "fs-max-history-gb") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_HISTORY_GB,
        5
      )
      const fsMaxVersionsPerPath = parseIntEnv(
        getFlag(args.flags, "fs-max-versions-per-path") ??
          process.env.SYNAPSE_DEVICE_FS_MAX_VERSIONS_PER_PATH,
        100
      )
      const fsKeepRecentVersions = parseIntEnv(
        getFlag(args.flags, "fs-keep-recent-versions") ??
          process.env.SYNAPSE_DEVICE_FS_KEEP_RECENT_VERSIONS,
        5
      )
      const fsHelperRpcTimeoutMs = parseIntEnv(
        getFlag(args.flags, "fs-helper-rpc-timeout-ms") ??
          process.env.SYNAPSE_DEVICE_FS_HELPER_RPC_TIMEOUT_MS,
        30_000
      )
      // Shared environment snapshot + toolchain manager so every builtin
      // looks at the same probed PATH and toolchain dir. install-bundles
      // and run use the SAME --bundled-toolchain-dir / --toolchain-manifest
      // defaults; ToolchainManager.resolve hits whatever install-bundles
      // populated earlier.
      const { detectTerminalEnvironment } =
        await import("./terminal/environment.js")
      const { createToolchainManager } =
        await import("./terminal/toolchain-manager.js")
      const { defaultPathResolver } = await import("./terminal/environment.js")
      const environment = await detectTerminalEnvironment()
      const manifestPath =
        getFlag(args.flags, "toolchain-manifest") ??
        process.env.SYNAPSE_DEVICE_TOOLCHAIN_MANIFEST ??
        defaultManifestPath()
      const toolchainDir =
        getFlag(args.flags, "bundled-toolchain-dir") ??
        process.env.SYNAPSE_DEVICE_TOOLCHAIN_DIR ??
        defaultToolchainDir()
      const toolchainManager = existsSync(manifestPath)
        ? createToolchainManager({
            manifestPath,
            toolchainDir,
            environment,
            pathResolver: defaultPathResolver,
            // Wire sidecar prestage dirs (and operator env override +
            // package-root archives) so a first-run resolve on this
            // device hits committed/staged archives BEFORE attempting
            // any HTTPS fetch. Without this, the run path skips the
            // sidecars and silently degrades to network — defeating the
            // whole point of the optionalDependencies sidecar
            // architecture. Install-bundles already passes the same
            // dirs; symmetry between the two entry points means the
            // operator gets identical behavior whether they pre-stage
            // via install-bundles or just start `synapse-device run`.
            prestageDirs: defaultPrestageDirs(defaultPackageRoot()),
          })
        : undefined
      const providers: CatalogProvider[] = [
        createFilesystemBuiltin({
          rootPath: fsRoot,
          helperPath: fsHelperPath,
          helperWorkDir: fsWorkDir,
          tikaEndpoint: fsTika,
          enableRead: !fsDisableRead,
          enableWrite: fsEnableWrite,
          enableDelete: fsEnableDelete,
          enableHistory: !fsDisableHistory,
          enableLiveSearch: !fsDisableLiveSearch,
          enableIndex: !fsDisableIndex,
          enableRichText: Boolean(fsTika),
          allowUnversionedWrite: fsAllowUnversioned,
          maxReadBytes: fsMaxReadMb * 1024 * 1024,
          maxWriteBytes: fsMaxWriteMb * 1024 * 1024,
          maxEditFileBytes: fsMaxEditMb * 1024 * 1024,
          maxHashBytes: fsMaxHashMb * 1024 * 1024,
          maxExtractBytes: fsMaxExtractMb * 1024 * 1024,
          maxSnapshotBytes: fsMaxSnapshotMb * 1024 * 1024,
          maxHistoryListLimit: fsMaxHistoryList,
          maxSearchLimit: fsMaxSearchLimit,
          maxOffset: fsMaxOffset,
          maxDiffSourceBytes: fsMaxDiffSourceMb * 1024 * 1024,
          maxDiffOutputBytes: fsMaxDiffOutputMb * 1024 * 1024,
          maxHistoryBytes: fsMaxHistoryGb * 1024 * 1024 * 1024,
          maxVersionsPerPath: fsMaxVersionsPerPath,
          keepRecentVersionsPerPath: fsKeepRecentVersions,
          helperRpcTimeoutMs: fsHelperRpcTimeoutMs,
          indexIgnore: fsIndexIgnore,
        }),
      ]
      // Commandline builtin. Fail-closed for sandbox runtimes: when --cmd-sandbox
      // is set we MUST confine every command in a bwrap jail. If bwrap is not
      // available on this host we do NOT register the commandline provider at
      // all — exposing an unconfined commandline on a sandbox device (even if it
      // were only reachable via a later/erroneous capability grant) would turn
      // the sandbox shell into a host shell. Non-sandbox runtimes register the
      // commandline builtin normally (their isolation model is the device itself).
      if (cmdSandbox) {
        if (bwrapAvailable()) {
          providers.push(
            createCommandlineBuiltin({
              environment,
              toolchainManager,
              sandboxRoot: fsRoot,
              sandboxShareNet: cmdSandboxShareNet,
            })
          )
        } else {
          console.warn(
            "[synapse-device] --cmd-sandbox requested but bwrap is unavailable; " +
              "NOT exposing a commandline tool (fail-closed). Only filesystem tools are available."
          )
        }
      } else {
        providers.push(
          createCommandlineBuiltin({ environment, toolchainManager })
        )
      }
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
      // Wire the tunnel that exposes the MCP host's loopback port to the API.
      // WITHOUT a tunnel the runtime connects to the control-plane but never
      // registers a tunnel endpoint, so every dispatched tool call fails with
      // no_tunnel_endpoint — the runtime LOOKS online but no tool can run.
      //
      // Mode is explicit (--tunnel-mode / SYNAPSE_TUNNEL_MODE), one of:
      //   frp  — reverse-tunnel via frpc to the operator's frp edge (the
      //          production cloud/docker path). Requires the four tunnel-* facts.
      //   noop — return a direct loopback URL (http://127.0.0.1:<port>) for an
      //          API co-located with the runtime (the local sandbox backend).
      //          NO frpc; the server only accepts this for live local sandboxes.
      //   none — register no endpoint (control-plane only; catalog visible but
      //          no tool dispatch). The honest default for a plain `run`.
      // Default is inferred for backward-compat: if the four frp facts are all
      // present, frp; otherwise none. Auto-noop is deliberately NOT a default —
      // a silent loopback would mask a missing-frp misconfiguration in prod.
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
      // API-reachable base URL the server registers as internalUrl. Must match
      // the server's SYNAPSE_DEVICE_TUNNEL_EDGE_URL origin. Optional — the
      // adapter defaults to http://tunnel-edge:8080 (reference compose).
      const tunnelInternalBaseUrl =
        getFlag(args.flags, "tunnel-internal-base-url") ??
        process.env.SYNAPSE_TUNNEL_INTERNAL_BASE_URL
      const hasFrpFacts = Boolean(
        tunnelServerAddr &&
        tunnelServerPortRaw &&
        tunnelAuthToken &&
        tunnelVhost
      )
      const tunnelModeRaw = (
        getFlag(args.flags, "tunnel-mode") ??
        process.env.SYNAPSE_TUNNEL_MODE ??
        (hasFrpFacts ? "frp" : "none")
      ).toLowerCase()
      if (
        tunnelModeRaw !== "frp" &&
        tunnelModeRaw !== "noop" &&
        tunnelModeRaw !== "none"
      ) {
        throw new Error(
          `--tunnel-mode must be 'frp', 'noop', or 'none' (got '${tunnelModeRaw}')`
        )
      }
      const tunnelMode = tunnelModeRaw as "frp" | "noop" | "none"
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
      if (tunnelMode === "frp") {
        if (!hasFrpFacts) {
          throw new Error(
            "--tunnel-mode=frp requires tunnel-server-addr, tunnel-server-port, " +
              "tunnel-auth-token and tunnel-vhost (flags or SYNAPSE_TUNNEL_* env)"
          )
        }
        const tunnelServerPort = Number.parseInt(tunnelServerPortRaw!, 10)
        if (!Number.isFinite(tunnelServerPort)) {
          throw new Error(
            `--tunnel-server-port must be a number (got '${tunnelServerPortRaw}')`
          )
        }
        tunnel = {
          adapter: createFrpTunnelAdapter({
            serverAddr: tunnelServerAddr!,
            serverPort: tunnelServerPort,
            authToken: tunnelAuthToken!,
            vhostHost: tunnelVhost!,
            internalBaseUrl: tunnelInternalBaseUrl,
            frpcPath: getFlag(args.flags, "frpc-path") ?? "frpc",
            onUnexpectedExit: ({ code, signal }) => {
              runtimeRef.handle?.notifyTunnelDown(
                `frpc exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
              )
            },
          }),
          registrationToken: tunnelRegistrationToken ?? "",
        }
      } else if (tunnelMode === "noop") {
        // Direct loopback for a co-located API (local sandbox backend). The
        // loopbackHost lets a docker-internal name be substituted if ever
        // needed; default 127.0.0.1 is what the server's local-sandbox SSRF
        // branch accepts.
        tunnel = {
          adapter: createNoopTunnelAdapter({
            loopbackHost:
              getFlag(args.flags, "tunnel-loopback-host") ??
              process.env.SYNAPSE_TUNNEL_LOOPBACK_HOST,
          }),
          registrationToken: tunnelRegistrationToken ?? "",
        }
      }
      // tunnelMode === "none" → tunnel stays undefined (no endpoint registered).
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
    case "install-bundles": {
      // Eager download + extract for every program in the manifest. Shares
      // --bundled-toolchain-dir / --toolchain-manifest with `run` so the
      // same on-disk layout is read by the runtime.
      const platformRaw = getFlag(args.flags, "platform") ?? "auto"
      const parsed = parsePlatformAndArch(platformRaw)
      if (!parsed) {
        console.error(
          `synapse-device install-bundles: unsupported --platform ${platformRaw} (use auto | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64 | win32-x64)`
        )
        process.exit(2)
      }
      const archOverride = getFlag(args.flags, "arch")
      const manifestPath =
        getFlag(args.flags, "toolchain-manifest") ??
        process.env.SYNAPSE_DEVICE_TOOLCHAIN_MANIFEST ??
        defaultManifestPath()
      const toolchainDir =
        getFlag(args.flags, "bundled-toolchain-dir") ??
        process.env.SYNAPSE_DEVICE_TOOLCHAIN_DIR ??
        defaultToolchainDir()
      const manifest = loadManifestFromPath(manifestPath)
      const skipExisting = getFlag(args.flags, "force") !== "true"
      const strict = getFlag(args.flags, "strict") === "true"
      const requirePrestaged =
        getFlag(args.flags, "require-prestaged") === "true"
      const prestageDirsRaw = getFlag(args.flags, "prestage-dir")
      const prestageDirs: string[] = []
      if (prestageDirsRaw) {
        for (const seg of prestageDirsRaw.split(",")) {
          const t = seg.trim()
          if (t.length > 0) prestageDirs.push(t)
        }
      }
      // Always merge defaults (env var + package-root bundles/archives)
      // after explicit flags so operators can extend, not replace, the
      // standard lookup order.
      prestageDirs.push(...defaultPrestageDirs(defaultPackageRoot()))
      // Optional China Node-dist mirror. Explicit flag wins over the env
      // (SYNAPSE_DEVICE_TOOLCHAIN_MIRROR), which downloadAndExtractEntry also
      // honors directly; passing it here makes the CLI path explicit.
      const toolchainMirror =
        getFlag(args.flags, "toolchain-mirror") ??
        process.env["SYNAPSE_DEVICE_TOOLCHAIN_MIRROR"]
      const report = await installBundles({
        manifest,
        toolchainDir,
        platform: parsed.platform,
        arch: archOverride ?? parsed.arch,
        skipExisting,
        prestageDirs,
        requirePrestaged,
        toolchainMirror,
        logger: (m) => console.log(m),
      })
      console.log(JSON.stringify(report, null, 2))
      const summary = summarizeInstallReport(report)
      // Exit 1 if anything FAILED, or nothing usable on disk after the
      // run (no installs AND no "already installed" cache hits — e.g.
      // `--platform=win32-x64` against the current manifest produces
      // four skipped + zero installed, which the operator should NOT
      // misread as "toolchain ready"). --strict additionally fails if
      // ANY entry was unhealthy-skipped (incomplete platform matrix
      // for the target — useful for CI).
      if (
        summary.failedCount > 0 ||
        !summary.anyUsable ||
        (strict && summary.unhealthySkippedCount > 0)
      ) {
        console.error(
          `install-bundles: not all programs usable on ${parsed.platform}-${archOverride ?? parsed.arch} ` +
            `(installed=${summary.installedCount} healthy_skipped=${summary.healthySkippedCount} ` +
            `unhealthy_skipped=${summary.unhealthySkippedCount} failed=${summary.failedCount})`
        )
        process.exit(1)
      }
      return
    }
    default: {
      console.error(`unknown command: ${args.cmd}`)
      process.exit(2)
    }
  }
}

function mapHostPlatform(platform: NodeJS.Platform): string {
  if (platform === "win32") return "win32-" + process.arch
  if (platform === "darwin") return "darwin-" + process.arch
  return "linux-" + process.arch
}

/**
 * Parse a `--platform=...` argument into `{platform, arch}`. Accepts:
 *   - "auto" / "" / undefined → host platform + host arch
 *   - "linux" / "darwin" / "win32" → that platform + host arch
 *   - "linux-x64" / "darwin-arm64" / "win32-x64" → platform + explicit arch
 */
function parsePlatformAndArch(
  value: string
): { platform: TerminalPlatform; arch: string } | null {
  const v =
    value === "auto" || value === "" ? mapHostPlatform(process.platform) : value
  let platform: TerminalPlatform | null = null
  if (v.startsWith("win32")) platform = "win32"
  else if (v.startsWith("darwin")) platform = "darwin"
  else if (v.startsWith("linux")) platform = "linux"
  if (!platform) return null
  const dashIdx = v.indexOf("-")
  const arch = dashIdx >= 0 ? v.slice(dashIdx + 1) : process.arch
  if (!arch) return null
  return { platform, arch }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
