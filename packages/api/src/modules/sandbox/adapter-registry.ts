// Sandbox ADAPTER registry (§4.1 / §4.7.2). Supersedes the P2 `selectSandboxBackend`
// (which forked ONLY on provider and never on mode — so SANDBOX_MODE=bare was
// inert). An adapter is keyed `${provider}:${mode}` and carries the metadata the
// provision spine forks on (catalogSource, transportDefault, capabilities) plus
// the lifecycle (create/connect) and, for Mode-B, the confined `dataPlane`.
//
// F-A (preserved): a docker adapter's teardown/liveness/reconnect NEVER forces
// the provision config to evaluate. `create()` (provision) is backed by
// createDockerSandboxBackend(dockerBackendOptionsFromEnv()) evaluated LAZILY only
// when create() is actually invoked; `connect()` (teardown/liveness/reconnect) is
// backed by the env-free createDockerReconnectBackend. So a docker sandbox stays
// reapable after a fallback to local / SANDBOX_PROVIDER=none / a lost
// FRP_SHARED_TOKEN. adapterForRow ALWAYS resolves from the persisted row, never
// current config (inv-45).

import { randomUUID } from "node:crypto"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { deleteDevice, mintBareSandboxRuntime } from "../devices/service.js"
import { bwrapAvailable, detectRipgrep } from "@synapse/device-runtime"
import {
  createLocalSandboxBackend,
  SandboxBackendError,
  type SandboxBackend,
  type SandboxBackendKind,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"
import {
  createDockerSandboxBackend,
  createDockerReconnectBackend,
  type DockerSandboxBackendOptions,
  type SpawnImpl,
} from "./docker-sandbox-backend.js"
import { createLocalHostProvider, type HostProvider } from "./host-provider.js"
import {
  createLocalBareDataPlane,
  type SandboxDataPlane,
} from "./data-plane.js"
import {
  registerBareDataPlane,
  unregisterBareDataPlane,
  getLiveBareDataPlane,
} from "./bare-dispatch.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

const log = createLogger("sandbox.adapter-registry")

export interface SandboxAdapter {
  readonly key: string
  readonly provider: string
  readonly mode: "resident" | "bare"
  /** Written to sandboxes.adapter / file_mounts.sandbox_backend (== provider). */
  readonly kind: SandboxBackendKind
  readonly catalogSource: "control_plane" | "api_authored"
  readonly transportDefault: "direct" | "indirect"
  /** Frozen descriptor for a bare adapter; null for a resident adapter. */
  readonly capabilities: SandboxCapabilityDescriptor | null
  create(spec: SandboxSpec): Promise<SandboxHandle>
  connect(ref: SandboxRef): Promise<SandboxHandle>
  /** Mode-B only: the confined data plane bound to a live handle. */
  dataPlane?(handle: SandboxHandle): SandboxDataPlane
}

/** Build the docker backend options from the validated config.sandbox namespace.
 *  (Relocated from service.ts so the registry can build the LAZY provision backend
 *  without a value cycle; service.ts re-exports it for compatibility.) */
export function dockerBackendOptionsFromEnv(): DockerSandboxBackendOptions {
  const dk = config.sandbox.docker
  const tunnel: "frp" = "frp"
  return {
    image: dk.image,
    network: dk.network,
    storageVolume: dk.storageVolume,
    serverOrigin: config.sandbox.serverOrigin,
    tunnel,
    tunnelServerAddr: dk.tunnel.serverAddr || undefined,
    tunnelServerPort: dk.tunnel.serverPort || undefined,
    tunnelAuthToken: dk.tunnel.frpSharedToken,
    tunnelVhostHost: dk.tunnel.vhostHost || undefined,
    tunnelInternalBaseUrl: dk.tunnel.edgeUrl || undefined,
    runAsUid: dk.runAsUid,
  }
}

// ─────────────────────────── resident adapters (Mode-A) ──────────────────────

function makeLocalResidentAdapter(deps?: {
  hostProvider?: HostProvider
}): SandboxAdapter {
  const hostProvider = deps?.hostProvider ?? createLocalHostProvider()
  const backend: SandboxBackend = createLocalSandboxBackend({ hostProvider })
  return {
    key: "local:resident",
    provider: "local",
    mode: "resident",
    kind: "local",
    catalogSource: "control_plane",
    transportDefault: "direct",
    capabilities: null,
    create: (spec) => backend.create(spec),
    connect: (ref) => backend.connect(ref),
  }
}

function makeDockerResidentAdapter(deps?: {
  dockerSpawnImpl?: SpawnImpl
}): SandboxAdapter {
  // F-A: connect (teardown/liveness/reconnect) uses the ENV-FREE reconnect
  // backend; create (provision) lazily builds the provision backend ONLY when
  // invoked. The two never share the provision factory on the teardown path.
  const reconnect = createDockerReconnectBackend({
    spawnImpl: deps?.dockerSpawnImpl,
  })
  return {
    key: "docker:resident",
    provider: "docker",
    mode: "resident",
    kind: "docker",
    catalogSource: "control_plane",
    transportDefault: "indirect",
    capabilities: null,
    create: (spec) =>
      createDockerSandboxBackend(dockerBackendOptionsFromEnv()).create(spec),
    connect: (ref) => reconnect.connect(ref),
  }
}

// ─────────────────────────── local:bare adapter (Mode-B) ─────────────────────

const LOCAL_BARE_CAPS = {
  maxReadBytes: 10 * 1024 * 1024,
  maxWriteBytes: 50 * 1024 * 1024,
  maxConcurrentExec: 4,
} as const

/** Host-probe the local:bare descriptor at create(): isolation (bwrap) + search
 *  (ripgrep). NEVER pty (F-D). isolation:null ⇒ no commandline exposure/grant and
 *  the plane's exec fail-closes (three fail-closed layers). */
export function buildLocalBareDescriptor(overrides?: {
  isolation?: SandboxCapabilityDescriptor["isolation"]
  search?: boolean
}): SandboxCapabilityDescriptor {
  const isolation =
    overrides?.isolation !== undefined
      ? overrides.isolation
      : bwrapAvailable()
        ? "bwrap"
        : null
  const search =
    overrides?.search !== undefined
      ? overrides.search
      : detectRipgrep() !== null
  return {
    mode: "bare",
    transportDefault: "direct",
    confinedFs: "native",
    core: {
      atomicWrite: true,
      staleWriteGuard: "strict",
      rangeRead: true,
      search,
      mkdir: true,
      move: true,
      remove: true,
      pty: false,
      maxReadBytes: LOCAL_BARE_CAPS.maxReadBytes,
      maxWriteBytes: LOCAL_BARE_CAPS.maxWriteBytes,
      maxConcurrentExec: LOCAL_BARE_CAPS.maxConcurrentExec,
    },
    advancedTools: [],
    isolation,
    reconnectable: true,
  }
}

export interface MakeLocalBareAdapterDeps {
  /** Force the descriptor (test seam for the degraded/no-bwrap variants). */
  descriptorOverride?: SandboxCapabilityDescriptor
  /** Inject the mint (test seam). */
  mintRuntime?: typeof mintBareSandboxRuntime
}

export function makeLocalBareAdapter(
  deps: MakeLocalBareAdapterDeps = {}
): SandboxAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const descriptor = deps.descriptorOverride ?? buildLocalBareDescriptor()
  return {
    key: "local:bare",
    provider: "local",
    mode: "bare",
    kind: "local",
    catalogSource: "api_authored",
    transportDefault: "direct",
    capabilities: descriptor,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      const runtimeId = randomUUID()
      const serviceId = randomUUID()
      const dataPlaneEndpoint = `inprocess:${runtimeId}`
      const exposures = buildBareCoreCatalog(descriptor)
      let minted = false
      try {
        // ① atomically mint runtimes+sandboxes+runtime_services(bare_dataplane) +
        // persist the api-authored catalog (NO keypair, NO pairing, NO broker).
        await mint({
          runtimeId,
          workspaceId: spec.workspaceId,
          sessionId: spec.sessionId,
          serviceId,
          adapter: "local",
          dataPlaneEndpoint,
          capabilityDescriptor: descriptor as unknown as Record<
            string,
            unknown
          >,
          exposures,
        })
        minted = true
        // ② build + register the in-process confined plane bound to this
        // session's root (the same bytes the CAS working-set bridge materialized).
        const plane = createLocalBareDataPlane({
          sandboxRoot: spec.sandboxRoot,
          descriptor,
        })
        registerBareDataPlane(runtimeId, plane)
        // ③ the runtime's DB identity now exists → let the spine back-fill mounts.
        await spec.onRuntimeReady?.(runtimeId)
        return makeLocalBareHandle({
          sessionId: spec.sessionId,
          runtimeId,
          serviceId,
          dataPlaneEndpoint,
        })
      } catch (err) {
        if (minted) {
          const p = unregisterBareDataPlane(runtimeId)
          if (p) await p.dispose().catch(() => {})
          await deleteDevice(spec.workspaceId, runtimeId).catch(() => {})
        }
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "local" || ref.mode !== "bare") {
        throw new SandboxBackendError(
          `local:bare adapter cannot connect to a ${ref.adapter}:${ref.mode} sandbox`
        )
      }
      // Pure reconstruction (teardown/liveness). The plane is rebuilt lazily on
      // the next dispatch (bare-dispatch registry miss); this handle only needs
      // to drain any LIVE plane on kill().
      return makeLocalBareRefHandle(ref)
    },
    dataPlane(handle: SandboxHandle): SandboxDataPlane {
      const live = getLiveBareDataPlane(handle.runtimeLink.runtimeId)
      if (live) return live
      throw new SandboxBackendError(
        `no live data plane for bare runtime ${handle.runtimeLink.runtimeId}`
      )
    },
  }
}

function makeLocalBareHandle(args: {
  sessionId: string
  runtimeId: string
  serviceId: string
  dataPlaneEndpoint: string
}): SandboxHandle {
  const startedAt = new Date()
  return {
    adapter: "local",
    mode: "bare",
    sandboxId: args.sessionId,
    resourceId: "",
    runtimeLink: {
      mode: "bare",
      runtimeId: args.runtimeId,
      runtimeServiceId: args.serviceId,
      dataPlaneEndpoint: args.dataPlaneEndpoint,
    },
    getHost(): string {
      throw new SandboxBackendError(
        "getHost: user-port exposure is not configured for the local:bare sandbox adapter"
      )
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError(
        "setTimeout is not supported by the local:bare sandbox adapter"
      )
    },
    async isRunning(): Promise<boolean> {
      // In-process liveness: alive iff its plane is registered in THIS process.
      return getLiveBareDataPlane(args.runtimeId) !== undefined
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "local",
        sandboxId: args.sessionId,
        runtimeId: args.runtimeId,
        runtimeServiceId: args.serviceId,
        startedAt,
      }
    },
    async kill(): Promise<void> {
      // Scoped teardown: drain THIS plane's own children + drop it (S4). Never a
      // module global, never a sibling runtime.
      const p = unregisterBareDataPlane(args.runtimeId)
      if (p) await p.dispose().catch(() => {})
    },
  }
}

function makeLocalBareRefHandle(ref: SandboxRef): SandboxHandle {
  return {
    adapter: "local",
    mode: "bare",
    sandboxId: ref.sandboxId,
    resourceId: "",
    runtimeLink: {
      mode: "bare",
      runtimeId: ref.runtimeId,
      runtimeServiceId: ref.runtimeServiceId ?? "",
      dataPlaneEndpoint: `inprocess:${ref.runtimeId}`,
    },
    getHost(): string {
      throw new SandboxBackendError("getHost is not supported (local:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError("setTimeout is not supported (local:bare)")
    },
    async isRunning(): Promise<boolean> {
      return getLiveBareDataPlane(ref.runtimeId) !== undefined
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "local",
        sandboxId: ref.sandboxId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
      }
    },
    async kill(): Promise<void> {
      const p = unregisterBareDataPlane(ref.runtimeId)
      if (p) await p.dispose().catch(() => {})
    },
  }
}

// ─────────────────────────── registry resolution ─────────────────────────────

let warnedNullResolve = false

/**
 * Resolve the adapter for the CURRENT config (provision path). Returns null when
 * the provider is disabled ('none') or unregistered — warn-once, mirroring the
 * embedding/registry pattern. `${provider}:${mode}` keying: SANDBOX_MODE=bare now
 * actually selects a bare adapter (the P2 selector never did).
 */
export function resolveSandboxAdapter(
  provider: string,
  mode: "resident" | "bare",
  deps?: { hostProvider?: HostProvider; dockerSpawnImpl?: SpawnImpl }
): SandboxAdapter | null {
  const key = `${provider}:${mode}`
  switch (key) {
    case "local:resident":
      return makeLocalResidentAdapter({ hostProvider: deps?.hostProvider })
    case "docker:resident":
      return makeDockerResidentAdapter({
        dockerSpawnImpl: deps?.dockerSpawnImpl,
      })
    case "local:bare":
      return makeLocalBareAdapter()
    // docker:bare (S10) + e2b/cube (residual) are NOT registered in P4a.
    default: {
      if (provider !== "none" && !warnedNullResolve) {
        warnedNullResolve = true
        log.warn(
          { provider, mode, key },
          `no sandbox adapter registered for '${key}'; sandbox provisioning is unavailable`
        )
      }
      return null
    }
  }
}

/**
 * Resolve a teardown/liveness/reconnect adapter from a PERSISTED row's
 * (adapter, mode) — NEVER current config (inv-45). Its create() is never called
 * (connect-only), and for docker it uses the env-free reconnect backend (F-A).
 */
export function adapterForRow(
  adapter: string,
  mode: "resident" | "bare",
  deps?: { dockerSpawnImpl?: SpawnImpl }
): SandboxAdapter {
  const key = `${adapter}:${mode}`
  switch (key) {
    case "local:resident":
      return makeLocalResidentAdapter()
    case "docker:resident":
      return makeDockerResidentAdapter({
        dockerSpawnImpl: deps?.dockerSpawnImpl,
      })
    case "local:bare":
      return makeLocalBareAdapter()
    default:
      // Unknown/deferred (docker:bare S10, e2b/cube): fall back to a resident
      // adapter of the same provider so a legacy row is still killable. docker
      // rides the env-free reconnect backend either way.
      if (adapter === "docker") {
        return makeDockerResidentAdapter({
          dockerSpawnImpl: deps?.dockerSpawnImpl,
        })
      }
      return makeLocalResidentAdapter()
  }
}
