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
      createInMemoryMcpHost()) as InMemoryMcpHostHandle
    await this.mcpHost.start()

    const providers: CatalogProvider[] = this.opts.initialCatalog ?? [
      createFilesystemBuiltin(),
    ]
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

    const helloFactory = async (): Promise<DeviceHelloParams> => ({
      device_id: identity.deviceId,
      service_id: runtimeService.serviceId,
      service_kind: "device_runtime",
      client_version: this.opts.clientVersion,
      // v3.0 skeleton: signed_challenge is a placeholder fingerprint. PR #6
      // will replace this with an Ed25519 signature over a server-issued
      // nonce.
      signed_challenge: serviceKey.publicKeyFingerprint,
    })

    this.transport = new TransportClient({
      controlPlaneUrl: controlPlaneUrlFor(this.opts.serverOrigin),
      hello: helloFactory,
      onStatus: (status) => this.updateStatus(status),
      onMessage: (method, params) => {
        logger.info("control-plane message", { method, params })
      },
      logger,
    })
    this.transport.start()

    setImmediate(() => {
      void this.pushCatalog().catch((err) => {
        logger.error("initial catalog sync failed", {
          error: (err as Error).message,
        })
      })
    })
  }

  private async pushCatalog() {
    if (!this.mcpHost || !this.transport) return
    const exposures = await this.mcpHost.getCatalogSnapshot()
    const params: DeviceCatalogSyncParams = { exposures }
    this.transport.notify("device.catalog.sync", params)
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
