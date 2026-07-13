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

import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { createFileBackedBroker } from "@synapse/device-runtime"
import {
  type HostProvider,
  type RunHandle,
  type SpawnSandboxRuntimeParams,
} from "./host-provider.js"
import { deleteRuntime, mintLocalSandboxRuntime } from "../devices/service.js"

/** Which adapter produced/owns a sandbox runtime. Persisted on sandboxes.adapter
 *  so teardown picks the right adapter regardless of the API's current config. P2 registered local + docker (Mode-A
 *  resident); P4a adds the bare (Mode-B) reference adapters under the SAME
 *  provider strings ("local"/"docker") — the `sandboxes.mode` column
 *  disambiguates resident vs bare. Future provider substrates (e2b/cube) widen
 *  this when they land. */
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
   * Fired the instant the runtime's DB identity exists (docker: bootstrap consumed;
   * local: mintLocalSandboxRuntimeTx). Carries the runtime id (the sandboxes.id ==
   * runtimes.id) so the spine can back-fill the mount's sole identity column,
   * file_mounts.sandbox_id. MUST be awaited; idempotent; a throw aborts create()
   * (which then runs its own cleanup). Renamed from onDeviceClaimed (a sandbox runtime
   * has no `devices` row — the identity is the runtime).
   *
   * (P3: the former onPairingCreated / onResourceCreated staged-persistence callbacks
   * are gone — pairing + resource id live on the sandboxes row, written at mint /
   * post-create, and a pre-bootstrap docker container is reaped by its session label,
   * not a mount column. The mount carries only sandbox_id now.)
   */
  onRuntimeReady?: (runtimeId: string) => Promise<void>
}

/** Identifies a sandbox runtime well enough to reconnect/kill it from another
 *  process (teardown after an API restart). Rebuilt from the owning sandboxes row
 *  (state-agnostic control-path resolver — the sole identity source; P3). */
export interface SandboxRef {
  /** The owning adapter (sandboxes.adapter — row-driven, never current config). */
  adapter: string
  mode: "resident" | "bare"
  /** == sessionId (the liveSandboxHandles registry key). */
  sandboxId: string
  /** Provider resource id: docker container id; k8s pod; "" for local. */
  resourceId: string
  /** The runtime id (== sandboxes.id == runtimes.id). NO devices row for a sandbox. */
  runtimeId: string
  runtimeServiceId?: string
  pairingSessionId?: string
  /** Local backend only: OS pid for SIGTERM/SIGKILL. */
  hostPid?: number
}

/** Synapse convenience subset (NOT a 1:1 mirror of e2b's static getInfo). */
export interface SandboxInfo {
  adapter: string
  sandboxId: string
  runtimeId: string
  runtimeServiceId: string
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
  readonly adapter: string
  readonly mode: "resident" | "bare"
  /** == sessionId (the liveSandboxHandles registry key). */
  readonly sandboxId: string
  /** Provider resource id (container id / pod / ""). */
  readonly resourceId: string
  /** The runtime linkage: the sandbox-kind runtime id + its runtime-service id
   *  (NO devices row). resident → a paired device_runtime service reached over a
   *  tunnel; bare (P4a Mode-B) → a bare_dataplane service dialed directly at a
   *  non-tunnel `dataPlaneEndpoint` (scheme-tagged inprocess:/docker-exec:). */
  readonly runtimeLink:
    | {
        mode: "resident"
        runtimeId: string
        runtimeServiceId: string
      }
    | {
        mode: "bare"
        runtimeId: string
        runtimeServiceId: string
        dataPlaneEndpoint: string
      }
  readonly pairingSessionId?: string
  /** Local backend only. */
  readonly hostPid?: number

  /**
   * e2b: getHost(port) → public host for an EXPOSED USER port (an http server /
   * chromium the agent started). This is NOT the MCP dispatch channel (that is
   * reached by dispatchSyncTool via the tunnel registry, keyed by
   * runtimeServiceId). v1 has no consumer and no per-port routing, so this
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
 * Local backend (§4.6 direct-mint): stands up a device-less sandbox-kind runtime
 * as a same-host child WITHOUT the pairing-code round-trip. create() mints the
 * runtime + service + service key in one DB tx (mintLocalSandboxRuntime), authors
 * the on-disk broker identity the child `synapse-device run` loads, then spawns
 * the daemon (no `pair` child, --tunnel-mode=noop loopback). The API reuses the
 * SAME broker helpers the child reads, so there is zero identity-format drift:
 * device.hello verifies the SERVICE key against runtime_service_keys (the device
 * pubkey never persists — it lives only in the identity file).
 */
export function createLocalSandboxBackend(deps: {
  hostProvider: HostProvider
  /** Test seam: the atomic DB mint (defaults to the real mintLocalSandboxRuntime). */
  mintRuntime?: typeof mintLocalSandboxRuntime
  /**
   * Test seam: cleanup primitive run when create() fails after the mint.
   * Defaults to {@link defaultLocalFailCleanup} (soft-delete the runtime + rm the
   * broker dir); a unit test injects a spy to assert the leak is cleaned.
   */
  failCleanup?: (args: {
    workspaceId: string
    runtimeId: string | null
    brokerDir: string
  }) => Promise<void>
}): SandboxBackend {
  const { hostProvider } = deps
  const mintRuntime = deps.mintRuntime ?? mintLocalSandboxRuntime
  const failCleanup = deps.failCleanup ?? defaultLocalFailCleanup
  return {
    kind: "local",
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      const brokerDir = join(spec.sandboxRoot, ".broker")
      const broker = createFileBackedBroker({ brokerDir })
      const serviceKey = await broker.generateKeyPair("service:device_runtime")
      // FRESH UUID per provision (CORRECTION 1) — sessionId would PK-collide with
      // a soft-deleted runtime on re-provision.
      const runtimeId = randomUUID()
      const serviceId = randomUUID()
      const serviceKeyId = randomUUID()
      let mintedRuntimeId: string | null = null
      try {
        // ① atomically mint the device-less sandbox-kind runtime (no pairing
        // round-trip, no devices row).
        await mintRuntime({
          runtimeId,
          workspaceId: spec.workspaceId,
          sessionId: spec.sessionId,
          serviceId,
          serviceKeyId,
          servicePubkey: serviceKey.publicKey,
          serviceFingerprint: serviceKey.publicKeyFingerprint,
        })
        mintedRuntimeId = runtimeId
        // ② author the on-disk identity the child `synapse-device run` loads.
        await broker.saveDeviceIdentity({
          deviceId: runtimeId,
          serverOrigin: spec.serverOrigin,
          hostKind: "local",
          services: [
            {
              serviceKind: "device_runtime",
              serviceId,
              pubkeyFingerprint: serviceKey.publicKeyFingerprint,
              privateKeyRef: serviceKey.privateKeyRef,
            },
          ],
        })
        // The runtime's DB identity now exists → let the spine back-fill mounts.
        await spec.onRuntimeReady?.(runtimeId)
        // ③ spawn the long-lived daemon (no `pair` child).
        const spawnParams: SpawnSandboxRuntimeParams = {
          brokerDir,
          fsRoot: spec.sandboxRoot,
          fsHelperPath: spec.fsHelperPath,
          serverOrigin: spec.serverOrigin,
          enableDelete: spec.enableDelete,
          confineCommands: spec.confineCommands,
          title: spec.title,
        }
        const runHandle = await hostProvider.run(spawnParams)
        return makeLocalHandle({
          sessionId: spec.sessionId,
          runtimeId,
          runtimeServiceId: serviceId,
          runHandle,
        })
      } catch (err) {
        // Self-clean: soft-delete the minted sandbox runtime (keeps children for
        // audit) + remove the broker dir so a re-provision starts clean.
        await failCleanup({
          workspaceId: spec.workspaceId,
          runtimeId: mintedRuntimeId,
          brokerDir,
        }).catch(() => {})
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "local") {
        throw new SandboxBackendError(
          `local backend cannot connect to a ${ref.adapter} sandbox`
        )
      }
      // Cross-process reconnect: we have no live ChildProcess handle, only the
      // host_pid. kill() falls back to signalling the pid directly.
      return makeLocalRefHandle(ref)
    },
  }
}

/**
 * Default self-cleanup for a local create() that failed after the mint:
 * soft-delete the sandbox runtime (flips runtimes.deleted_at, keeps children for
 * audit) and remove the broker dir so its identity can't be reused. Best-effort +
 * idempotent. Overridable via createLocalSandboxBackend({ failCleanup }).
 */
async function defaultLocalFailCleanup(args: {
  workspaceId: string
  runtimeId: string | null
  brokerDir: string
}): Promise<void> {
  if (args.runtimeId) {
    await deleteRuntime(args.workspaceId, args.runtimeId).catch(() => {})
  }
  await rm(args.brokerDir, { recursive: true, force: true }).catch(() => {})
}

function makeLocalHandle(args: {
  sessionId: string
  runtimeId: string
  runtimeServiceId: string
  runHandle: RunHandle
}): SandboxHandle {
  const startedAt = new Date()
  return {
    adapter: "local",
    mode: "resident",
    sandboxId: args.sessionId,
    resourceId: "",
    runtimeLink: {
      mode: "resident",
      runtimeId: args.runtimeId,
      runtimeServiceId: args.runtimeServiceId,
    },
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
        adapter: "local",
        sandboxId: args.sessionId,
        runtimeId: args.runtimeId,
        runtimeServiceId: args.runtimeServiceId,
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
    adapter: "local",
    mode: ref.mode,
    sandboxId: ref.sandboxId,
    resourceId: "",
    runtimeLink: {
      mode: "resident",
      runtimeId: ref.runtimeId,
      runtimeServiceId: ref.runtimeServiceId ?? "",
    },
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
        adapter: "local",
        sandboxId: ref.sandboxId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
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
