// FrpTunnelAdapter — frp implementation of @synapse/device-protocol's
// TunnelAdapter (§4.4). v3.0 ships the supervision side: the device runtime
// spawns frpc with a per-service config, and the adapter exposes the
// resulting internal URL (which the API resolves via DeviceTunnelRegistry).
//
// FAIL-HARD POLICY: if the operator configured a tunnel (via
// SYNAPSE_TUNNEL_*) and the frpc binary can't actually start, this adapter
// throws. Returning a fake "tunnel-edge" handle in that case used to make
// the device flip to "online" while every dispatch silently 502'd against
// a non-existent frpc. Callers that need a no-op tunnel for tests should
// import `createNoopTunnelAdapter` from `./noop.js` and wire it explicitly.

import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  TunnelAdapter,
  TunnelHandle,
  TunnelStartOptions,
} from "@synapse/device-protocol"

export interface FrpTunnelAdapterOptions {
  /** Path to the frpc binary. Defaults to PATH lookup. */
  frpcPath?: string
  /** frps host + control port, e.g. tunnel.synapse.internal:7000 */
  serverAddr: string
  serverPort: number
  /** Shared token presented to frps. PR #12 switches to per-service tokens. */
  authToken: string
  /**
   * vhost host frps uses for HTTP routes. The runtime publishes its endpoint
   * under `https://<vhostHost>/d/<service-token>` (translated via the URL
   * builder below).
   */
  vhostHost: string
  /**
   * How long start() waits after spawn() before declaring the tunnel
   * "started". If frpc exits within this window we treat the start as a
   * configuration / auth / connectivity failure and throw — the alternative
   * is silently treating the tunnel as up while frpc has already died.
   * Defaults to 2000 ms.
   */
  startupGraceMs?: number
  /**
   * Invoked when an already-started frpc exits unexpectedly. The runtime
   * uses this to call `device.tunnel.down` so the API stops routing
   * dispatches to a dead tunnel. Pass null/undefined to skip the
   * notification (test-only).
   */
  onUnexpectedExit?: (info: {
    deviceServiceId: string
    code: number | null
    signal: NodeJS.Signals | null
  }) => void
  /** Optional log sink. */
  logger?: {
    info(msg: string, data?: unknown): void
    error(msg: string, data?: unknown): void
  }
}

interface ManagedTunnel {
  handle: TunnelHandle
  child: ChildProcess
  configPath: string
  tmpDir: string
  /** Captured at start() so rotateToken can re-emit the config without
   * collapsing localPort to 0 (which would route the frps proxy at a
   * port nothing is listening on after reload). */
  localPort: number
  /**
   * Set to true by stop() BEFORE killing the child so the eventual
   * 'exit' handler can tell intentional teardown apart from a crash.
   * Without this flag, runtime.notifyTunnelDown() runs even on a
   * clean shutdown — which closes the WSS via forceReconnect and
   * forces a needless re-handshake (or, worse, fights the runtime's
   * own stop() if their ordering interleaves).
   */
  intentionallyStopped: boolean
}

function buildFrpcConfig(opts: {
  serverAddr: string
  serverPort: number
  authToken: string
  registrationToken: string
  localPort: number
  vhostHost: string
}): string {
  return [
    `serverAddr = "${opts.serverAddr}"`,
    `serverPort = ${opts.serverPort}`,
    `auth.method = "token"`,
    `auth.token = "${opts.authToken}"`,
    ``,
    `[[proxies]]`,
    `name = "device-${opts.registrationToken}"`,
    `type = "http"`,
    `localIP = "127.0.0.1"`,
    `localPort = ${opts.localPort}`,
    `customDomains = ["${opts.vhostHost}"]`,
    `# device runtime listens on loopback; frps routes /d/<token>/* to it.`,
    `locations = ["/d/${opts.registrationToken}"]`,
    ``,
  ].join("\n")
}

export function createFrpTunnelAdapter(
  opts: FrpTunnelAdapterOptions
): TunnelAdapter {
  const managed = new Map<string, ManagedTunnel>()

  return {
    async start(startOpts: TunnelStartOptions): Promise<TunnelHandle> {
      const tmpDir = mkdtempSync(join(tmpdir(), "synapse-frpc-"))
      const configPath = join(tmpDir, "frpc.toml")
      writeFileSync(
        configPath,
        buildFrpcConfig({
          serverAddr: opts.serverAddr,
          serverPort: opts.serverPort,
          authToken: opts.authToken,
          registrationToken: startOpts.registrationToken,
          localPort: startOpts.localPort,
          vhostHost: opts.vhostHost,
        })
      )

      const handle: TunnelHandle = {
        deviceServiceId: startOpts.deviceServiceId,
        internalUrl: `http://tunnel-edge:8080/d/${startOpts.registrationToken}`,
      }
      const frpcPath = opts.frpcPath ?? "frpc"
      // spawn() returns synchronously and the child becomes "alive" only
      // when the OS confirms the binary actually exists; ENOENT surfaces
      // as an asynchronous 'error' event on the next tick. Race
      // 'spawn' vs 'error' before we hand the handle back — any error
      // here (immediate-throw OR async ENOENT) propagates out of start()
      // so the runtime never registers a tunnel.up that points at a frpc
      // that never came up.
      let child: ChildProcess
      try {
        child = spawn(frpcPath, ["-c", configPath], {
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (err) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* tmpdir cleanup is best-effort */
        }
        throw new Error(
          `frpc spawn failed (${frpcPath}): ${(err as Error).message}`
        )
      }
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const onSpawn = () => {
            if (settled) return
            settled = true
            resolve()
          }
          const onError = (err: Error) => {
            if (settled) return
            settled = true
            reject(err)
          }
          child.once("spawn", onSpawn)
          child.once("error", onError)
        })
      } catch (err) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* tmpdir cleanup is best-effort */
        }
        throw new Error(
          `frpc spawn failed (${frpcPath}): ${(err as Error).message}. ` +
            `Install frpc and put it on PATH, or use createNoopTunnelAdapter() ` +
            `for tests that don't need a real tunnel.`
        )
      }
      // Readiness probe: spawn() resolving only proves the OS started the
      // process — not that frpc successfully attached to frps. A bad
      // serverAddr / authToken / TLS handshake will let spawn succeed and
      // then exit within a few hundred ms. If that happens we MUST reject
      // start() so the runtime never flips the device to "tunnel up" while
      // every dispatch silently 502s. Window default: 2s.
      const startupGraceMs = opts.startupGraceMs ?? 2000
      const earlyExit = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      } | null>((resolve) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer)
          resolve({ code, signal })
        }
        const timer = setTimeout(() => {
          child.off("exit", onExit)
          resolve(null)
        }, startupGraceMs)
        child.once("exit", onExit)
      })
      if (earlyExit) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* tmpdir cleanup is best-effort */
        }
        throw new Error(
          `frpc exited within ${startupGraceMs}ms of startup ` +
            `(code=${earlyExit.code ?? "null"}, signal=${earlyExit.signal ?? "null"}). ` +
            `Check serverAddr/authToken/vhostHost — frpc usually logs the ` +
            `reason on stderr above.`
        )
      }
      // After the readiness window, any subsequent exit is unexpected —
      // notify the runtime so it can call device.tunnel.down and stop
      // accepting dispatches against this handle.
      child.on("error", (err) => {
        opts.logger?.error("frpc post-spawn error", {
          deviceServiceId: startOpts.deviceServiceId,
          error: err.message,
        })
      })
      child.stdout?.on("data", (b) =>
        opts.logger?.info(`frpc[${startOpts.deviceServiceId}] ${b}`)
      )
      child.stderr?.on("data", (b) =>
        opts.logger?.info(`frpc[${startOpts.deviceServiceId}] ${b}`)
      )
      child.on("exit", (code, signal) => {
        opts.logger?.info("frpc exited", {
          deviceServiceId: startOpts.deviceServiceId,
          code,
          signal,
        })
        // Read intentional-stop flag BEFORE deleting the managed entry —
        // stop() sets it but does NOT delete (so the exit handler is the
        // single point that cleans up + decides whether to notify).
        const intentional =
          managed.get(startOpts.deviceServiceId)?.intentionallyStopped ?? false
        managed.delete(startOpts.deviceServiceId)
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* tmpdir cleanup is best-effort */
        }
        // Only flag unexpected exits. A SIGTERM from stop() is
        // intentional teardown — calling onUnexpectedExit there would
        // make the runtime call device.tunnel.down + forceReconnect on
        // every clean shutdown, fighting the runtime's own stop()
        // sequence (or, after the runtime is gone, churning the WSS
        // for no reason).
        if (intentional) return
        opts.onUnexpectedExit?.({
          deviceServiceId: startOpts.deviceServiceId,
          code,
          signal,
        })
      })

      managed.set(startOpts.deviceServiceId, {
        handle,
        child,
        configPath,
        tmpDir,
        localPort: startOpts.localPort,
        intentionallyStopped: false,
      })
      return handle
    },
    async rotateToken(
      handle: TunnelHandle,
      registrationToken: string
    ): Promise<void> {
      const existing = managed.get(handle.deviceServiceId)
      if (!existing) return
      // CRITICAL: preserve the original localPort. Previous code wrote
      // localPort=0 here, which makes frpc reload a config that points at
      // a port nothing is listening on — every dispatched tool call then
      // 502s silently. The caller-side comment claimed v3 keeps the port
      // but the buildFrpcConfig call below dropped it.
      writeFileSync(
        existing.configPath,
        buildFrpcConfig({
          serverAddr: opts.serverAddr,
          serverPort: opts.serverPort,
          authToken: opts.authToken,
          registrationToken,
          localPort: existing.localPort,
          vhostHost: opts.vhostHost,
        })
      )
      try {
        existing.child.kill("SIGHUP")
      } catch {
        /* frpc may not support SIGHUP on all platforms; PR #12 swaps to
         * the JSON-RPC reload endpoint when we bump frp to a version that
         * exposes one. */
      }
    },
    async stop(handle: TunnelHandle): Promise<void> {
      const existing = managed.get(handle.deviceServiceId)
      if (!existing) return
      // Mark BEFORE killing so the exit handler (which runs on the next
      // event-loop turn) reads the flag and skips onUnexpectedExit.
      // The exit handler is also the single point that deletes the
      // managed entry + cleans the tmpdir, so we don't delete here.
      existing.intentionallyStopped = true
      try {
        existing.child.kill("SIGTERM")
      } catch {
        /* ignore */
      }
    },
  }
}
