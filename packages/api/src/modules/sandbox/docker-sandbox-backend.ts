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
import { deleteDevice } from "../devices/service.js"
import {
  getPairingSessionBootstrapState,
  getLatestRuntimeServiceId,
  cancelPendingPairingSession,
} from "./repo.js"
import {
  SandboxBackendError,
  type SandboxBackend,
  type SandboxHandle,
  type SandboxInfo,
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
  /** Whether to wire the frp tunnel (SYNAPSE_SANDBOX_TUNNEL=frp|none). */
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
  ) => Promise<{ deviceId: string; runtimeServiceId: string }>
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
    deviceId: string | null
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
    kind: "docker",
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // Track every fact we create so a failure at ANY point (incl. a staged
      // callback throwing) cleans up ALL of them — honoring the SandboxSpec
      // contract: "a callback that throws aborts create() (which then runs its
      // own cleanup)". Without this a mid-create failure leaks the pairing
      // session, the container, and/or the bootstrapped device.
      let pairingSessionId: string | null = null
      let containerId: string | null = null
      let deviceId: string | null = null
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
        await spec.onPairingCreated?.(pairing.pairingSessionId)

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
        await spec.onResourceCreated?.(containerId)

        // ④ wait for the container to consume its bootstrap token (it self-
        // registers the device on first boot). Surface docker logs on early exit.
        let resolved: { deviceId: string; runtimeServiceId: string }
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
        deviceId = resolved.deviceId
        await spec.onRuntimeReady?.(resolved.deviceId)

        return makeDockerHandle({
          docker,
          sessionId: spec.sessionId,
          containerId,
          runtimeId: resolved.deviceId,
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
          deviceId,
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
    kind: "docker",
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
  const { opts, spec, containerName, bootstrapToken } = params
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
): Promise<{ deviceId: string; runtimeServiceId: string }> {
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
            deviceId: row.runtimeId as string,
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
    deviceId: string | null
  }
): Promise<void> {
  // Order: device first (a consumed pairing session has device_id set with ON
  // DELETE SET NULL, and deleting the device cascades its services/exposures/
  // grants), then the pairing session, then the container.
  if (args.deviceId) {
    await deleteDevice(args.workspaceId, args.deviceId).catch(() => {})
  }
  // Cancel the (still-pending) pairing session so the token can't be reused. A
  // consumed session is left as-is (the device delete already handled its FK).
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
  sessionId: string
  containerId: string
  runtimeId: string
  runtimeServiceId: string
  pairingSessionId?: string
}): SandboxHandle {
  const startedAt = new Date()
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
    async isRunning(): Promise<boolean> {
      const out = await args
        .docker(["inspect", "--format", "{{.State.Running}}", args.containerId])
        .catch(() => null)
      return out?.stdout.trim() === "true"
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
function volumeSubpathFor(spec: SandboxSpec): string {
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
