// @synapse/device-runtime — public types.

import type {
  DeviceCatalogExposure,
  DevicePairingMode,
  DeviceServiceKind,
  HostKind,
  OperationEnvelope,
  TunnelAdapter,
} from "@synapse/device-protocol"

/**
 * Where the runtime stores broker state (device_id + service registry) and
 * resolves the OS keychain. See spec §5.1.
 */
export interface DeviceIdentityBroker {
  readonly brokerFilePath: string
  loadDeviceIdentity(): Promise<DeviceIdentityRecord | null>
  saveDeviceIdentity(record: DeviceIdentityRecord): Promise<void>
  generateKeyPair(label: string): Promise<KeyPair>
  /** retrieve a private key previously persisted under label */
  loadKeyPair(label: string): Promise<KeyPair | null>
}

export interface KeyPair {
  /** PEM-encoded public key (suitable for transmission to server). */
  readonly publicKey: string
  /** Opaque handle the OS keychain returns; runtime never logs it. */
  readonly privateKeyRef: string
  /** Fingerprint (sha256 of pubkey bytes). */
  readonly publicKeyFingerprint: string
}

export interface DeviceIdentityRecord {
  deviceId: string
  serverOrigin: string
  hostKind: HostKind
  services: Array<{
    serviceKind: DeviceServiceKind
    serviceId: string
    pubkeyFingerprint: string
    /** Broker-internal handle to the service private key. */
    privateKeyRef: string
  }>
  /** Fingerprint of the device-level public key (NOT the service key). */
  devicePubkeyFingerprint: string
  /** Broker-internal handle to the device-level private key. */
  devicePrivateKeyRef: string
}

/**
 * Catalog provider: produces the runtime's current exposure list for the
 * device.catalog.sync message. v3.0 ships with a single builtin filesystem
 * provider; PR #9/10/11/13 add commandline, browser, cua, vfs.
 */
export interface CatalogProvider {
  readonly providerKey: string
  describeExposures(): Promise<DeviceCatalogExposure[]>
  /**
   * Optional tool invocation hook. Called when the MCP host receives a
   * tools/call for a tool the provider declared in describeExposures().
   * Returns the same shape as MCP's CallToolResult ({content, isError,
   * _meta}); providers that have no executable surface yet can omit this
   * method and the host will respond with `tool_not_implemented`.
   */
  invokeTool?(input: {
    toolName: string
    args: Record<string, unknown>
    /** Operation envelope from `_meta.synapse_operation`, when present. */
    envelope?: OperationEnvelope
  }): Promise<CatalogToolInvocationResult>
  /**
   * Optional teardown hook. Called by the runtime in stop() so providers can
   * tear down resources (e.g. supervisors that own a sidecar subprocess).
   */
  dispose?(): Promise<void>
}

export interface CatalogToolInvocationResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * MCP host abstraction. PR #4 ships a minimal implementation that lets a
 * CatalogProvider register tools; PR #6 wires it through the Streamable HTTP
 * transport so the API can dispatch real `tools/call` requests over the tunnel.
 */
export interface McpHost {
  registerCatalog(provider: CatalogProvider): Promise<void>
  unregisterCatalog(providerKey: string): Promise<void>
  /** Local loopback port the HTTP server is listening on, or 0 if not started. */
  readonly localPort: number
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Operation envelope verification entry point. Reused by the MCP host and by
 * any future stream-based exposure (PR #6 implementation; v3.0 ships a stub).
 */
export interface EnvelopeVerifier {
  verify(
    envelope: OperationEnvelope,
    actualArgsHash: string,
    serverPublicKeys: ReadonlyMap<string, string>
  ): Promise<EnvelopeVerifyResult>
}

export type EnvelopeVerifyResult =
  | { ok: true }
  | {
      ok: false
      code:
        | "invalid_request"
        | "expired_envelope"
        | "tool_definition_changed"
        | "permission_denied"
        | "replay_detected"
      message: string
    }

export interface DeviceRuntimeOptions {
  /** Server origin, e.g. https://synapse.example.com */
  serverOrigin: string
  /** Path or constructor for the device identity broker. */
  broker: DeviceIdentityBroker
  /** Optional initial catalog providers. */
  initialCatalog?: CatalogProvider[]
  /**
   * Optional tunnel adapter + per-service registration token. When provided,
   * the runtime spawns the tunnel after the MCP host is listening so the API
   * side can resolve `https://tunnel-edge/d/<token>` → loopback. v3.0 ships
   * with FrpTunnelAdapter; the absence of this block leaves the runtime
   * reachable only on loopback (local smoke tests).
   */
  tunnel?: {
    adapter: TunnelAdapter
    registrationToken: string
  }
  /** Optional MCP host override. v3.0 ships an in-process default. */
  mcpHost?: McpHost
  /**
   * Trusted server signing keys keyed by signature_kid. The runtime refuses
   * to invoke any tool whose envelope can't be verified against one of these
   * keys (set via SYNAPSE_DEVICE_TRUSTED_SERVER_KEYS, or programmatically).
   * Empty map = "no verification" mode (loopback smoke tests only).
   */
  trustedServerKeys?: ReadonlyMap<string, string>
  /** Client version string sent on hello. */
  clientVersion: string
  /** Logger. Defaults to console. */
  logger?: RuntimeLogger
}

export interface RuntimeLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

export interface RuntimeHandle {
  /** Resolves when the runtime is shut down. */
  readonly done: Promise<void>
  stop(): Promise<void>
}

export interface EmbeddedRuntimeHandle extends RuntimeHandle {
  /** Surface for the host process (desktop client) to observe runtime state. */
  on(event: "status", listener: (status: RuntimeStatus) => void): void
  off(event: "status", listener: (status: RuntimeStatus) => void): void
  /**
   * Re-push the catalog snapshot to the server (plan §5.B). Used when an
   * exposure's metadata changes out-of-band — e.g. after an on-demand
   * CLI-Anything install flips an entry's availableClis.available. Best-effort.
   */
  resyncCatalog(): Promise<void>
}

export type RuntimeStatus = "starting" | "online" | "degraded" | "offline"

export interface PairOptions {
  serverOrigin: string
  broker: DeviceIdentityBroker
  pairingCode?: string
  bootstrapToken?: string
  mode: DevicePairingMode
  title?: string
  clientVersion: string
}

export interface PairResult {
  deviceId: string
  serviceId: string
  controlPlaneUrl: string
}

export interface RekeyOptions {
  serverOrigin: string
  broker: DeviceIdentityBroker
  deviceId: string
  pairingCode?: string
  clientVersion: string
}

export interface RekeyResult {
  serviceId: string
  serviceKeyId: string
}
