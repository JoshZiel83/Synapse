// Docker sandbox backend (DooD) — implements the SandboxBackend lifecycle by
// `docker run`-ing the cloud-sandbox image and bridging the bootstrap-on-boot
// handshake (createCloudDevicePairing → container self-registers via
// /api/v1/devices/bootstrap → poll the pairing session until consumed).
//
// The data plane is unchanged: the container's device-runtime opens the frp
// tunnel + dispatches tools over MCP exactly like any cloud device. This file
// only stands the container up and tears it down.
//
// Docker access is via the `docker` CLI (not dockerode): lower dependency
// footprint, a spawnImpl seam for tests, and argv is always an array (never a
// shell string) so untrusted values can't inject.

import { spawn as nodeSpawn } from "node:child_process"
import {
  createCloudDevicePairing,
  type CreateCloudDeviceResult,
} from "../devices/cloud.js"
import { deleteRuntime } from "../devices/service.js"
import {
  getPairingSessionBootstrapState,
  getLatestRuntimeServiceId,
  cancelPendingPairingSession,
} from "./repo.js"
import {
  SandboxBackendError,
  requireHostSpec,
  type SandboxBackend,
  type SandboxHandle,
  type SandboxHostSpec,
  type SandboxInfo,
  type SandboxLiveness,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"

export type SpawnImpl = typeof nodeSpawn

export interface DockerSandboxBackendOptions {
  /** The cloud-sandbox image to run (SANDBOX_DOCKER_IMAGE). */
  image: string
  /** Docker network the sandbox attaches to (SANDBOX_DOCKER_NETWORK).
   *  Should be an internal network reaching only api + tunnel-edge. */
  network: string
  /** Named volume holding the materialized sandbox roots (SANDBOX_DOCKER_STORAGE_VOLUME). */
  storageVolume: string
  /** Internal API origin the container dials back to (SANDBOX_SERVER_ORIGIN, e.g. http://api:3001). */
  serverOrigin: string
  /** Whether to wire the frp tunnel. A docker resident sandbox forces tunnel='frp'
   *  UNCONDITIONALLY (dockerBackendOptionsFromEnv hardcodes 'frp'); there is no
   *  transport control seam. */
  tunnel: "frp" | "none"
  /** frp facts (only used when tunnel==="frp"). */
  tunnelServerAddr?: string
  tunnelServerPort?: string
  tunnelAuthToken?: string
  tunnelVhostHost?: string
  /**
   * API-reachable base URL the container's runtime registers as its internalUrl
   * (must match the server's SYNAPSE_DEVICE_TUNNEL_EDGE_URL origin). When unset
   * the runtime's frp adapter defaults to http://tunnel-edge:8080. Pass this for
   * any non-default edge so registration isn't rejected by the origin check.
   */
  tunnelInternalBaseUrl?: string
  /** Max ms to wait for the container to consume its bootstrap token. */
  bootstrapTimeoutMs?: number
  /** UID to run the container as (must match the API's uid for shared-volume
   *  ownership). Default 0 (root) — the API image runs as root in v1. */
  runAsUid?: number
  /** Test seam. */
  spawnImpl?: SpawnImpl
  /** Test seam: override the pairing-session poller (defaults to a DB poll). */
  pollBootstrapConsumed?: (
    pairingSessionId: string,
    timeoutMs: number
  ) => Promise<{ runtimeId: string; runtimeServiceId: string }>
  /** Test seam: override pairing creation (defaults to the DB-backed
   *  createCloudDevicePairing) so create() is exercisable without a live DB. */
  createPairing?: (input: {
    workspaceId: string
    title: string
    targetRuntimeKind?: "device" | "sandbox"
    adapter?: string
    mode?: "resident" | "bare"
    sessionId?: string
    capabilityDescriptor?: Record<string, unknown>
  }) => Promise<CreateCloudDeviceResult>
  /** Test seam: override the post-failure cleanup (defaults to the DB-backed
   *  {@link defaultDockerFailCleanup}) so the leak-cleanup is assertable in a
   *  unit test without a DB. */
  failCleanup?: (args: {
    workspaceId: string
    containerId: string | null
    pairingSessionId: string | null
    runtimeId: string | null
  }) => Promise<void>
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 500
const STOP_GRACE_S = 5

/** Docker label stamped on every sandbox container, carrying its session id.
 *  Used both to verify ownership before removing a same-name container and to
 *  reap label-only orphans (a container created before its id was persisted). */
export const SANDBOX_SESSION_LABEL = "synapse.sandbox.session"

export function createDockerSandboxBackend(
  opts: DockerSandboxBackendOptions
): SandboxBackend {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  const bootstrapTimeoutMs =
    opts.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS

  const docker = (args: string[]) => runDocker(spawnImpl, args)

  const createPairing = opts.createPairing ?? defaultCreatePairing
  const failCleanup: NonNullable<DockerSandboxBackendOptions["failCleanup"]> =
    opts.failCleanup ?? ((args) => defaultDockerFailCleanup(docker, args))

  return {
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // Track every fact we create so a failure at ANY point (incl. a staged
      // callback throwing) cleans up ALL of them — honoring the SandboxSpec
      // contract: "a callback that throws aborts create() (which then runs its
      // own cleanup)". Without this a mid-create failure leaks the pairing
      // session, the container, and/or the bootstrapped device.
      let pairingSessionId: string | null = null
      let containerId: string | null = null
      let runtimeId: string | null = null
      try {
        // ① mint a one-time bootstrap token + pending runtime id. P2 fork: this
        // pairing mints a device-less kind='sandbox' runtime — the consume tx
        // reads adapter/mode/session_id/capability_descriptor from context.
        let pairing: CreateCloudDeviceResult
        try {
          pairing = await createPairing({
            workspaceId: spec.workspaceId,
            title: spec.title ?? `Sandbox ${spec.sessionId.slice(0, 8)}`,
            targetRuntimeKind: "sandbox",
            adapter: "docker",
            mode: "resident",
            sessionId: spec.sessionId,
            capabilityDescriptor: {},
          })
        } catch (err) {
          throw new SandboxBackendError(
            `createCloudDevicePairing failed: ${errMsg(err)}`
          )
        }
        pairingSessionId = pairing.pairingSessionId

        const containerName = `synapse-sbx-${sanitizeName(spec.sessionId)}`

        // ② best-effort remove a stale same-name container (verify it's ours by
        // the session label before deleting).
        await removeStaleContainer(docker, containerName, spec.sessionId).catch(
          () => {}
        )

        // ③ docker run -d. The CMD overrides the image default with the full
        // `run` command (fs-root etc. are CLI-only flags, not env).
        const runArgs = buildDockerRunArgs({
          opts,
          spec,
          containerName,
          bootstrapToken: pairing.bootstrapToken,
        })

        try {
          const out = await docker(runArgs)
          containerId = out.stdout.trim().split("\n").pop()!.trim()
          if (!containerId) {
            throw new SandboxBackendError("docker run returned no container id")
          }
        } catch (err) {
          throw err instanceof SandboxBackendError
            ? err
            : new SandboxBackendError(`docker run failed: ${errMsg(err)}`)
        }

        // ④ wait for the container to consume its bootstrap token (it self-
        // registers the sandbox runtime on first boot). Surface docker logs on
        // early exit.
        let resolved: { runtimeId: string; runtimeServiceId: string }
        try {
          resolved = await (
            opts.pollBootstrapConsumed ?? defaultPollBootstrapConsumed
          )(pairing.pairingSessionId, bootstrapTimeoutMs)
        } catch (err) {
          const logs = await docker(["logs", "--tail", "50", containerId])
            .then((r) => `${r.stdout}\n${r.stderr}`.trim())
            .catch(() => "(docker logs unavailable)")
          throw new SandboxBackendError(
            `sandbox container did not bootstrap within ${bootstrapTimeoutMs}ms: ${errMsg(err)}\n--- container logs ---\n${logs}`
          )
        }
        runtimeId = resolved.runtimeId
        await spec.onRuntimeReady?.(resolved.runtimeId)

        return makeDockerHandle({
          docker,
          spawnImpl,
          sessionId: spec.sessionId,
          containerId,
          runtimeId: resolved.runtimeId,
          runtimeServiceId: resolved.runtimeServiceId,
          pairingSessionId: pairing.pairingSessionId,
        })
      } catch (err) {
        // Comprehensive self-cleanup of everything created before the failure:
        // the bootstrapped device (cascades its services/exposures/grants), the
        // pending pairing session (so the token can't be reused), and the
        // container. Idempotent + best-effort; the original error is rethrown.
        await failCleanup({
          workspaceId: spec.workspaceId,
          containerId,
          pairingSessionId,
          runtimeId,
        }).catch(() => {})
        throw err
      }
    },

    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "docker") {
        throw new SandboxBackendError(
          `docker backend cannot connect to a ${ref.adapter} sandbox`
        )
      }
      if (!ref.resourceId) {
        throw new SandboxBackendError(
          "docker connect: SandboxRef has no container id (resourceId)"
        )
      }
      return makeDockerHandle({
        docker,
        spawnImpl,
        sessionId: ref.sandboxId,
        containerId: ref.resourceId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
        pairingSessionId: ref.pairingSessionId,
      })
    },
  }
}

/**
 * A CONNECT-ONLY docker backend for teardown / cross-process kill / liveness.
 * Unlike createDockerSandboxBackend it needs NONE of the provision env (image /
 * network / volume / frp token) — connect()/isRunning()/kill() only shell out to
 * `docker inspect|stop|rm` against the persisted container id. This is what
 * teardown + isSandboxRuntimeAlive use so a docker sandbox is still reapable
 * after the API has fallen back to the local backend, disabled sandboxes, or
 * lost its FRP_SHARED_TOKEN — none of which should strand a running container.
 *
 * create() is intentionally unsupported (throws): a reconnect backend never
 * stands a new sandbox up.
 */
export function createDockerReconnectBackend(
  opts: { spawnImpl?: SpawnImpl } = {}
): SandboxBackend {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  const docker = (args: string[]) => runDocker(spawnImpl, args)
  return {
    async create(): Promise<SandboxHandle> {
      throw new SandboxBackendError(
        "createDockerReconnectBackend.create() is unsupported — it is connect-only"
      )
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "docker") {
        throw new SandboxBackendError(
          `docker backend cannot connect to a ${ref.adapter} sandbox`
        )
      }
      if (!ref.resourceId) {
        throw new SandboxBackendError(
          "docker connect: SandboxRef has no container id (resourceId)"
        )
      }
      return makeDockerHandle({
        docker,
        spawnImpl,
        sessionId: ref.sandboxId,
        containerId: ref.resourceId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
        pairingSessionId: ref.pairingSessionId,
      })
    },
  }
}

function buildDockerRunArgs(params: {
  opts: DockerSandboxBackendOptions
  spec: SandboxSpec
  containerName: string
  bootstrapToken: string
}): string[] {
  const { opts, containerName, bootstrapToken } = params
  // A docker resident sandbox is host-backed (volume-subpath mounts). Narrow to
  // the host spec; an off-box spec reaching here is a wiring bug (fail-closed).
  const spec = requireHostSpec(params.spec)
  const env: Record<string, string> = {
    SYNAPSE_SERVER_ORIGIN: opts.serverOrigin,
    SYNAPSE_BOOTSTRAP_TOKEN: bootstrapToken,
    SYNAPSE_DEVICE_CMD_SANDBOX: "1",
    // Network isolation is the container's job (internal network) — so the
    // bwrap jail must NOT --unshare-net (its loopback bring-up fails without
    // CAP_NET_ADMIN).
    SYNAPSE_DEVICE_CMD_SANDBOX_SHARE_NET: "1",
  }
  if (opts.tunnel === "frp") {
    // Explicit mode so the runtime never falls back to none/noop inside the
    // container (where loopback would be useless — the API is off-box).
    env.SYNAPSE_TUNNEL_MODE = "frp"
    env.SYNAPSE_TUNNEL_SERVER_ADDR = opts.tunnelServerAddr ?? "tunnel-edge"
    env.SYNAPSE_TUNNEL_SERVER_PORT = opts.tunnelServerPort ?? "7000"
    if (opts.tunnelAuthToken)
      env.SYNAPSE_TUNNEL_AUTH_TOKEN = opts.tunnelAuthToken
    // The frps Host route matches on vhostHost, and the runtime registers an
    // internalUrl whose origin the server validates against its own
    // SYNAPSE_DEVICE_TUNNEL_EDGE_URL. Both default to the reference tunnel-edge
    // layout; pass non-default values through so a custom edge isn't rejected.
    env.SYNAPSE_TUNNEL_VHOST_HOST = opts.tunnelVhostHost ?? "tunnel-edge"
    if (opts.tunnelInternalBaseUrl)
      env.SYNAPSE_TUNNEL_INTERNAL_BASE_URL = opts.tunnelInternalBaseUrl
  } else {
    // Defensive: the docker backend is selected with tunnel=frp only (enforced
    // by dockerBackendOptionsFromEnv). A 'none' here would boot a container the
    // API can never dispatch to, so refuse rather than ship a dead sandbox.
    throw new SandboxBackendError(
      `docker backend requires tunnel='frp' (got '${opts.tunnel}'); a docker ` +
        `sandbox has no co-located loopback path`
    )
  }

  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${SANDBOX_SESSION_LABEL}=${spec.sessionId}`,
    "--network",
    opts.network,
    // bwrap needs mount + (omitted) userns; AppArmor is the real mount-rslave
    // blocker under Docker, so both seccomp and apparmor must be unconfined,
    // plus CAP_SYS_ADMIN. NET_ADMIN is intentionally NOT added (we shareNet).
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "apparmor=unconfined",
    "--cap-add",
    "SYS_ADMIN",
    "--user",
    String(opts.runAsUid ?? 0),
    // Share only this session's subpath of the storage volume (not the whole
    // store). The subpath is the session root RELATIVE to the volume's mount
    // point inside the API container, computed by the spine from STORAGE_DIR
    // (sandboxVolumeSubpathFor) — NOT hardcoded here, so a deployment whose
    // STORAGE_DIR differs from the volume root still mounts the right dir.
    // volume-subpath needs Docker Engine 26+.
    "--mount",
    `type=volume,src=${opts.storageVolume},dst=/sandbox-root,volume-subpath=${volumeSubpathFor(spec)}`,
  ]
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`)
  }
  args.push(opts.image)
  // CMD: the full `run` invocation (fs-root etc. are CLI-only). entrypoint.sh
  // prepends bootstrap + --broker-dir/--server.
  args.push(
    "run",
    "--fs-root=/sandbox-root",
    "--fs-helper=/opt/synapse-device/sidecars/fs-helper/synapse-device-fs-helper",
    "--fs-enable-write",
    ...(spec.enableDelete === false ? [] : ["--fs-enable-delete"]),
    "--fs-disable-history",
    "--fs-allow-unversioned-write",
    "--cmd-sandbox",
    "--cmd-sandbox-share-net"
  )
  return args
}

/** Poll runtime_pairing_sessions until the container consumes its bootstrap
 *  token, then resolve the created device + device_runtime service ids. */
async function defaultPollBootstrapConsumed(
  pairingSessionId: string,
  timeoutMs: number
): Promise<{ runtimeId: string; runtimeServiceId: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await getPairingSessionBootstrapState(pairingSessionId)
    if (row) {
      const status = row.status as string
      if (status === "consumed" && row.runtimeId) {
        const runtimeServiceId = await getLatestRuntimeServiceId(
          row.runtimeId as string
        )
        if (runtimeServiceId) {
          return {
            runtimeId: row.runtimeId as string,
            runtimeServiceId,
          }
        }
      } else if (
        status === "expired" ||
        status === "cancelled" ||
        status === "rejected"
      ) {
        throw new SandboxBackendError(
          `pairing session ${pairingSessionId} is ${status} (container never bootstrapped)`
        )
      }
    }
    if (Date.now() >= deadline) {
      throw new SandboxBackendError("bootstrap poll timed out")
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/** Default pairing creation: the DB-backed cloud-bootstrap pairing, carrying the
 *  P2 sandbox fork facts so the consume tx mints a device-less sandbox runtime. */
function defaultCreatePairing(input: {
  workspaceId: string
  title: string
  targetRuntimeKind?: "device" | "sandbox"
  adapter?: string
  mode?: "resident" | "bare"
  sessionId?: string
  capabilityDescriptor?: Record<string, unknown>
}): Promise<CreateCloudDeviceResult> {
  return createCloudDevicePairing({
    workspaceId: input.workspaceId,
    title: input.title,
    targetRuntimeKind: input.targetRuntimeKind,
    adapter: input.adapter,
    mode: input.mode,
    sessionId: input.sessionId,
    capabilityDescriptor: input.capabilityDescriptor,
  })
}

async function defaultDockerFailCleanup(
  docker: (a: string[]) => Promise<{ stdout: string; stderr: string }>,
  args: {
    workspaceId: string
    containerId: string | null
    pairingSessionId: string | null
    runtimeId: string | null
  }
): Promise<void> {
  // Order: runtime first (deleteRuntime → softDeleteRuntime just flips
  // runtimes.deleted_at; it does NOT cascade-delete services/exposures/grants,
  // which are kept for audit), then the pairing session, then the container.
  if (args.runtimeId) {
    await deleteRuntime(args.workspaceId, args.runtimeId).catch(() => {})
  }
  // Cancel the (still-pending) pairing session so the token can't be reused. A
  // consumed session already carries its runtime_id FK and is left as-is.
  if (args.pairingSessionId) {
    await cancelPendingPairingSession(args.pairingSessionId).catch(() => {})
  }
  if (args.containerId) {
    await docker(["rm", "-f", args.containerId]).catch(() => {})
  }
}

async function removeStaleContainer(
  docker: (a: string[]) => Promise<{ stdout: string; stderr: string }>,
  containerName: string,
  sessionId: string
): Promise<void> {
  // Only remove if it carries OUR session label (avoid clobbering an unrelated
  // container that happens to share the name).
  const out = await docker([
    "inspect",
    "--format",
    `{{ index .Config.Labels "${SANDBOX_SESSION_LABEL}" }}`,
    containerName,
  ]).catch(() => null)
  if (out && out.stdout.trim() === sessionId) {
    await docker(["rm", "-f", containerName]).catch(() => {})
  }
}

export interface ReapDockerOrphansResult {
  /** session ids of containers we removed. */
  removed: string[]
  /** session ids found running that we kept (had a live mount). */
  kept: string[]
}

/**
 * Reap label-only Docker sandbox orphans: containers stamped with our session
 * label whose session is NOT in `liveSessionIds` (the sessions that still have a
 * recoverable DB mount). This catches the crash window the DB-driven reconciler
 * can't — the API `docker run`s a container, then crashes BEFORE persisting its
 * `sandbox_resource_id`, so teardown can't build a killable ref from file_mounts
 * even though the container is up and labeled.
 *
 * Ownership is proven by the label (set only by this backend). Best-effort: a
 * `docker ps`/`rm` failure is logged via the returned lists, never thrown. The
 * spawn seam keeps it unit-testable without a docker daemon.
 */
export async function reapDockerSandboxOrphans(
  liveSessionIds: Set<string>,
  opts: { spawnImpl?: SpawnImpl } = {}
): Promise<ReapDockerOrphansResult> {
  const docker = (args: string[]) =>
    runDocker(opts.spawnImpl ?? nodeSpawn, args)
  const removed: string[] = []
  const kept: string[] = []
  // List every container (running or stopped) carrying our label, with its
  // session id. `{{.Label "..."}}` formats the label value per container.
  const out = await docker([
    "ps",
    "--all",
    "--filter",
    `label=${SANDBOX_SESSION_LABEL}`,
    "--format",
    `{{.ID}} {{.Label "${SANDBOX_SESSION_LABEL}"}}`,
  ]).catch(() => null)
  if (!out) return { removed, kept }
  for (const line of out.stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sep = trimmed.indexOf(" ")
    if (sep < 0) continue
    const containerId = trimmed.slice(0, sep)
    const sessionId = trimmed.slice(sep + 1).trim()
    if (!sessionId || liveSessionIds.has(sessionId)) {
      if (sessionId) kept.push(sessionId)
      continue
    }
    await docker(["rm", "-f", containerId]).catch(() => {})
    removed.push(sessionId)
  }
  return { removed, kept }
}

function makeDockerHandle(args: {
  docker: (a: string[]) => Promise<{ stdout: string; stderr: string }>
  spawnImpl: SpawnImpl
  sessionId: string
  containerId: string
  runtimeId: string
  runtimeServiceId: string
  pairingSessionId?: string
}): SandboxHandle {
  const startedAt = new Date()
  const probeLiveness = () =>
    probeDockerContainerLiveness(args.spawnImpl, args.containerId)
  return {
    adapter: "docker",
    mode: "resident",
    sandboxId: args.sessionId,
    resourceId: args.containerId,
    runtimeLink: {
      mode: "resident",
      runtimeId: args.runtimeId,
      runtimeServiceId: args.runtimeServiceId,
    },
    pairingSessionId: args.pairingSessionId,
    getHost(): string {
      throw new SandboxBackendError(
        "getHost: user-port exposure is not configured for the docker sandbox backend"
      )
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError(
        "setTimeout is not supported by the docker sandbox backend"
      )
    },
    probeLiveness,
    async isRunning(): Promise<boolean> {
      return (await probeLiveness()) === "alive"
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "docker",
        sandboxId: args.sessionId,
        runtimeId: args.runtimeId,
        runtimeServiceId: args.runtimeServiceId,
        startedAt,
      }
    },
    async kill(): Promise<void> {
      await args
        .docker(["stop", "-t", String(STOP_GRACE_S), args.containerId])
        .catch(() => {})
      await args.docker(["rm", "-f", args.containerId]).catch(() => {})
    },
  }
}

// ─────────────────────────── docker:bare (Mode-B, P4a S10) ───────────────────

export interface BuildBareDockerRunArgsInput {
  opts: {
    /** Stock hardened base image (NO device-runtime/frp/bootstrap/secrets). */
    bareImage: string
    storageVolume: string
    /** uid the container runs as (uid-parity with the API — see config gate). */
    runAsUid?: number
    pidsLimit: number
    memory: string
    /** Opt-in egress network; when empty the container is `--network none`. */
    pureNetwork?: string
  }
  spec: SandboxSpec
  containerName: string
  /**
   * The mount-point subpaths (relative names, e.g. "conversation") that EXIST on
   * the host under the session root. Each is mounted as a SEPARATE volume-subpath
   * at its literal in-container path (/conversation, …). NEVER the whole session
   * root — the host-side `.synapse-internal` staging namespace must never be
   * in-container (a host-side atomicWrite following an agent-planted symlink would
   * be an arbitrary host write). This is the S10 HOST-RCE TRAP defense.
   */
  mountPoints: string[]
}

/**
 * Build the `docker run` argv for a HARDENED bare sandbox container (P4a S10).
 * Inverse of the resident args: default seccomp/AppArmor ON, `--cap-drop ALL`,
 * `--network none`, `--pids-limit`/`--memory`, NO secrets env, `sleep infinity`
 * keepalive. The API never dispatches tools INTO this container over MCP — it
 * `docker exec`s the confined data plane's commands and does fs ops HOST-SIDE.
 */
export function buildBareDockerRunArgs(
  input: BuildBareDockerRunArgsInput
): string[] {
  const { opts, containerName, mountPoints } = input
  // docker:bare is host-backed (volume-subpath mounts of the session root's mount
  // points). Narrow to the host spec (fail-closed on an off-box spec).
  const spec = requireHostSpec(input.spec)
  const subpathRoot = volumeSubpathFor(spec)
  const network = opts.pureNetwork?.trim() || "none"
  const args = [
    "run",
    "-d",
    // PID 1 reaper so a `sleep infinity` keepalive + `docker exec` children are
    // reaped and signals propagate.
    "--init",
    "--name",
    containerName,
    "--label",
    `${SANDBOX_SESSION_LABEL}=${spec.sessionId}`,
    // Hardened network: no egress by default (kernel-level). Opt-in egress only
    // via a DEDICATED network (config-gated, never the compose default/frp net).
    "--network",
    network,
    // Drop ALL capabilities (inverse of resident's --cap-add SYS_ADMIN).
    "--cap-drop",
    "ALL",
    // No privilege escalation. Default seccomp + AppArmor stay ON — we do NOT add
    // seccomp=unconfined / apparmor=unconfined (the resident's mount-rslave needs
    // are absent here: the bare container never runs bwrap).
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(opts.pidsLimit),
    "--memory",
    opts.memory,
    "--user",
    String(opts.runAsUid ?? 0),
  ]
  // Mount ONLY the mount points that exist, each as a separate volume-subpath at
  // its literal in-container path — NEVER the session root (HOST-RCE trap).
  for (const name of mountPoints) {
    args.push(
      "--mount",
      `type=volume,src=${opts.storageVolume},dst=/${name},volume-subpath=${subpathRoot}/${name}`
    )
  }
  // NO `-e` env — a bare container carries no bootstrap token, no frp secrets, no
  // server origin. It is a dumb keepalive the API execs into.
  args.push(opts.bareImage, "sleep", "infinity")
  return args
}

/**
 * Typed error for an externally-removed sandbox container (a `docker rm -f` mid
 * session). `docker exec` on a gone container exits 125 with "No such container";
 * runDockerCapture surfaces this so the dispatch fork can flip the sandbox to
 * state='failed' + preserve any uncommitted work (B13), rather than treating it
 * as an ordinary non-zero command result.
 */
export class SandboxResourceGoneError extends Error {
  readonly code = "resource_gone" as const
  constructor(message: string) {
    super(message)
    this.name = "SandboxResourceGoneError"
  }
}

/**
 * Tristate liveness for a docker container (R3.4), shared by docker:resident and
 * docker:bare. Routed through runDockerCapture (NOT runDocker) so a distinct
 * "no such container/object" maps to 'dead' and any OTHER failure (docker daemon
 * down, transport error, spawn 'error') maps to 'unknown' rather than being
 * collapsed to a false 'dead'/false. Only a container that inspect confirms
 * Running=false, or that docker reports gone, is 'dead' — the sole state on which
 * the lifecycle callers reap/delete-tracking.
 */
export async function probeDockerContainerLiveness(
  spawnImpl: SpawnImpl,
  containerId: string
): Promise<SandboxLiveness> {
  try {
    const out = await runDockerCapture(
      spawnImpl,
      ["inspect", "--format", "{{.State.Running}}", containerId],
      { containerId }
    )
    if (out.code === 0) {
      return out.stdout.trim() === "true" ? "alive" : "dead"
    }
    // Non-zero WITHOUT a resource_gone reject: a removed container makes
    // `docker inspect` exit 1/125 with "No such object/container" — treat that as
    // definitively 'dead'; anything else is an un-interpretable failure ('unknown').
    if (/no such (container|object)/i.test(out.stderr)) return "dead"
    return "unknown"
  } catch (err) {
    // runDockerCapture rejects ONLY on a spawn 'error' or an externally-gone
    // container. Gone ⇒ dead; a transport/daemon error ⇒ unknown (never dead).
    if (err instanceof SandboxResourceGoneError) return "dead"
    return "unknown"
  }
}

export interface DockerCaptureResult {
  /** The wrapped command's exit code (124 = in-container timeout(1) fired). */
  code: number | null
  stdout: string
  stderr: string
  /** Either stream hit maxStreamBytes and was clipped. */
  truncated: boolean
  /** The API-side backstop (T+10s) killed the CLI child + `docker kill`ed. */
  killed: boolean
}

/**
 * Capture-mode docker exec runner (P4a S10). Unlike runDocker, a NON-ZERO exit is
 * a RESULT (a failing user command is not an infrastructure failure) — it rejects
 * ONLY on a spawn 'error' or an externally-gone container (SandboxResourceGoneError,
 * exit 125 + "No such container"). Two-tier timeout: the caller wraps the payload
 * in-container with `timeout(1)`; this adds an API-side BACKSTOP at T+10s that
 * SIGKILLs the CLI child AND `docker kill`s the container (a hung `docker exec`
 * that the in-container timeout can't reach), setting `killed`.
 */
export function runDockerCapture(
  spawnImpl: SpawnImpl,
  args: string[],
  opts: {
    timeoutMs?: number
    maxStreamBytes?: number
    /** Container id for the backstop `docker kill`. */
    containerId?: string
    /** Grace beyond timeoutMs before the API-side backstop fires (default 10s;
     *  test seam so the backstop is exercisable without a 10s wait). */
    backstopGraceMs?: number
  } = {}
): Promise<DockerCaptureResult> {
  const maxBytes = opts.maxStreamBytes ?? 1_000_000
  const backstopMs =
    (opts.timeoutMs ?? 30_000) + (opts.backstopGraceMs ?? 10_000)
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let killed = false
    let settled = false
    const append = (cur: string, chunk: string): string => {
      if (cur.length >= maxBytes) {
        truncated = true
        return cur
      }
      const next = cur + chunk
      if (next.length > maxBytes) {
        truncated = true
        return next.slice(0, maxBytes)
      }
      return next
    }
    child.stdout?.on("data", (d) => {
      stdout = append(stdout, d.toString())
    })
    child.stderr?.on("data", (d) => {
      stderr = append(stderr, d.toString())
    })
    const backstop = setTimeout(() => {
      killed = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      if (opts.containerId) {
        try {
          // Best-effort container kill (separate CLI; ignore its result).
          spawnImpl("docker", ["kill", opts.containerId], {
            stdio: "ignore",
          })
        } catch {
          /* best-effort */
        }
      }
    }, backstopMs)
    backstop.unref?.()
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(backstop)
      reject(err)
    })
    child.on("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(backstop)
      // Externally-removed container ⇒ typed resource_gone (not a command result).
      if (code === 125 && /no such container/i.test(stderr)) {
        reject(
          new SandboxResourceGoneError(
            `sandbox container gone: ${stderr.slice(0, 200)}`
          )
        )
        return
      }
      // A non-zero exit (incl. 124 = in-container timeout) is a RESULT.
      resolvePromise({ code, stdout, stderr, truncated, killed })
    })
  })
}

function runDocker(
  spawnImpl: SpawnImpl,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => reject(err))
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else
        reject(
          new SandboxBackendError(
            `docker ${args[0]} exited ${code}: ${stderr.slice(0, 400)}`
          )
        )
    })
  })
}

/** Resolve the per-session subpath of the storage volume to share into the
 *  container. The spine computes it from STORAGE_DIR (relative to the volume
 *  mount point); we require it rather than re-derive the layout here, and fail
 *  loud if it's missing — mounting the wrong path would silently hide the
 *  materialized files (and could fail `docker run` outright). */
function volumeSubpathFor(spec: SandboxHostSpec): string {
  const subpath = spec.storageVolumeSubpath?.trim()
  if (!subpath) {
    throw new SandboxBackendError(
      `docker backend: spec.storageVolumeSubpath is required (session ${spec.sessionId}) ` +
        `so the volume-subpath mount resolves the materialized sandbox root`
    )
  }
  return subpath
}

function sanitizeName(sessionId: string): string {
  // Docker names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; sessionId is a uuid so it's
  // already safe, but normalize defensively (full id — no short prefix, to
  // avoid collisions).
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
