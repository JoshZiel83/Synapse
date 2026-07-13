// Sandbox ADAPTER registry (§4.1 / §4.7.2). Supersedes the P2 `selectSandboxBackend`
// (which forked ONLY on provider and never on mode — so SANDBOX_MODE=bare was
// inert). An adapter is keyed `${provider}:${mode}` and carries the metadata the
// provision spine forks on (catalogSource, capabilities) plus the lifecycle
// (create/connect). The bare data plane is rebuilt lazily by bare-dispatch on a
// registry miss (adapter-bound endpoint scheme, P1.3); it is NOT carried on the
// adapter (the dead `dataPlane?()` method was removed in P1.2). P1.2 INVARIANT
// (machine-enforced by adapter-registry-fail-closed.test.ts): every BARE adapter
// is host-side (capabilities.confinedFs==='native') — that is what makes the
// current host-dir materialize/commit-scan + host-side endpoint fork valid. The
// first OFF-BOX (e2b/cube, confinedFs:'unsupported') adapter will TRIP that guard,
// forcing the adapter.rebuildDataPlane + off-box working-set seam to be built and
// VALIDATED alongside it in P4b (it cannot be validated today without an account).
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
import { existsSync } from "node:fs"
import { join } from "node:path"
import { spawn as nodeSpawn } from "node:child_process"
import { SANDBOX_MOUNT_POINTS } from "@synapse/shared"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { deleteRuntime, mintBareSandboxRuntime } from "../devices/service.js"
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
  buildBareDockerRunArgs,
  runDockerCapture,
  SANDBOX_SESSION_LABEL,
  type DockerSandboxBackendOptions,
  type SpawnImpl,
} from "./docker-sandbox-backend.js"
import { createLocalHostProvider, type HostProvider } from "./host-provider.js"
import {
  createLocalBareDataPlane,
  createDockerBareDataPlane,
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
  /** Written to sandboxes.adapter (== provider); the sole persisted adapter tag (P3). */
  readonly kind: SandboxBackendKind
  readonly catalogSource: "control_plane" | "api_authored"
  /** Frozen descriptor for a bare adapter; null for a resident adapter. */
  readonly capabilities: SandboxCapabilityDescriptor | null
  create(spec: SandboxSpec): Promise<SandboxHandle>
  connect(ref: SandboxRef): Promise<SandboxHandle>
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
  const probedIsolation = bwrapAvailable() ? "bwrap" : null
  const isolation =
    overrides?.isolation !== undefined ? overrides.isolation : probedIsolation
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
          await deleteRuntime(spec.workspaceId, runtimeId).catch(() => {})
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

// ─────────────────────────── docker:bare adapter (Mode-B) ────────────────────

const DOCKER_BARE_CAPS = {
  maxReadBytes: 10 * 1024 * 1024,
  maxWriteBytes: 50 * 1024 * 1024,
  maxConcurrentExec: 4,
} as const

export interface DockerBareRunOptions {
  bareImage: string
  storageVolume: string
  runAsUid?: number
  pidsLimit: number
  memory: string
  pureNetwork?: string
}

/** Build the docker:bare run options from the validated config.sandbox.docker
 *  namespace (the hardened-container facts; NO frp/provision secrets). */
export function dockerBareOptionsFromEnv(): DockerBareRunOptions {
  const dk = config.sandbox.docker
  return {
    bareImage: dk.bareImage,
    storageVolume: dk.storageVolume,
    runAsUid: dk.runAsUid,
    pidsLimit: dk.pidsLimit,
    memory: dk.memory,
    pureNetwork: dk.pureNetwork || undefined,
  }
}

/** docker:bare descriptor. isolation:'container' — the hardened container IS the
 *  jail (exec runs in-container via `docker exec`); confinedFs:'native' — fs ops
 *  are HOST-SIDE realpath-confined. NEVER pty (F-D). */
export function buildDockerBareDescriptor(overrides?: {
  search?: boolean
  egress?: "none" | "named"
}): SandboxCapabilityDescriptor {
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
      maxReadBytes: DOCKER_BARE_CAPS.maxReadBytes,
      maxWriteBytes: DOCKER_BARE_CAPS.maxWriteBytes,
      maxConcurrentExec: DOCKER_BARE_CAPS.maxConcurrentExec,
    },
    advancedTools: [],
    isolation: "container",
    egress: overrides?.egress ?? "none",
    reconnectable: true,
  }
}

export interface MakeDockerBareAdapterDeps {
  /** Force the descriptor (test seam for the degraded variant, S13). */
  descriptorOverride?: SandboxCapabilityDescriptor
  /** Inject the mint (test seam). */
  mintRuntime?: typeof mintBareSandboxRuntime
  /** Inject the docker CLI spawner (test seam — align with docker-sandbox-backend.test.ts). */
  dockerSpawnImpl?: SpawnImpl
  /** Force the run options (test seam). */
  optionsOverride?: DockerBareRunOptions
}

function sanitizeContainerName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

export function makeDockerBareAdapter(
  deps: MakeDockerBareAdapterDeps = {}
): SandboxAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const spawnImpl = deps.dockerSpawnImpl ?? nodeSpawn
  const runOpts = deps.optionsOverride ?? dockerBareOptionsFromEnv()
  const descriptor =
    deps.descriptorOverride ??
    buildDockerBareDescriptor({
      egress: runOpts.pureNetwork ? "named" : "none",
    })
  return {
    key: "docker:bare",
    provider: "docker",
    mode: "bare",
    kind: "docker",
    catalogSource: "api_authored",
    capabilities: descriptor,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // uid-PARITY create-time probe (defense-in-depth over the boot superRefine):
      // docker:bare fs is host-side, so a container uid ≠ the API uid corrupts
      // shared-volume ownership. State the root-in-container caveat.
      const apiUid =
        typeof process.getuid === "function" ? process.getuid() : undefined
      if (apiUid !== undefined && (runOpts.runAsUid ?? 0) !== apiUid) {
        throw new SandboxBackendError(
          `docker:bare uid-parity violation: runAsUid=${runOpts.runAsUid ?? 0} != API uid ${apiUid}${
            apiUid === 0
              ? " (API runs as root → the container also runs as root; run the API unprivileged for real isolation)"
              : ""
          }`
        )
      }
      // Mount ONLY the mount-point dirs that EXIST on the host (never the session
      // root — HOST-RCE trap). The spine pre-created + materialized them before
      // create(), so they resolve for the volume-subpath mounts.
      const mountPoints = SANDBOX_MOUNT_POINTS.map((m) =>
        m.replace(/^\//, "")
      ).filter((name) => existsSync(join(spec.sandboxRoot, name)))
      if (mountPoints.length === 0) {
        throw new SandboxBackendError(
          `docker:bare: no mount-point dirs exist under ${spec.sandboxRoot}`
        )
      }
      const containerName = `synapse-sbx-bare-${sanitizeContainerName(spec.sessionId)}`
      // best-effort stale removal of a same-name container.
      await runDockerCapture(spawnImpl, ["rm", "-f", containerName]).catch(
        () => {}
      )
      // ① docker run the HARDENED keepalive container.
      const runArgs = buildBareDockerRunArgs({
        opts: runOpts,
        spec,
        containerName,
        mountPoints,
      })
      const runRes = await runDockerCapture(spawnImpl, runArgs).catch((err) => {
        throw new SandboxBackendError(
          `docker run (bare) failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      if (runRes.code !== 0) {
        throw new SandboxBackendError(
          `docker run (bare) exited ${runRes.code}: ${runRes.stderr.slice(0, 300)}`
        )
      }
      const containerId = runRes.stdout.trim().split("\n").pop()?.trim() ?? ""
      if (!containerId) {
        throw new SandboxBackendError(
          "docker run (bare) returned no container id"
        )
      }
      let mintedRuntimeId: string | null = null
      try {
        // create-time probe: the image must carry `timeout` + `bash` for exec.
        const probe = await runDockerCapture(
          spawnImpl,
          [
            "exec",
            containerId,
            "sh",
            "-c",
            "command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1",
          ],
          { containerId }
        )
        if (probe.code !== 0) {
          throw new SandboxBackendError(
            `docker:bare image '${runOpts.bareImage}' lacks timeout/bash (exec probe exit ${probe.code})`
          )
        }
        const runtimeId = randomUUID()
        const serviceId = randomUUID()
        const dataPlaneEndpoint = `docker-exec:${containerId}`
        await mint({
          runtimeId,
          workspaceId: spec.workspaceId,
          sessionId: spec.sessionId,
          serviceId,
          adapter: "docker",
          dataPlaneEndpoint,
          capabilityDescriptor: descriptor as unknown as Record<
            string,
            unknown
          >,
          exposures: buildBareCoreCatalog(descriptor),
        })
        mintedRuntimeId = runtimeId
        const plane = createDockerBareDataPlane({
          sandboxRoot: spec.sandboxRoot,
          descriptor,
          containerId,
          spawnImpl,
        })
        registerBareDataPlane(runtimeId, plane)
        await spec.onRuntimeReady?.(runtimeId)
        return makeDockerBareHandle({
          sessionId: spec.sessionId,
          runtimeId,
          serviceId,
          containerId,
          spawnImpl,
        })
      } catch (err) {
        if (mintedRuntimeId) {
          const p = unregisterBareDataPlane(mintedRuntimeId)
          if (p) await p.dispose().catch(() => {})
          await deleteRuntime(spec.workspaceId, mintedRuntimeId).catch(() => {})
        }
        // Always reap the container we ran.
        await runDockerCapture(spawnImpl, ["rm", "-f", containerId]).catch(
          () => {}
        )
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "docker" || ref.mode !== "bare") {
        throw new SandboxBackendError(
          `docker:bare adapter cannot connect to a ${ref.adapter}:${ref.mode} sandbox`
        )
      }
      // Pure reconstruction (teardown/liveness). The plane rebuilds lazily on the
      // next dispatch (bare-dispatch registry miss forks on docker-exec:<cid>).
      return makeDockerBareRefHandle(ref, spawnImpl)
    },
  }
}

function makeDockerBareHandle(args: {
  sessionId: string
  runtimeId: string
  serviceId: string
  containerId: string
  spawnImpl: SpawnImpl
}): SandboxHandle {
  const startedAt = new Date()
  const kill = async (): Promise<void> => {
    // Scoped teardown: drop THIS plane + its children, then stop+rm the container.
    const p = unregisterBareDataPlane(args.runtimeId)
    if (p) await p.dispose().catch(() => {})
    await runDockerCapture(args.spawnImpl, [
      "stop",
      "-t",
      "5",
      args.containerId,
    ]).catch(() => {})
    await runDockerCapture(args.spawnImpl, [
      "rm",
      "-f",
      args.containerId,
    ]).catch(() => {})
  }
  return {
    adapter: "docker",
    mode: "bare",
    sandboxId: args.sessionId,
    resourceId: args.containerId,
    runtimeLink: {
      mode: "bare",
      runtimeId: args.runtimeId,
      runtimeServiceId: args.serviceId,
      dataPlaneEndpoint: `docker-exec:${args.containerId}`,
    },
    getHost(): string {
      throw new SandboxBackendError("getHost is not supported (docker:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError("setTimeout is not supported (docker:bare)")
    },
    async isRunning(): Promise<boolean> {
      const out = await runDockerCapture(args.spawnImpl, [
        "inspect",
        "--format",
        "{{.State.Running}}",
        args.containerId,
      ]).catch(() => null)
      return out?.stdout.trim() === "true"
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "docker",
        sandboxId: args.sessionId,
        runtimeId: args.runtimeId,
        runtimeServiceId: args.serviceId,
        startedAt,
      }
    },
    kill,
  }
}

function makeDockerBareRefHandle(
  ref: SandboxRef,
  spawnImpl: SpawnImpl
): SandboxHandle {
  const containerId = ref.resourceId
  return {
    adapter: "docker",
    mode: "bare",
    sandboxId: ref.sandboxId,
    resourceId: containerId,
    runtimeLink: {
      mode: "bare",
      runtimeId: ref.runtimeId,
      runtimeServiceId: ref.runtimeServiceId ?? "",
      dataPlaneEndpoint: `docker-exec:${containerId}`,
    },
    getHost(): string {
      throw new SandboxBackendError("getHost is not supported (docker:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError("setTimeout is not supported (docker:bare)")
    },
    async isRunning(): Promise<boolean> {
      const out = await runDockerCapture(spawnImpl, [
        "inspect",
        "--format",
        "{{.State.Running}}",
        containerId,
      ]).catch(() => null)
      return out?.stdout.trim() === "true"
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "docker",
        sandboxId: ref.sandboxId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
      }
    },
    async kill(): Promise<void> {
      const p = unregisterBareDataPlane(ref.runtimeId)
      if (p) await p.dispose().catch(() => {})
      await runDockerCapture(spawnImpl, ["stop", "-t", "5", containerId]).catch(
        () => {}
      )
      await runDockerCapture(spawnImpl, ["rm", "-f", containerId]).catch(
        () => {}
      )
    },
  }
}

// ─────────────────────────── registry resolution ─────────────────────────────

let warnedNullResolve = false

/**
 * The SINGLE `${provider}:${mode}` → adapter-factory map (P8B). Both the
 * provision resolver (resolveSandboxAdapter) and the persisted-row resolver
 * (adapterForRow) consume it, so the 4-key adapter set is declared ONCE and the
 * fail-closed default falls out of a single lookup — there is no second switch
 * to drift. e2b/cube (residual) stay UNregistered in P4a; a miss is the
 * fail-closed case both consumers key off of.
 */
const ADAPTER_FACTORIES: Record<
  string,
  (deps?: {
    hostProvider?: HostProvider
    dockerSpawnImpl?: SpawnImpl
  }) => SandboxAdapter
> = {
  "local:resident": (deps) =>
    makeLocalResidentAdapter({ hostProvider: deps?.hostProvider }),
  "docker:resident": (deps) =>
    makeDockerResidentAdapter({ dockerSpawnImpl: deps?.dockerSpawnImpl }),
  "local:bare": () => makeLocalBareAdapter(),
  "docker:bare": (deps) =>
    makeDockerBareAdapter({ dockerSpawnImpl: deps?.dockerSpawnImpl }),
}

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
  const factory = ADAPTER_FACTORIES[key]
  if (factory) return factory(deps)
  // e2b/cube (residual) are NOT registered in P4a.
  if (provider !== "none" && !warnedNullResolve) {
    warnedNullResolve = true
    log.warn(
      { provider, mode, key },
      `no sandbox adapter registered for '${key}'; sandbox provisioning is unavailable`
    )
  }
  return null
}

/**
 * Resolve a teardown/liveness/reconnect adapter from a PERSISTED row's
 * (adapter, mode) — NEVER current config (inv-45). Its create() is never called
 * (connect-only), and for docker it uses the env-free reconnect backend (F-A).
 *
 * FAIL-CLOSED (P8B): an unknown persisted adapter key THROWS rather than
 * silently downgrading to a local resident adapter. A silent downgrade would run
 * teardown / liveness / reconnect on the WRONG substrate (e.g. treat a persisted
 * docker/e2b row as a local in-process runtime), potentially mis-reaping or
 * declaring a live sandbox dead. Throwing is safe because every teardown caller
 * try/catches with a hostPid fallback, so an unrecognized legacy row degrades to
 * that fallback instead of a wrong-substrate action.
 */
export function adapterForRow(
  adapter: string,
  mode: "resident" | "bare",
  deps?: { dockerSpawnImpl?: SpawnImpl }
): SandboxAdapter {
  const key = `${adapter}:${mode}`
  const factory = ADAPTER_FACTORIES[key]
  if (!factory) {
    throw new SandboxBackendError(
      `adapterForRow: unknown persisted adapter key '${key}' (fail-closed; no legacy downgrade)`
    )
  }
  return factory(deps)
}
