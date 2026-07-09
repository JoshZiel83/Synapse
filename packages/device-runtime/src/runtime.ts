// Device runtime orchestrator. Wires transport + mcp host + catalog providers.

import { EventEmitter } from "node:events"
import type {
  DeviceCatalogSyncParams,
  DeviceHelloParams,
  DeviceTunnelDownParams,
  DeviceTunnelUpParams,
  TunnelHandle,
} from "@synapse/device-protocol"
import { TransportClient } from "./transport.js"
import {
  createInMemoryMcpHost,
  type InMemoryMcpHostHandle,
} from "./mcp-host.js"
import { readPrivateKeyPemFromKeystoreFile } from "./broker.js"
import { createInMemoryEnvelopeVerifier } from "./envelope.js"
import { createFilesystemBuiltin } from "./builtins/filesystem.js"
import type {
  CatalogProvider,
  DeviceRuntimeOptions,
  EmbeddedRuntimeHandle,
  RuntimeHandle,
  RuntimeLogger,
  RuntimeStatus,
} from "./types.js"
import { configureDeviceLogShipping, createDeviceLogger } from "./logger.js"

// The single device-runtime logger (structured NDJSON to stderr). Replaces the
// old console-backed inline shape; see logger.ts.
const defaultLogger: RuntimeLogger = createDeviceLogger("runtime")

function controlPlaneUrlFor(origin: string): string {
  const trimmed = origin.replace(/\/$/, "")
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return `${trimmed}/api/v1/devices/control-plane`
  }
  return `${trimmed
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://")}/api/v1/devices/control-plane`
}

class RuntimeImpl extends EventEmitter implements EmbeddedRuntimeHandle {
  private transport: TransportClient | null = null
  private mcpHost: InMemoryMcpHostHandle | null = null
  private tunnelHandle: TunnelHandle | null = null
  private registeredProviders: CatalogProvider[] = []
  private stopResolve!: () => void
  readonly done: Promise<void>
  private status: RuntimeStatus = "starting"

  constructor(private readonly opts: DeviceRuntimeOptions) {
    super()
    this.done = new Promise<void>((resolve) => {
      this.stopResolve = resolve
    })
  }

  async start(): Promise<void> {
    const logger = this.opts.logger ?? defaultLogger
    const broker = this.opts.broker
    const identity = await broker.loadDeviceIdentity()
    if (!identity) {
      throw new Error(
        "device-runtime: broker has no identity; run `synapse-device pair` first"
      )
    }
    const runtimeService = identity.services.find(
      (s) => s.serviceKind === "device_runtime"
    )
    if (!runtimeService) {
      throw new Error(
        "device-runtime: identity has no device_runtime service entry"
      )
    }
    const serviceKey = await broker.loadKeyPair(runtimeService.privateKeyRef)
    if (!serviceKey) {
      throw new Error(
        `device-runtime: missing service private key for ref ${runtimeService.privateKeyRef}`
      )
    }

    this.mcpHost = (this.opts.mcpHost ??
      createInMemoryMcpHost({
        // Always install a verifier so production runs reject unsigned
        // tool calls. The trusted-server-keys map starts seeded from
        // SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS (if set) and the runtime
        // augments it via addServerPublicKey() once device.hello returns
        // the server's envelope-signing pubkey.
        envelopeVerifier: createInMemoryEnvelopeVerifier(),
        serverPublicKeys: this.opts.trustedServerKeys,
      })) as InMemoryMcpHostHandle
    await this.mcpHost.start()

    const providers: CatalogProvider[] = this.opts.initialCatalog ?? [
      createFilesystemBuiltin(),
    ]
    this.registeredProviders = providers
    for (const provider of providers) {
      await this.mcpHost.registerCatalog(provider)
    }

    // Tunnel: bring the MCP host's loopback port up through the operator's
    // frp edge so the API side can reach `tools/call`. We defer the actual
    // adapter.start() to the device.hello ack handler so we can use the
    // server-issued tunnel_path_token — this prevents a compromised device
    // from squatting on another device's /d/<token> route. The env-supplied
    // registrationToken (opts.tunnel.registrationToken) remains a fallback
    // for environments where the server hasn't started issuing tokens yet.
    // No work happens here.

    const helloFactory = async (
      challengeNonce: string
    ): Promise<DeviceHelloParams> => {
      // PR #21: sign the server-issued challenge with the service private key
      // so the API can verify against runtime_service_keys.pubkey before
      // accepting any further frames.
      const { createPrivateKey, sign: cryptoSign } = await import("node:crypto")
      const keyEntry = await broker.loadKeyPair(runtimeService.privateKeyRef)
      if (!keyEntry) {
        throw new Error(
          `device-runtime: missing service private key for ref ${runtimeService.privateKeyRef}`
        )
      }
      // The broker only exposes the public PEM + a ref; this file-backed
      // runtime reads the private PEM through the broker's local keystore codec.
      const { join } = await import("node:path")
      const keystorePath = join(broker.brokerFilePath, "..", "device-keys.json")
      const privateKeyPem = readPrivateKeyPemFromKeystoreFile(
        keystorePath,
        runtimeService.privateKeyRef
      )
      if (!privateKeyPem) {
        throw new Error(
          `device-runtime: cannot read private PEM for ref ${runtimeService.privateKeyRef}`
        )
      }
      const privKey = createPrivateKey({ key: privateKeyPem, format: "pem" })
      const signature = cryptoSign(
        null,
        Buffer.from(challengeNonce, "utf8"),
        privKey
      )
      return {
        device_id: identity.deviceId,
        service_id: runtimeService.serviceId,
        service_kind: "device_runtime",
        client_version: this.opts.clientVersion,
        signed_challenge: signature.toString("base64"),
      }
    }

    this.transport = new TransportClient({
      controlPlaneUrl: controlPlaneUrlFor(this.opts.serverOrigin),
      hello: helloFactory,
      onHelloAck: async (ack) => {
        // The server hands back its envelope-signing pubkey in the hello
        // ack so the runtime can verify dispatched envelopes without
        // out-of-band trusted-key config. If absent, the runtime falls
        // back to whatever was pre-configured via SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS.
        const envelopeSigning =
          ack &&
          typeof ack === "object" &&
          "envelope_signing" in ack &&
          (ack as { envelope_signing?: unknown }).envelope_signing
        if (
          envelopeSigning &&
          typeof envelopeSigning === "object" &&
          typeof (envelopeSigning as { kid?: unknown }).kid === "string" &&
          typeof (envelopeSigning as { public_key_pem?: unknown })
            .public_key_pem === "string"
        ) {
          const { kid, public_key_pem } = envelopeSigning as {
            kid: string
            public_key_pem: string
          }
          this.mcpHost?.addServerPublicKey(kid, public_key_pem)
          logger.info("envelope server pubkey absorbed from hello ack", {
            kid,
          })
        }
        // Configure device log回传 with the short-lived ingest token minted in
        // the hello ack (POST <api>/api/v1/logs, Bearer). Absent token (server's
        // SYNAPSE_LOG_INGEST_SECRET unset) => shipping stays off; logs remain on
        // local stderr.
        const logIngestToken =
          ack &&
          typeof ack === "object" &&
          "log_ingest_token" in ack &&
          typeof (ack as { log_ingest_token?: unknown }).log_ingest_token ===
            "string"
            ? ((ack as { log_ingest_token: string }).log_ingest_token as string)
            : null
        if (logIngestToken) {
          configureDeviceLogShipping({
            endpoint: `${this.opts.serverOrigin.replace(/\/$/, "")}/api/v1/logs`,
            token: logIngestToken,
          })
          logger.info("device log shipping configured")
        }
        // Pull the per-service tunnel path token the server issued (or
        // re-issued) for this service. Falls back to the env-supplied
        // registrationToken when the server didn't ship one. The token
        // becomes the `/d/<token>` segment the frp edge routes on; the
        // server validates it against runtime_services.tunnel_path_token
        // when device.tunnel.up arrives.
        const tunnelAck =
          ack &&
          typeof ack === "object" &&
          "tunnel" in ack &&
          (ack as { tunnel?: unknown }).tunnel
        const serverTunnelToken =
          tunnelAck &&
          typeof tunnelAck === "object" &&
          typeof (tunnelAck as { path_token?: unknown }).path_token === "string"
            ? ((tunnelAck as { path_token: string }).path_token as string)
            : null
        // Start the tunnel adapter now that we know which token to bind to.
        if (this.opts.tunnel && !this.tunnelHandle) {
          const effectiveToken =
            serverTunnelToken || this.opts.tunnel.registrationToken
          try {
            this.tunnelHandle = await this.opts.tunnel.adapter.start({
              runtimeServiceId: runtimeService.serviceId,
              localPort: this.mcpHost!.localPort,
              registrationToken: effectiveToken,
            })
            logger.info("device tunnel up", {
              runtimeServiceId: runtimeService.serviceId,
              internalUrl: this.tunnelHandle.internalUrl,
              localPort: this.mcpHost!.localPort,
              tokenSource: serverTunnelToken ? "server_issued" : "fallback_env",
            })
          } catch (err) {
            logger.error("device tunnel start failed", {
              error: (err as Error).message,
            })
            throw err
          }
        }
        // Order matters here. We MUST push the catalog (and absorb the
        // server-assigned IDs into the MCP host's target index) BEFORE
        // calling device.tunnel.up — the latter writes
        // DeviceTunnelRegistry, after which dispatchSyncTool can route to
        // us. If we registered the tunnel first there's a window where
        // the device is reachable but the envelope target index is
        // empty, and the mcp-host fail-closed gate would reject every
        // dispatch until catalog sync raced through.
        //
        // pushCatalog() throws if the server responds without a usable
        // assigned_ids map; absorbAssignedIds() throws if the map is
        // missing or wrong-shaped. Either failure propagates out of
        // onHelloAck, which the transport treats as a fatal handshake
        // failure: it closes the socket and the connectLoop reconnects.
        // We DO NOT want to register the tunnel or flip to "online" in
        // the half-initialized state where dispatch would reject every
        // call.
        await this.pushCatalog()
        // Announce our tunnel internal URL so the API's DeviceTunnelRegistry
        // can route dispatchSyncTool to us. Without this, every device tool
        // call returns no_tunnel_endpoint. Throws on failure for the same
        // fail-closed reason as pushCatalog above.
        if (this.tunnelHandle) {
          const params: DeviceTunnelUpParams = {
            internal_url: this.tunnelHandle.internalUrl,
          }
          await this.transport!.request("device.tunnel.up", params)
          logger.info("device.tunnel.up registered with server", {
            internalUrl: this.tunnelHandle.internalUrl,
          })
        }
      },
      onStatus: (status) => this.updateStatus(status),
      onMessage: (method, params) => {
        logger.info("control-plane message", { method, params })
      },
      logger,
    })
    this.transport.start()
  }

  private async pushCatalog() {
    if (!this.mcpHost || !this.transport) return
    const exposures = await this.mcpHost.getCatalogSnapshot()
    const params: DeviceCatalogSyncParams = { exposures }
    // Use request (not notify) so we know whether the server actually
    // accepted the catalog. notify() silently returns if the socket isn't
    // OPEN, which was the original race that lost the initial sync.
    const ack = await this.transport.request("device.catalog.sync", params)
    // Server returns assigned_ids: a {stable_key -> {runtime_exposure_id,
    // tools: {tool_name -> {runtime_tool_id, runtime_tool_revision_id}}}}
    // map. We store it in the MCP host so dispatchCallTool can reject any
    // envelope whose target IDs don't match our local catalog — without
    // this check a forged or misrouted envelope could trick us into
    // running a tool that belongs to another device.
    //
    // Throws if the server didn't ship a map or shipped a wrong-shaped
    // one. The transport's onHelloAck handler treats that as a fatal
    // startup failure and reconnects, keeping the runtime out of the
    // "online but not routable" state where the mcp-host's fail-closed
    // gate would reject every dispatch.
    this.absorbAssignedIds(ack)
  }

  private absorbAssignedIds(ack: unknown) {
    if (!ack || typeof ack !== "object") {
      throw new Error(
        "device.catalog.sync ack was not an object — server response shape changed"
      )
    }
    const assigned =
      (ack as { assignedIds?: unknown; assigned_ids?: unknown }).assignedIds ??
      (ack as { assigned_ids?: unknown }).assigned_ids
    if (!assigned || typeof assigned !== "object") {
      throw new Error(
        "device.catalog.sync ack missing assigned_ids — refusing to route envelopes without a server-assigned target map"
      )
    }
    this.mcpHost?.setCatalogTargetIds(
      assigned as Parameters<InMemoryMcpHostHandle["setCatalogTargetIds"]>[0]
    )
  }

  /**
   * Public re-sync hook (plan §5.B). Re-pushes the catalog snapshot so updated
   * builtin/commandline exposure metadata (e.g. availableClis after an on-demand
   * CLI install) reaches the server. Best-effort: a failed push is swallowed
   * because the next reconnect's onHelloAck re-pushes the full catalog anyway.
   */
  async resyncCatalog(): Promise<void> {
    try {
      await this.pushCatalog()
    } catch {
      // best-effort; onHelloAck re-syncs on the next (re)connect
    }
  }

  private updateStatus(status: RuntimeStatus) {
    if (this.status === status) return
    this.status = status
    this.emit("status", status)
  }

  /**
   * Notify the API that our tunnel went down so DeviceTunnelRegistry stops
   * routing dispatches to it, then force the WSS to reconnect so the full
   * hello → catalog → tunnel sequence reruns. Called from the
   * FrpTunnelAdapter's onUnexpectedExit hook when frpc dies after passing
   * the startup grace period. Without the forceReconnect the device would
   * stay degraded indefinitely (until the WSS happens to drop on its own
   * or the process restarts) — the tunnel is only ever started inside
   * onHelloAck, and onHelloAck only runs on (re)connect.
   */
  notifyTunnelDown(reason: string): void {
    this.tunnelHandle = null
    this.updateStatus("degraded")
    if (!this.transport) return
    try {
      const params: DeviceTunnelDownParams = { reason }
      this.transport.notify("device.tunnel.down", params)
    } catch {
      /* best-effort: WSS may already be gone */
    }
    // Trigger the reconnect AFTER notify so the API has a chance to
    // process the down signal before we drop the socket. forceReconnect
    // closes with code 1012 (Service Restart) — the API treats this as
    // a normal disconnect and the transport's connectLoop reconnects
    // with backoff, re-running the full hello/catalog/tunnel flow.
    try {
      this.transport.forceReconnect(`tunnel-down: ${reason}`)
    } catch {
      /* best-effort */
    }
  }

  async stop(): Promise<void> {
    if (this.transport) await this.transport.stop()
    if (this.tunnelHandle && this.opts.tunnel) {
      try {
        await this.opts.tunnel.adapter.stop(this.tunnelHandle)
      } catch {
        /* tunnel adapter swallowed errors during stop — best effort */
      }
      this.tunnelHandle = null
    }
    // Tear down provider sidecars BEFORE the host so in-flight tool calls
    // get rejected with a "sidecar exited" error instead of leaking past
    // the host close.
    for (const provider of this.registeredProviders) {
      if (provider.dispose) {
        try {
          await provider.dispose()
        } catch {
          /* dispose is best-effort */
        }
      }
    }
    this.registeredProviders = []
    if (this.mcpHost) await this.mcpHost.stop()
    this.updateStatus("offline")
    this.stopResolve()
  }
}

export async function runDeviceRuntime(
  opts: DeviceRuntimeOptions
): Promise<EmbeddedRuntimeHandle> {
  const impl = new RuntimeImpl(opts)
  await impl.start()
  return impl
}

export async function embedDeviceRuntime(
  opts: DeviceRuntimeOptions
): Promise<EmbeddedRuntimeHandle> {
  const impl = new RuntimeImpl(opts)
  await impl.start()
  return impl
}
