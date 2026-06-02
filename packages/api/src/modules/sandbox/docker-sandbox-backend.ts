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
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import {
  createCloudDevicePairing,
  type CreateCloudDeviceResult,
} from "../devices/cloud.js"
import {
  SandboxBackendError,
  type SandboxBackend,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"

type SpawnImpl = typeof nodeSpawn

export interface DockerSandboxBackendOptions {
  /** The cloud-sandbox image to run (SYNAPSE_SANDBOX_IMAGE). */
  image: string
  /** Docker network the sandbox attaches to (SYNAPSE_SANDBOX_DOCKER_NETWORK).
   *  Should be an internal network reaching only api + tunnel-edge. */
  network: string
  /** Named volume holding the materialized sandbox roots (SYNAPSE_SANDBOX_STORAGE_VOLUME). */
  storageVolume: string
  /** Internal API origin the container dials back to (SYNAPSE_SANDBOX_SERVER_ORIGIN, e.g. http://api:3001). */
  serverOrigin: string
  /** Whether to wire the frp tunnel (SYNAPSE_SANDBOX_TUNNEL=frp|none). */
  tunnel: "frp" | "none"
  /** frp facts (only used when tunnel==="frp"). */
  tunnelServerAddr?: string
  tunnelServerPort?: string
  tunnelAuthToken?: string
  tunnelVhostHost?: string
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
  ) => Promise<{ deviceId: string; deviceServiceId: string }>
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 500
const STOP_GRACE_S = 5

export function createDockerSandboxBackend(
  opts: DockerSandboxBackendOptions
): SandboxBackend {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn
  const bootstrapTimeoutMs =
    opts.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS

  const docker = (args: string[]) => runDocker(spawnImpl, args)

  return {
    kind: "docker",
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // ① mint a one-time bootstrap token + pending device id.
      let pairing: CreateCloudDeviceResult
      try {
        pairing = await createCloudDevicePairing({
          workspaceId: spec.workspaceId,
          title: spec.title ?? `Sandbox ${spec.sessionId.slice(0, 8)}`,
          hostProvider: "docker",
        })
      } catch (err) {
        throw new SandboxBackendError(
          `createCloudDevicePairing failed: ${errMsg(err)}`
        )
      }
      await spec.onPairingCreated?.(pairing.pairing_session_id)

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
        bootstrapToken: pairing.bootstrap_token,
      })

      let containerId: string
      try {
        const out = await docker(runArgs)
        containerId = out.stdout.trim().split("\n").pop()!.trim()
        if (!containerId) {
          throw new SandboxBackendError("docker run returned no container id")
        }
      } catch (err) {
        await failCleanup(docker, {
          containerName: null,
          pairingSessionId: pairing.pairing_session_id,
          deviceId: null,
        }).catch(() => {})
        throw err instanceof SandboxBackendError
          ? err
          : new SandboxBackendError(`docker run failed: ${errMsg(err)}`)
      }
      await spec.onResourceCreated?.(containerId)

      // ④ wait for the container to consume its bootstrap token (it self-
      // registers the device on first boot). Surface docker logs on early exit.
      let resolved: { deviceId: string; deviceServiceId: string }
      try {
        resolved = await (
          opts.pollBootstrapConsumed ?? defaultPollBootstrapConsumed
        )(pairing.pairing_session_id, bootstrapTimeoutMs)
      } catch (err) {
        const logs = await docker(["logs", "--tail", "50", containerId])
          .then((r) => `${r.stdout}\n${r.stderr}`.trim())
          .catch(() => "(docker logs unavailable)")
        await failCleanup(docker, {
          containerName: containerId,
          pairingSessionId: pairing.pairing_session_id,
          deviceId: null,
        }).catch(() => {})
        throw new SandboxBackendError(
          `sandbox container did not bootstrap within ${bootstrapTimeoutMs}ms: ${errMsg(err)}\n--- container logs ---\n${logs}`
        )
      }
      await spec.onDeviceClaimed?.(resolved.deviceId)

      return makeDockerHandle({
        docker,
        sessionId: spec.sessionId,
        containerId,
        deviceId: resolved.deviceId,
        deviceServiceId: resolved.deviceServiceId,
        pairingSessionId: pairing.pairing_session_id,
      })
    },

    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.backend !== "docker") {
        throw new SandboxBackendError(
          `docker backend cannot connect to a ${ref.backend} sandbox`
        )
      }
      if (!ref.sandboxResourceId) {
        throw new SandboxBackendError(
          "docker connect: SandboxRef has no container id (sandboxResourceId)"
        )
      }
      return makeDockerHandle({
        docker,
        sessionId: ref.sandboxId,
        containerId: ref.sandboxResourceId,
        deviceId: ref.deviceId,
        deviceServiceId: ref.deviceServiceId ?? "",
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
    env.SYNAPSE_TUNNEL_SERVER_ADDR = opts.tunnelServerAddr ?? "tunnel-edge"
    env.SYNAPSE_TUNNEL_SERVER_PORT = opts.tunnelServerPort ?? "7000"
    if (opts.tunnelAuthToken)
      env.SYNAPSE_TUNNEL_AUTH_TOKEN = opts.tunnelAuthToken
    // The handle internalUrl is hardcoded to tunnel-edge:8080, so the vhost
    // host must be tunnel-edge for frps Host-routing to match.
    env.SYNAPSE_TUNNEL_VHOST_HOST = opts.tunnelVhostHost ?? "tunnel-edge"
  }

  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `synapse.sandbox.session=${spec.sessionId}`,
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
    // store). volume-subpath needs Docker Engine 26+.
    "--mount",
    `type=volume,src=${opts.storageVolume},dst=/sandbox-root,volume-subpath=sandboxes/${spec.sessionId}`,
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

/** Poll device_pairing_sessions until the container consumes its bootstrap
 *  token, then resolve the created device + device_runtime service ids. */
async function defaultPollBootstrapConsumed(
  pairingSessionId: string,
  timeoutMs: number
): Promise<{ deviceId: string; deviceServiceId: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await db
      .selectFrom("device_pairing_sessions")
      .select(["status", "device_id"])
      .where("id", "=", pairingSessionId)
      .executeTakeFirst()
    if (row) {
      const status = row.status as string
      if (status === "consumed" && row.device_id) {
        const svc = await db
          .selectFrom("device_services")
          .select("id")
          .where("device_id", "=", row.device_id as string)
          .where("service_kind", "=", "device_runtime")
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst()
        if (svc) {
          return {
            deviceId: row.device_id as string,
            deviceServiceId: svc.id as string,
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

async function failCleanup(
  docker: (a: string[]) => Promise<{ stdout: string; stderr: string }>,
  args: {
    containerName: string | null
    pairingSessionId: string
    deviceId: string | null
  }
): Promise<void> {
  // Cancel the (unconsumed) pairing session so the token can't be reused.
  await db
    .updateTable("device_pairing_sessions")
    .set({ status: "cancelled", updated_at: sql`NOW()` } as never)
    .where("id", "=", args.pairingSessionId)
    .where("status", "=", "pending")
    .execute()
    .catch(() => {})
  if (args.containerName) {
    await docker(["rm", "-f", args.containerName]).catch(() => {})
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
    '{{ index .Config.Labels "synapse.sandbox.session" }}',
    containerName,
  ]).catch(() => null)
  if (out && out.stdout.trim() === sessionId) {
    await docker(["rm", "-f", containerName]).catch(() => {})
  }
}

function makeDockerHandle(args: {
  docker: (a: string[]) => Promise<{ stdout: string; stderr: string }>
  sessionId: string
  containerId: string
  deviceId: string
  deviceServiceId: string
  pairingSessionId?: string
}): SandboxHandle {
  const startedAt = new Date()
  return {
    backend: "docker",
    sandboxId: args.sessionId,
    sandboxResourceId: args.containerId,
    deviceId: args.deviceId,
    deviceServiceId: args.deviceServiceId,
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
        backend: "docker",
        sandboxId: args.sessionId,
        deviceId: args.deviceId,
        deviceServiceId: args.deviceServiceId,
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
