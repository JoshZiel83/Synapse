// Sandbox lifecycle — the E2B-SDK-SHAPED contract TYPES (SandboxHandle / SandboxSpec /
// SandboxRef / SandboxInfo / …) shared by every SandboxAdapter, PLUS the LOCAL adapter's
// provision/connect lifecycle functions. We mirror the *shape* of the e2b Sandbox
// class's lifecycle methods (create / connect / kill / getHost / setTimeout /
// isRunning) so an adapter for E2B-cloud / k8s / Firecracker can slot in, but we DO NOT
// import the `e2b` package or call E2B's orchestrator/envd — the contract is internal
// and the reference is `e2b@2.27.0`.
//
// SCOPE: the LIFECYCLE layer only (stand up / tear down a sandbox runtime + expose a
// port). The DATA PLANE (filesystem + commands) stays on Synapse's device-runtime MCP
// builtins reached via the frp tunnel + dispatchSyncTool — it is NOT modeled here.
//
// The lifecycle is implemented per substrate as plain functions the SandboxAdapter
// calls (SandboxAdapter is the SOLE lifecycle abstraction — there is no second wrapper
// interface):
//   - local  → provisionLocalSandbox / connectLocalSandbox below (a same-host child of
//     the two-phase HostProvider).
//   - docker → provisionDockerSandbox / connectDockerSandbox in docker-sandbox.ts (DooD:
//     `docker run`s the cloud-sandbox image + bridges the bootstrap-on-boot handshake).

import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createFileBackedBroker } from "@synapse/device-runtime"
import {
  type HostProvider,
  type RunHandle,
  type SpawnSandboxRuntimeParams,
} from "./host-provider.js"
import { deleteRuntime, mintLocalSandboxRuntime } from "../devices/service.js"

/**
 * Tristate liveness (R3.4). `probeLiveness()` returns this so lifecycle callers
 * can distinguish a CONFIRMED-dead runtime from one they simply could NOT probe:
 *   - 'alive'   — the runtime is definitively running.
 *   - 'dead'    — the runtime is definitively gone (container removed, pid ESRCH,
 *                 or a reused pid whose durable identity no longer matches).
 *   - 'unknown' — the probe itself failed (docker daemon/transport error, a
 *                 non-Linux / /proc-less host, or a NULL persisted pid identity).
 * Irreversible actions (reap / delete tracking / commit-then-delete / signal a
 * pid) are gated on 'dead' ONLY; 'alive' AND 'unknown' both SHIELD (preserve
 * tracking + persisted state) so a transient probe error never destroys a live
 * sandbox or kills a recycled pid.
 */
export type SandboxLiveness = "alive" | "dead" | "unknown"

/**
 * Everything provisionSandbox hands a backend to stand up one sandbox. The
 * backend owns its pairing handshake (local: startPairing+pair; docker:
 * createCloudDevicePairing+bootstrap) — the spine only supplies session-scoped
 * facts and lifecycle callbacks.
 */
export interface SandboxSpecBase {
  /** The Synapse logical sandbox id == sessionId. Also the liveHandles key. */
  sessionId: string
  workspaceId: string
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

/**
 * (R4 §1.10) HOST-backed spec: the runtime runs on the API host (local/docker
 * resident + bare), so it carries the host-facing facts. Flattened at the top
 * level so existing spine + adapter reads (`spec.sandboxRoot`) are unchanged.
 * `offBox` is the discriminant (absent/false ⇒ host).
 */
export interface SandboxHostSpec extends SandboxSpecBase {
  readonly offBox?: false
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
}

/**
 * (R4 §1.10) OFF-BOX spec (cubesandbox): the VM is the store, so NO host path
 * ever reaches it — it carries ONLY the shared core. The spine builds this
 * variant when `adapter.meta.offBox`, making the host-RCE trap (mounting a
 * session root into an off-box adapter) impossible to express.
 */
export interface SandboxOffBoxSpec extends SandboxSpecBase {
  readonly offBox: true
}

/**
 * Everything provisionSandbox hands a backend to stand up one sandbox. A
 * discriminated union: host-backed adapters get the host facts; off-box adapters
 * get the core only. Prefer {@link requireHostSpec} over a `spec.host!` non-null
 * — it narrows to {@link SandboxHostSpec} and fail-closes if an off-box spec
 * reaches a host adapter.
 */
export type SandboxSpec = SandboxHostSpec | SandboxOffBoxSpec

/**
 * Narrow a {@link SandboxSpec} to its host variant for a host-backed adapter.
 * Fail-closed: an off-box spec reaching a host adapter is a wiring bug (the
 * spine only builds the host variant for `!meta.offBox`), so throw rather than
 * read undefined host paths. Closure-safe (returns the narrowed value) so the
 * caller can read `host.sandboxRoot` inside nested callbacks.
 */
export function requireHostSpec(spec: SandboxSpec): SandboxHostSpec {
  if (spec.offBox === true) {
    throw new SandboxAdapterError(
      "host-backed sandbox adapter received an off-box SandboxSpec (no host paths available)"
    )
  }
  return spec
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
  /**
   * Local backend only (R3.6): the durable process-identity token
   * ('<boot_id>:<starttime>' from Linux /proc) captured for hostPid at mint. The
   * cross-process kill path signals hostPid ONLY when the LIVE pid's identity
   * still matches this — so a recycled pid (our child exited, the OS reissued the
   * number to an unrelated process) is never signalled. NULL/absent on a
   * non-Linux host or an unreadable /proc ⇒ identity is 'unknown' ⇒ never signalled.
   */
  hostPidIdentity?: string | null
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

/**
 * (R4 §1.3, 2b) provider data-plane credentials captured at create() for an
 * off-box adapter — the envd/traffic access tokens `control.create()` returns.
 * NULL for adapters with no data-plane secret (local/docker bare, resident) and
 * for the UNAUTHENTICATED local cube (create returns no tokens). Encrypted at
 * mint onto `sandboxes.data_plane_credentials_encrypted` and re-injected
 * (decrypted) on rebuild/reconnect (R4 Phase 1b). BRANDED redacted in memory
 * (see data-plane-credentials.ts#brandRedactedCredentials) so a stray
 * log/serialize can't leak the tokens — never logged, never in provenance.
 */
export interface SandboxDataPlaneCredentials {
  envdAccessToken?: string
  trafficAccessToken?: string
  /** forward-compat: any provider secret bag. */
  extra?: Record<string, string>
}

/**
 * (R4 §1.4c) The NARROW input an `adapter.workingSet(...)` reads — the provider
 * resource id + the token-bearing data-plane credentials. This is the COMPLETE set
 * both impls consume (host adapters read nothing; the off-box adapter reads exactly
 * resourceId + credentials). A full {@link SandboxHandle} is structurally assignable,
 * so the provision path passes its live handle directly; the teardown/recovery path
 * passes `{ resourceId, credentials }` from the SandboxRef + reconnect — no fabricated
 * handle with dead lifecycle stubs.
 */
export interface WorkingSetHandle {
  readonly resourceId: string
  readonly credentials?: SandboxDataPlaneCredentials | null
}

/** A live sandbox handle — mirrors the e2b Sandbox INSTANCE methods we use. */
export interface SandboxHandle {
  readonly adapter: string
  readonly mode: "resident" | "bare"
  /**
   * (R4 §1.3, 2b) provider credentials captured at create, persisted encrypted
   * at mint. null for adapters with no data-plane secret. BRANDED redacted so a
   * `log({handle})` can't leak the tokens (§6.7/3d).
   */
  readonly credentials?: SandboxDataPlaneCredentials | null
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

  /** e2b: isRunning() — liveness probe. DERIVED (`probeLiveness()==='alive'`) so
   *  non-lifecycle callers are unchanged; lifecycle callers use probeLiveness. */
  isRunning(): Promise<boolean>

  /**
   * Tristate liveness probe (R3.4). Distinguishes a CONFIRMED-dead runtime
   * ('dead') from one that could not be probed ('unknown' — a docker
   * daemon/transport error, a non-Linux /proc-less host, or a NULL persisted pid
   * identity). Lifecycle callers reap / delete-tracking / commit-then-delete ONLY
   * on 'dead', and SHIELD (preserve tracking + persisted state) on 'alive' OR
   * 'unknown'.
   */
  probeLiveness(): Promise<SandboxLiveness>

  /** Synapse convenience (not e2b instance method). */
  getInfo(): SandboxInfo

  /** e2b: instance.kill(). Idempotent. local → SIGTERM/SIGKILL; docker → stop+rm. */
  kill(): Promise<void>
}

export class SandboxAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SandboxAdapterError"
  }
}

/** Injectable seams for {@link provisionLocalSandbox} (defaults are the real impls;
 *  a unit test injects a stub mint + a spy failCleanup to assert leak cleanup). */
export interface LocalProvisionDeps {
  hostProvider: HostProvider
  mintRuntime?: typeof mintLocalSandboxRuntime
  failCleanup?: (args: {
    workspaceId: string
    runtimeId: string | null
    brokerDir: string
  }) => Promise<void>
}

/**
 * Local adapter PROVISION (§4.6 direct-mint): stand up a device-less sandbox-kind
 * runtime as a same-host child WITHOUT the pairing-code round-trip. Mints the runtime +
 * service + service key in one DB tx (mintLocalSandboxRuntime), authors the on-disk
 * broker identity the child `synapse-device run` loads, then spawns the daemon (no
 * `pair` child, --tunnel-mode=noop loopback). The API reuses the SAME broker helpers the
 * child reads, so there is zero identity-format drift: device.hello verifies the SERVICE
 * key against runtime_service_keys (the device pubkey never persists — it lives only in
 * the identity file). On any failure after the mint, self-cleans (soft-delete + rm
 * broker dir) then rethrows.
 */
export async function provisionLocalSandbox(
  spec: SandboxSpec,
  deps: LocalProvisionDeps
): Promise<SandboxHandle> {
  const { hostProvider } = deps
  const mintRuntime = deps.mintRuntime ?? mintLocalSandboxRuntime
  const failCleanup = deps.failCleanup ?? defaultLocalFailCleanup
  // Host-backed adapter: narrow to the host spec (fail-closed if an off-box spec ever
  // reaches here) so host-path reads never see undefined.
  const host = requireHostSpec(spec)
  const brokerDir = join(host.sandboxRoot, ".broker")
  const broker = createFileBackedBroker({ brokerDir })
  const serviceKey = await broker.generateKeyPair("service:device_runtime")
  // FRESH UUID per provision (CORRECTION 1) — sessionId would PK-collide with a
  // soft-deleted runtime on re-provision.
  const runtimeId = randomUUID()
  const serviceId = randomUUID()
  const serviceKeyId = randomUUID()
  let mintedRuntimeId: string | null = null
  try {
    // ① atomically mint the device-less sandbox-kind runtime (no pairing round-trip,
    // no devices row).
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
      serverOrigin: host.serverOrigin,
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
      fsRoot: host.sandboxRoot,
      fsHelperPath: host.fsHelperPath,
      serverOrigin: host.serverOrigin,
      enableDelete: host.enableDelete,
      confineCommands: host.confineCommands,
      title: host.title,
    }
    const runHandle = await hostProvider.run(spawnParams)
    return makeLocalHandle({
      sessionId: spec.sessionId,
      runtimeId,
      runtimeServiceId: serviceId,
      runHandle,
    })
  } catch (err) {
    // Self-clean: soft-delete the minted sandbox runtime (keeps children for audit) +
    // remove the broker dir so a re-provision starts clean.
    await failCleanup({
      workspaceId: spec.workspaceId,
      runtimeId: mintedRuntimeId,
      brokerDir,
    }).catch(() => {})
    throw err
  }
}

/**
 * Local adapter CONNECT: re-attach from a persisted SandboxRef for cross-process
 * teardown / crash recovery. There is no live ChildProcess handle — only the host_pid,
 * so kill() falls back to a PID-reuse-safe signal.
 */
export async function connectLocalSandbox(
  ref: SandboxRef
): Promise<SandboxHandle> {
  if (ref.adapter !== "local") {
    throw new SandboxAdapterError(
      `local adapter cannot connect to a ${ref.adapter} sandbox`
    )
  }
  return makeLocalRefHandle(ref)
}

/**
 * Default self-cleanup for a local create() that failed after the mint:
 * soft-delete the sandbox runtime (flips runtimes.deleted_at, keeps children for
 * audit) and remove the broker dir so its identity can't be reused. Best-effort +
 * idempotent. Overridable via provisionLocalSandbox(spec, { failCleanup }).
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
  // Capture the child's durable process identity at spawn (R3.6). This is the
  // SAME token service.ts persists post-create; probeLiveness re-reads /proc and
  // compares so a recycled pid reads as 'dead', not a false 'alive'.
  const pidIdentity = readHostPidIdentity(args.runHandle.pid)
  const probeLiveness = async (): Promise<SandboxLiveness> => {
    if (!isPidAlive(args.runHandle.pid)) return "dead"
    const idv = verifyPidIdentity(args.runHandle.pid, pidIdentity)
    if (idv === "match") return "alive"
    if (idv === "mismatch") return "dead"
    return "unknown"
  }
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
      throw new SandboxAdapterError(
        "getHost: user-port exposure is not configured for the local sandbox backend"
      )
    },
    async setTimeout(): Promise<void> {
      // Local sandboxes have no auto-kill deadline; lifecycle is teardown-driven.
      throw new SandboxAdapterError(
        "setTimeout is not supported by the local sandbox backend"
      )
    },
    probeLiveness,
    async isRunning(): Promise<boolean> {
      return (await probeLiveness()) === "alive"
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
  // R3.6: probe/kill are PID-reuse-safe. probeLiveness returns 'dead' when the pid
  // is gone OR its live identity no longer matches the persisted token; 'unknown'
  // when we cannot verify (non-Linux / NULL token). kill() signals ONLY on a
  // positive identity match — never on 'unknown'/'mismatch'.
  const probeLiveness = async (): Promise<SandboxLiveness> => {
    if (ref.hostPid === undefined) return "dead"
    if (!isPidAlive(ref.hostPid)) return "dead"
    const idv = verifyPidIdentity(ref.hostPid, ref.hostPidIdentity ?? null)
    if (idv === "match") return "alive"
    if (idv === "mismatch") return "dead"
    return "unknown"
  }
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
      throw new SandboxAdapterError(
        "getHost: user-port exposure is not configured for the local sandbox backend"
      )
    },
    async setTimeout(): Promise<void> {
      throw new SandboxAdapterError(
        "setTimeout is not supported by the local sandbox backend"
      )
    },
    probeLiveness,
    async isRunning(): Promise<boolean> {
      return (await probeLiveness()) === "alive"
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
      // NEVER signal a raw persisted pid unless the LIVE process is provably still
      // our child (identity match). A 'mismatch' (pid reused) or 'unknown' (can't
      // verify) must not SIGTERM an unrelated host process.
      if (
        verifyPidIdentity(ref.hostPid, ref.hostPidIdentity ?? null) !== "match"
      )
        return
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

/**
 * Read a durable process-identity token for `pid` (R3.6): `<boot_id>:<starttime>`
 * from Linux /proc. `starttime` (field 22 of /proc/<pid>/stat, in clock ticks
 * since boot) is unique-per-process-lifetime, and `boot_id` distinguishes the
 * same starttime across reboots — so the pair survives a reboot AND a pid recycle.
 * Returns null on a non-Linux host, a missing /proc, or any read error (=> the
 * identity is "unknown", never signalled). The starttime is parsed AFTER the last
 * ')' so a process whose comm contains spaces/parens can't shift the field index.
 */
export function readHostPidIdentity(pid: number): string | null {
  if (process.platform !== "linux") return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const rparen = stat.lastIndexOf(")")
    if (rparen < 0) return null
    // After ") " the fields are: state(3) ppid(4) ... starttime(22). Dropping
    // pid(1)+comm(2) shifts the index by 3, so starttime is index 19.
    const fields = stat
      .slice(rparen + 1)
      .trim()
      .split(/\s+/)
    const starttime = fields[19]
    if (!starttime || !/^\d+$/.test(starttime)) return null
    const bootId = readFileSync(
      "/proc/sys/kernel/random/boot_id",
      "utf8"
    ).trim()
    if (!bootId) return null
    return `${bootId}:${starttime}`
  } catch {
    return null
  }
}

/** The tristate result of comparing a live pid's identity to a persisted token. */
export type PidIdentityResult = "match" | "mismatch" | "unknown"

/**
 * Compare the LIVE identity of `pid` to the `persisted` token (R3.6). Returns
 * 'match' only when both boot_id and starttime are readable and equal;
 * 'mismatch' when they differ (our original process exited — the pid was reused
 * or the box rebooted, so the runtime is definitively DEAD); 'unknown' when the
 * token is NULL, /proc is unreadable, or the host is non-Linux. The kill path
 * signals ONLY on 'match'; the liveness path treats 'mismatch' as dead and
 * 'unknown' as shield.
 */
export function verifyPidIdentity(
  pid: number,
  persisted: string | null
): PidIdentityResult {
  if (!persisted) return "unknown"
  const current = readHostPidIdentity(pid)
  if (current === null) return "unknown"
  return current === persisted ? "match" : "mismatch"
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
