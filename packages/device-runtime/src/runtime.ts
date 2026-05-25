// Device runtime orchestrator. Wires transport + mcp host + catalog providers.

import { EventEmitter } from "node:events"
import type {
  DeviceCatalogSyncParams,
  DeviceHelloParams,
  TunnelHandle,
} from "@synapse/device-protocol"
import { TransportClient } from "./transport.js"
import {
  createInMemoryMcpHost,
  type InMemoryMcpHostHandle,
} from "./mcp-host.js"
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

const defaultLogger: RuntimeLogger = {
  info(message, data) {
    console.log(`[device-runtime] ${message}`, data ?? "")
  },
  warn(message, data) {
    console.warn(`[device-runtime] ${message}`, data ?? "")
  },
  error(message, data) {
    console.error(`[device-runtime] ${message}`, data ?? "")
  },
}

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
    // frp edge so the API side can reach `tools/call`. Failure here is fatal
    // when explicitly configured — silently falling back would let the
    // dispatcher 502 forever with no operator-visible signal.
    if (this.opts.tunnel) {
      try {
        this.tunnelHandle = await this.opts.tunnel.adapter.start({
          deviceServiceId: runtimeService.serviceId,
          localPort: this.mcpHost.localPort,
          registrationToken: this.opts.tunnel.registrationToken,
        })
        logger.info("device tunnel up", {
          deviceServiceId: runtimeService.serviceId,
          internalUrl: this.tunnelHandle.internalUrl,
          localPort: this.mcpHost.localPort,
        })
      } catch (err) {
        logger.error("device tunnel start failed", {
          error: (err as Error).message,
        })
        throw err
      }
    }

    const helloFactory = async (
      challengeNonce: string
    ): Promise<DeviceHelloParams> => {
      // PR #21: sign the server-issued challenge with the service private key
      // so the API can verify against device_service_keys.pubkey before
      // accepting any further frames.
      const { createPrivateKey, sign: cryptoSign } = await import("node:crypto")
      const keyEntry = await broker.loadKeyPair(runtimeService.privateKeyRef)
      if (!keyEntry) {
        throw new Error(
          `device-runtime: missing service private key for ref ${runtimeService.privateKeyRef}`
        )
      }
      // The broker only exposes the public PEM + a ref; we need the private
      // PEM to sign. Re-read the keystore directly. For Ed25519 the digest
      // argument MUST be null.
      const { readFileSync, existsSync } = await import("node:fs")
      const { join } = await import("node:path")
      const keystorePath = join(broker.brokerFilePath, "..", "device-keys.json")
      let privateKeyPem: string | null = null
      if (existsSync(keystorePath)) {
        try {
          const ks = JSON.parse(readFileSync(keystorePath, "utf-8")) as Record<
            string,
            { privateKey?: string }
          >
          privateKeyPem = ks[runtimeService.privateKeyRef]?.privateKey ?? null
        } catch {
          /* fall through */
        }
      }
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
        // Announce our tunnel internal URL so the API's DeviceTunnelRegistry
        // can route dispatchSyncTool to us. Without this, every device tool
        // call returns no_tunnel_endpoint.
        if (this.tunnelHandle) {
          try {
            await this.transport!.request("device.tunnel.up", {
              internal_url: this.tunnelHandle.internalUrl,
            })
            logger.info("device.tunnel.up registered with server", {
              internalUrl: this.tunnelHandle.internalUrl,
            })
          } catch (err) {
            logger.error("device.tunnel.up failed", {
              error: (err as Error).message,
            })
          }
        }
        // Push the initial catalog AFTER hello-ack so the socket is
        // guaranteed open + authenticated. The old setImmediate(pushCatalog)
        // raced the hello round-trip and silently dropped the notification
        // when socket.readyState !== OPEN.
        try {
          await this.pushCatalog()
        } catch (err) {
          logger.error("initial catalog sync failed", {
            error: (err as Error).message,
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
    await this.transport.request("device.catalog.sync", params)
  }

  private updateStatus(status: RuntimeStatus) {
    if (this.status === status) return
    this.status = status
    this.emit("status", status)
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
): Promise<RuntimeHandle> {
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
