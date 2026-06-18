// Sandbox backend — the E2B-SDK-SHAPED lifecycle abstraction for per-session
// actor sandboxes. We mirror the *shape* of the e2b Sandbox class's lifecycle
// methods (create / connect / kill / getHost / setTimeout / isRunning) so a
// future E2B-cloud / k8s / Firecracker backend can slot in, but we DO NOT
// import the `e2b` package or call E2B's orchestrator/envd — the contract is
// internal and the reference is `e2b@2.27.0`.
//
// SCOPE: this abstracts the LIFECYCLE layer only (stand up / tear down a
// sandbox runtime + expose a port). The DATA PLANE (filesystem + commands)
// stays on Synapse's device-runtime MCP builtins reached via the frp tunnel +
// dispatchSyncTool — it is NOT modeled here (no commands/files/pty).
//
// Two backends implement this:
//   - local  → adapts the existing two-phase HostProvider (pair + run as a
//     same-host child process). See createLocalSandboxBackend below.
//   - docker → DooD: `docker run`s the cloud-sandbox image and bridges the
//     bootstrap-on-boot handshake. See docker-sandbox-backend.ts (Phase 3).

import {
  type HostProvider,
  type RunHandle,
  type SpawnSandboxRuntimeParams,
} from "./host-provider.js"
import { deleteDevice } from "../devices/service.js"
import { cancelPendingPairingSession } from "./repo.js"

/** Which backend produced/owns a sandbox. Persisted on file_mounts so teardown
 *  picks the right backend regardless of the API's current env. */
export type SandboxBackendKind = "local" | "docker"

/**
 * Everything provisionSandbox hands a backend to stand up one sandbox. The
 * backend owns its pairing handshake (local: startPairing+pair; docker:
 * createCloudDevicePairing+bootstrap) — the spine only supplies session-scoped
 * facts and lifecycle callbacks.
 */
export interface SandboxSpec {
  /** The Synapse logical sandbox id == sessionId. Also the liveHandles key. */
  sessionId: string
  workspaceId: string
  /** Per-session sandbox root on the API's view of the FS (materialized mounts live here). */
  sandboxRoot: string
  /**
   * Docker backend only: the sandbox root expressed RELATIVE TO the storage
   * volume's mount point inside the API container, for `--mount volume-subpath=`.
   * The spine computes it from STORAGE_DIR vs the volume mount point (a
   * deployment convention) so the backend never hardcodes the layout — see
   * `toSandboxVolumeSubpath`. The local backend ignores it (it uses
   * `sandboxRoot` directly on the same host).
   */
  storageVolumeSubpath?: string
  /** Absolute fs-helper path (local passes via --fs-helper; docker maps into the container). */
  fsHelperPath: string
  /** API origin the device dials back to. Internal address for docker (api:3001). */
  serverOrigin: string
  enableDelete?: boolean
  /** Always true for sandboxes (confine commands; device fail-closes if bwrap absent). */
  confineCommands: boolean
  title?: string
  /**
   * Lifecycle callbacks for STAGED persistence (crash recovery). The backend
   * MUST `await` each as soon as the underlying fact exists, so a mid-provision
   * crash leaves enough in file_mounts for the startup reconciler to reattach
   * or safely clean up. Each callback must be idempotent across the session's
   * mounts. A callback that throws aborts create() (which then runs its own
   * cleanup).
   */
  onPairingCreated?: (pairingSessionId: string) => Promise<void>
  onResourceCreated?: (sandboxResourceId: string) => Promise<void>
  onDeviceClaimed?: (deviceId: string) => Promise<void>
}

/** Identifies a sandbox runtime well enough to reconnect/kill it from another
 *  process (teardown after an API restart). Rebuilt from a file_mounts row. */
export interface SandboxRef {
  backend: SandboxBackendKind
  /** == sessionId. */
  sandboxId: string
  /** Provider resource id: docker container id; k8s pod; "" for local. */
  sandboxResourceId: string
  deviceId: string
  deviceServiceId?: string
  pairingSessionId?: string
  /** Local backend only: OS pid for SIGTERM/SIGKILL. */
  hostPid?: number
}

/** Synapse convenience subset (NOT a 1:1 mirror of e2b's static getInfo). */
export interface SandboxInfo {
  backend: SandboxBackendKind
  sandboxId: string
  deviceId: string
  deviceServiceId: string
  /**
   * Wall-clock time the sandbox process was started. Undefined when the handle
   * was re-attached from a persisted SandboxRef across a process restart — the
   * real start time is not recoverable there, so we omit it rather than
   * fabricating an epoch-0 placeholder.
   */
  startedAt?: Date
}

/** A live sandbox handle — mirrors the e2b Sandbox INSTANCE methods we use. */
export interface SandboxHandle {
  readonly backend: SandboxBackendKind
  /** == sessionId. */
  readonly sandboxId: string
  /** Provider resource id (container id / pod / ""). */
  readonly sandboxResourceId: string
  readonly deviceId: string
  readonly deviceServiceId: string
  readonly pairingSessionId?: string
  /** Local backend only. */
  readonly hostPid?: number

  /**
   * e2b: getHost(port) → public host for an EXPOSED USER port (an http server /
   * chromium the agent started). This is NOT the MCP dispatch channel (that is
   * reached by dispatchSyncTool via the tunnel registry, keyed by
   * deviceServiceId). v1 has no consumer and no per-port routing, so this
   * THROWS rather than return an unusable address.
   */
  getHost(port: number): string

  /** e2b: setTimeout(ms) — extend the auto-kill deadline. v1 docker backend
   *  throws "unsupported"; local backend has no deadline either. */
  setTimeout(ms: number): Promise<void>

  /** e2b: isRunning() — liveness probe. */
  isRunning(): Promise<boolean>

  /** Synapse convenience (not e2b instance method). */
  getInfo(): SandboxInfo

  /** e2b: instance.kill(). Idempotent. local → SIGTERM/SIGKILL; docker → stop+rm. */
  kill(): Promise<void>
}

export interface SandboxBackend {
  readonly kind: SandboxBackendKind
  /** e2b: Sandbox.create(). Stand up a NEW sandbox; resolve once device+service
   *  ids are known (catalog wait + grants stay in the spine). */
  create(spec: SandboxSpec): Promise<SandboxHandle>
  /** e2b: Sandbox.connect(id). Re-attach from a SandboxRef (cross-process
   *  teardown / crash recovery). */
  connect(ref: SandboxRef): Promise<SandboxHandle>
}

export class SandboxBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxBackendError"
  }
}

/**
 * Local backend: adapts the existing two-phase HostProvider (startPairing is
 * driven by the spine and passed in via spec-less wiring — see service.ts).
 * The impedance (two-phase pair/run vs one-shot create) is absorbed here.
 *
 * NOTE: the local pairing handshake (startPairing(local_qr) → pairingCode)
 * still lives in the spine because it needs workspace/session context the
 * HostProvider abstraction deliberately doesn't carry; the spine passes the
 * resolved `pairingCode` + broker dir to `createLocalSandboxBackend(...).create`
 * via the `pairing` argument. This keeps the HostProvider contract unchanged.
 */
export function createLocalSandboxBackend(deps: {
  hostProvider: HostProvider
  /** Resolve the per-session pairing code + broker dir + control-plane facts.
   *  Provided by the spine (it owns startPairing + session context). */
  beginLocalPairing: (spec: SandboxSpec) => Promise<{
    pairingCode: string
    brokerDir: string
    pairingSessionId: string
  }>
  /**
   * Test seam: cleanup primitive run when create() fails after pairing. Defaults
   * to the real DB-backed {@link defaultLocalFailCleanup} (delete device + cancel
   * pairing); a unit test injects a spy to assert the leak is cleaned WITHOUT a
   * live DB.
   */
  failCleanup?: (args: {
    workspaceId: string
    deviceId: string | null
    pairingSessionId: string | null
  }) => Promise<void>
}): SandboxBackend {
  const { hostProvider, beginLocalPairing } = deps
  const failCleanup = deps.failCleanup ?? defaultLocalFailCleanup
  return {
    kind: "local",
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // Track created facts so a failure at ANY point after pairing (run() or a
      // staged callback throwing) self-cleans them — honoring the SandboxSpec
      // contract. Without this, a device claimed by pair() (or a cancelled
      // pairing) leaks: the spine's create() cleanup only runs when create()
      // RETURNED a handle, which it never does on this path.
      const { pairingCode, brokerDir, pairingSessionId } =
        await beginLocalPairing(spec)
      const workspaceId = spec.workspaceId
      let deviceId: string | null = null
      try {
        await spec.onPairingCreated?.(pairingSessionId)

        const spawnParams: SpawnSandboxRuntimeParams = {
          pairingCode,
          brokerDir,
          fsRoot: spec.sandboxRoot,
          fsHelperPath: spec.fsHelperPath,
          serverOrigin: spec.serverOrigin,
          enableDelete: spec.enableDelete,
          confineCommands: spec.confineCommands,
          title: spec.title,
        }
        const paired = await hostProvider.pair(spawnParams)
        deviceId = paired.deviceId
        await spec.onDeviceClaimed?.(paired.deviceId)
        const runHandle = await hostProvider.run(spawnParams)
        return makeLocalHandle({
          sessionId: spec.sessionId,
          deviceId: paired.deviceId,
          deviceServiceId: paired.serviceId,
          pairingSessionId,
          runHandle,
        })
      } catch (err) {
        // Comprehensive self-cleanup: delete the paired device (cascades its
        // services/exposures/grants) and cancel a still-pending pairing session
        // so its code can't be reused. Idempotent + best-effort; rethrow.
        await failCleanup({ workspaceId, deviceId, pairingSessionId }).catch(
          () => {}
        )
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.backend !== "local") {
        throw new SandboxBackendError(
          `local backend cannot connect to a ${ref.backend} sandbox`
        )
      }
      // Cross-process reconnect: we have no live ChildProcess handle, only the
      // host_pid. kill() falls back to signalling the pid directly.
      return makeLocalRefHandle(ref)
    },
  }
}

/**
 * Default self-cleanup for a local create() that failed after pairing. Deletes
 * the paired device (cascades its services/exposures/grants) and cancels a
 * still-pending pairing session so the code can't be reused. Best-effort +
 * idempotent. Overridable via createLocalSandboxBackend({ failCleanup }) for
 * DB-free unit tests.
 */
async function defaultLocalFailCleanup(args: {
  workspaceId: string
  deviceId: string | null
  pairingSessionId: string | null
}): Promise<void> {
  if (args.deviceId) {
    await deleteDevice(args.workspaceId, args.deviceId).catch(() => {})
  }
  if (args.pairingSessionId) {
    await cancelPendingPairingSession(args.pairingSessionId).catch(() => {})
  }
}

function makeLocalHandle(args: {
  sessionId: string
  deviceId: string
  deviceServiceId: string
  pairingSessionId: string
  runHandle: RunHandle
}): SandboxHandle {
  const startedAt = new Date()
  return {
    backend: "local",
    sandboxId: args.sessionId,
    sandboxResourceId: "",
    deviceId: args.deviceId,
    deviceServiceId: args.deviceServiceId,
    pairingSessionId: args.pairingSessionId,
    hostPid: args.runHandle.pid,
    getHost(): string {
      throw new SandboxBackendError(
        "getHost: user-port exposure is not configured for the local sandbox backend"
      )
    },
    async setTimeout(): Promise<void> {
      // Local sandboxes have no auto-kill deadline; lifecycle is teardown-driven.
      throw new SandboxBackendError(
        "setTimeout is not supported by the local sandbox backend"
      )
    },
    async isRunning(): Promise<boolean> {
      return isPidAlive(args.runHandle.pid)
    },
    getInfo(): SandboxInfo {
      return {
        backend: "local",
        sandboxId: args.sessionId,
        deviceId: args.deviceId,
        deviceServiceId: args.deviceServiceId,
        startedAt,
      }
    },
    kill(): Promise<void> {
      return args.runHandle.stop()
    },
  }
}

function makeLocalRefHandle(ref: SandboxRef): SandboxHandle {
  return {
    backend: "local",
    sandboxId: ref.sandboxId,
    sandboxResourceId: "",
    deviceId: ref.deviceId,
    deviceServiceId: ref.deviceServiceId ?? "",
    pairingSessionId: ref.pairingSessionId,
    hostPid: ref.hostPid,
    getHost(): string {
      throw new SandboxBackendError(
        "getHost: user-port exposure is not configured for the local sandbox backend"
      )
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError(
        "setTimeout is not supported by the local sandbox backend"
      )
    },
    async isRunning(): Promise<boolean> {
      return ref.hostPid !== undefined && isPidAlive(ref.hostPid)
    },
    getInfo(): SandboxInfo {
      return {
        backend: "local",
        sandboxId: ref.sandboxId,
        deviceId: ref.deviceId,
        deviceServiceId: ref.deviceServiceId ?? "",
        // Re-attached from a persisted SandboxRef: the real start time is not
        // recorded in the ref, so leave it undefined rather than fabricating one.
      }
    },
    async kill(): Promise<void> {
      if (ref.hostPid === undefined) return
      await signalPid(ref.hostPid)
    },
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const KILL_GRACE_MS = 2_000

async function signalPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return // already gone
  }
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* gone */
      }
      resolvePromise()
    }, KILL_GRACE_MS)
    const poll = setInterval(() => {
      if (!isPidAlive(pid)) {
        clearTimeout(timer)
        clearInterval(poll)
        resolvePromise()
      }
    }, 100)
  })
}
