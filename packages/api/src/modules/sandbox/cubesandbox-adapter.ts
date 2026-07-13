// cubesandbox:bare adapter (Mode-B, OFF-BOX — P4b). The FIRST provider-backed bare
// adapter: a genuinely remote sandbox VM reached over the CubeSandbox wire client
// (control plane = E2B-compat REST lifecycle; data plane = envd over CubeProxy).
//
// Structurally modelled on makeDockerBareAdapter, with three off-box differences:
//   1. NO host-mount-dir check at create() — off-box has no host volume; the
//      working set is pushed later by the spine (a separate phase). create() only
//      stands up the VM + mints the runtime + registers a REMOTE data plane.
//   2. confinedFs:'unsupported' (LEXICAL confinement in cubesandbox/data-plane.ts,
//      not host-side realpath) — so the P1.2 host-side guard is satisfied via
//      `rebuildDataPlane` instead of the host-dir materialize/commit-scan seam.
//   3. lifecycle (setTimeout / probeLiveness / kill) rides the control plane, not a
//      host pid / docker CLI. probeLiveness is R3.4-tristate off getInfo.

import { randomUUID } from "node:crypto"
import { config } from "../../config/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { deleteRuntime, mintBareSandboxRuntime } from "../devices/service.js"
import {
  SandboxBackendError,
  type SandboxDataPlaneCredentials,
  type SandboxHandle,
  type SandboxInfo,
  type SandboxLiveness,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"
import {
  registerBareDataPlane,
  unregisterBareDataPlane,
} from "./bare-dispatch.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import {
  buildCubesandboxBareDescriptor,
  type SandboxCapabilityDescriptor,
} from "./model.js"
import type { BareDataPlaneRebuildRow, SandboxDataPlane } from "./data-plane.js"
import { createProductWorkingSetBridge } from "./working-set-bridge.js"
import { sandboxAdapterMetadata } from "./adapter-metadata.js"
import type { SandboxAdapter } from "./adapter-registry.js"
import {
  CubeControlClient,
  CubeEnvdClient,
  type SandboxInfo as CubeSandboxInfo,
} from "./cubesandbox/index.js"
import {
  createRemoteBareDataPlane,
  type RemoteEnvdTransport,
} from "./cubesandbox/data-plane.js"

const log = createLogger("sandbox.cubesandbox")

/** The validated cubesandbox connection facts (config.sandbox.cubesandbox). */
export interface CubesandboxBareOptions {
  apiUrl: string
  proxyUrl: string
  domain: string
  template: string
  vmRoot: string
  envdPort: number
  apiKey?: string
}

/** Build the cubesandbox:bare options from the validated config namespace. */
export function cubesandboxBareOptionsFromEnv(): CubesandboxBareOptions {
  const c = config.sandbox.cubesandbox
  return {
    apiUrl: c.apiUrl,
    proxyUrl: c.proxyUrl,
    domain: c.domain,
    template: c.template,
    vmRoot: c.vmRoot,
    envdPort: c.envdPort,
    apiKey: c.apiKey || undefined,
  }
}

function makeControlClient(opts: CubesandboxBareOptions): CubeControlClient {
  return new CubeControlClient({
    baseUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    defaultDomain: opts.domain,
  })
}

function makeEnvdClient(
  opts: CubesandboxBareOptions,
  sandboxID: string,
  tokens?: { trafficAccessToken?: string; envdAccessToken?: string }
): CubeEnvdClient {
  return new CubeEnvdClient({
    sandboxID,
    proxyBaseUrl: opts.proxyUrl,
    domain: opts.domain,
    envdPort: opts.envdPort,
    trafficAccessToken: tokens?.trafficAccessToken,
    envdAccessToken: tokens?.envdAccessToken,
  })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface MakeCubesandboxBareAdapterDeps {
  /** Force the descriptor (test seam). */
  descriptorOverride?: SandboxCapabilityDescriptor
  /** Inject the mint (test seam). */
  mintRuntime?: typeof mintBareSandboxRuntime
  /** Force the run options (test seam; defaults to cubesandboxBareOptionsFromEnv). */
  optionsOverride?: CubesandboxBareOptions
  /** Inject the control client (test seam). */
  controlClientFactory?: (opts: CubesandboxBareOptions) => CubeControlClient
  /** Inject the envd transport (test seam). */
  envdFactory?: (
    opts: CubesandboxBareOptions,
    sandboxID: string,
    tokens?: { trafficAccessToken?: string; envdAccessToken?: string }
  ) => RemoteEnvdTransport
}

export function makeCubesandboxBareAdapter(
  deps: MakeCubesandboxBareAdapterDeps = {}
): SandboxAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const runOpts = deps.optionsOverride ?? cubesandboxBareOptionsFromEnv()
  const descriptor = deps.descriptorOverride ?? buildCubesandboxBareDescriptor()
  const controlFactory = deps.controlClientFactory ?? makeControlClient
  const envdFactory = deps.envdFactory ?? makeEnvdClient
  const metaEntry = sandboxAdapterMetadata("cubesandbox", "bare")
  if (!metaEntry) {
    throw new SandboxBackendError(
      "no adapter-metadata leaf for 'cubesandbox:bare' (registry/metadata drift)"
    )
  }

  return {
    key: "cubesandbox:bare",
    provider: "cubesandbox",
    mode: "bare",
    catalogSource: "api_authored",
    capabilities: descriptor,
    meta: metaEntry.meta,
    endpoint: metaEntry.endpoint,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // NO host-mount-dir check (off-box has no host volume — the working set is
      // pushed later by the spine). ① stand up the VM via the control plane.
      const control = controlFactory(runOpts)
      const created = await control
        .create({ templateID: runOpts.template })
        .catch((err) => {
          throw new SandboxBackendError(
            `cubesandbox create failed: ${errMessage(err)}`
          )
        })
      const sandboxID = created.sandboxID
      if (!sandboxID) {
        throw new SandboxBackendError(
          "cubesandbox create returned no sandbox id"
        )
      }
      let mintedRuntimeId: string | null = null
      try {
        const runtimeId = randomUUID()
        const serviceId = randomUUID()
        // R3.2 target-confusion binding: the endpoint carries the AUTHORITATIVE
        // sandbox id (== sandboxes.resource_id), never sliced back out of the
        // free-string endpoint on dispatch.
        const dataPlaneEndpoint = `envd:${sandboxID}`
        await mint({
          runtimeId,
          workspaceId: spec.workspaceId,
          sessionId: spec.sessionId,
          serviceId,
          adapter: "cubesandbox",
          dataPlaneEndpoint,
          capabilityDescriptor: descriptor as unknown as Record<
            string,
            unknown
          >,
          exposures: buildBareCoreCatalog(descriptor),
        })
        mintedRuntimeId = runtimeId
        // ② build + register the REMOTE confined plane bound to this sandbox id.
        const envd = envdFactory(runOpts, sandboxID, {
          trafficAccessToken: created.trafficAccessToken,
          envdAccessToken: created.envdAccessToken,
        })
        const plane = createRemoteBareDataPlane({
          sandboxID,
          descriptor,
          vmRoot: runOpts.vmRoot,
          envd,
        })
        registerBareDataPlane(runtimeId, plane)
        // ③ the runtime's DB identity now exists → let the spine back-fill mounts.
        await spec.onRuntimeReady?.(runtimeId)
        return makeCubesandboxBareHandle({
          sessionId: spec.sessionId,
          runtimeId,
          serviceId,
          sandboxID,
          control,
          // R4 Phase 1b: CAPTURE the off-box data-plane tokens on the handle. NOT
          // persisted yet — the encrypted-column write + re-inject-at-rebuild land
          // in a later sub-phase; today the plane above already holds live tokens.
          credentials: {
            envdAccessToken: created.envdAccessToken,
            trafficAccessToken: created.trafficAccessToken,
          },
        })
      } catch (err) {
        // Self-clean on ANY failure: drop the plane, soft-delete the runtime, and
        // kill the VM we stood up (best-effort + idempotent).
        if (mintedRuntimeId) {
          const p = unregisterBareDataPlane(mintedRuntimeId)
          if (p) await p.dispose().catch(() => {})
          await deleteRuntime(spec.workspaceId, mintedRuntimeId).catch(() => {})
        }
        await control.kill(sandboxID).catch(() => {})
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "cubesandbox" || ref.mode !== "bare") {
        throw new SandboxBackendError(
          `cubesandbox:bare adapter cannot connect to a ${ref.adapter}:${ref.mode} sandbox`
        )
      }
      // Pure reconstruction (teardown/liveness). The data plane rebuilds lazily on
      // the next dispatch (bare-dispatch registry miss → rebuildDataPlane).
      return makeCubesandboxBareRefHandle(ref, controlFactory(runOpts))
    },
    // OFF-BOX readiness (§1.5). R4 Phase 1a: return ok immediately to PRESERVE
    // today's api-authored behavior (the catalogSource fork skipped the wait). The
    // control.health() + envd version gate + domain-suffix (SSRF-inversion) check
    // land in a later sub-phase.
    ready: async () => ({ ok: true }),
    // R4 Phase 1c: ALL adapters return the pass-through product bridge for now;
    // the off-box envd DETACHED bridge (delete-aware mirror over the plane's
    // RemoteEnvdTransport) replaces this in a later sub-phase.
    workingSet: () => createProductWorkingSetBridge(),
    // §1.8 seam: reconstruct the REMOTE plane from the PERSISTED row only —
    // resource_id (== sandbox id) + the row's descriptor; deployment-wide
    // connection facts (domain/proxy/vmRoot/port) come from config, never live
    // config for the adapter kind. ASYNC now (§1.2). R4 Phase 1b: still token-less
    // (connect + re-mint envd/traffic tokens land in a later sub-phase).
    async rebuildDataPlane(
      row: BareDataPlaneRebuildRow
    ): Promise<SandboxDataPlane> {
      const sandboxID = row.resourceId ?? ""
      const envd = envdFactory(runOpts, sandboxID)
      return createRemoteBareDataPlane({
        sandboxID,
        descriptor: row.descriptor,
        vmRoot: runOpts.vmRoot,
        envd,
      })
    },
    // R4 Phase 1b: token-bearing off-box reconnect (§6.2). Still token-less — the
    // control.connect + re-mint + re-persist land in a later sub-phase. Uncalled
    // in Phase 1a.
    async reconnectDataPlane(ref: SandboxRef): Promise<{
      plane: SandboxDataPlane
      credentials: SandboxDataPlaneCredentials | null
    }> {
      const sandboxID = ref.resourceId
      const envd = envdFactory(runOpts, sandboxID)
      return {
        plane: createRemoteBareDataPlane({
          sandboxID,
          descriptor,
          vmRoot: runOpts.vmRoot,
          envd,
        }),
        credentials: null,
      }
    },
    // R4 Phase 1d: the control-plane list-by-metadata sweep lands in a later
    // sub-phase; inert for now (the create() TTL is the paid-resource safety net).
    listOrphans: async () => [],
  }
}

function makeCubesandboxBareHandle(args: {
  sessionId: string
  runtimeId: string
  serviceId: string
  sandboxID: string
  control: CubeControlClient
  credentials?: SandboxDataPlaneCredentials | null
}): SandboxHandle {
  const startedAt = new Date()
  return {
    adapter: "cubesandbox",
    mode: "bare",
    sandboxId: args.sessionId,
    resourceId: args.sandboxID,
    // R4 Phase 1b: captured at create, not yet persisted.
    credentials: args.credentials ?? null,
    runtimeLink: {
      mode: "bare",
      runtimeId: args.runtimeId,
      runtimeServiceId: args.serviceId,
      dataPlaneEndpoint: `envd:${args.sandboxID}`,
    },
    getHost(): string {
      throw new SandboxBackendError(
        "getHost is not supported (cubesandbox:bare)"
      )
    },
    async setTimeout(ms: number): Promise<void> {
      await args.control.setTimeout(
        args.sandboxID,
        Math.max(1, Math.ceil(ms / 1000))
      )
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      return probeCubesandboxLiveness(args.control, args.sandboxID)
    },
    async isRunning(): Promise<boolean> {
      return (
        (await probeCubesandboxLiveness(args.control, args.sandboxID)) ===
        "alive"
      )
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "cubesandbox",
        sandboxId: args.sessionId,
        runtimeId: args.runtimeId,
        runtimeServiceId: args.serviceId,
        startedAt,
      }
    },
    async kill(): Promise<void> {
      const p = unregisterBareDataPlane(args.runtimeId)
      if (p) await p.dispose().catch(() => {})
      await args.control.kill(args.sandboxID).catch(() => {})
    },
  }
}

function makeCubesandboxBareRefHandle(
  ref: SandboxRef,
  control: CubeControlClient
): SandboxHandle {
  const sandboxID = ref.resourceId
  return {
    adapter: "cubesandbox",
    mode: "bare",
    sandboxId: ref.sandboxId,
    resourceId: sandboxID,
    runtimeLink: {
      mode: "bare",
      runtimeId: ref.runtimeId,
      runtimeServiceId: ref.runtimeServiceId ?? "",
      dataPlaneEndpoint: `envd:${sandboxID}`,
    },
    getHost(): string {
      throw new SandboxBackendError(
        "getHost is not supported (cubesandbox:bare)"
      )
    },
    async setTimeout(ms: number): Promise<void> {
      await control.setTimeout(sandboxID, Math.max(1, Math.ceil(ms / 1000)))
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      return probeCubesandboxLiveness(control, sandboxID)
    },
    async isRunning(): Promise<boolean> {
      return (await probeCubesandboxLiveness(control, sandboxID)) === "alive"
    },
    getInfo(): SandboxInfo {
      return {
        adapter: "cubesandbox",
        sandboxId: ref.sandboxId,
        runtimeId: ref.runtimeId,
        runtimeServiceId: ref.runtimeServiceId ?? "",
      }
    },
    async kill(): Promise<void> {
      const p = unregisterBareDataPlane(ref.runtimeId)
      if (p) await p.dispose().catch(() => {})
      await control.kill(sandboxID).catch(() => {})
    },
  }
}

/**
 * Map a control-plane getInfo result to R3.4-tristate liveness. A 404/absent
 * sandbox (null) is genuinely gone → 'dead' (the only state irreversible reap is
 * gated on). Otherwise the SandboxState is mapped EXPLICITLY: every live/keep state
 * (running/paused/pausing — a paused OR pausing box is RESUMABLE and must NOT be
 * reaped) → 'alive'; an UNRECOGNIZED future/terminal state → 'unknown' (R3.4
 * shield), NEVER a silent default-to-'alive' that would shield a dead-but-queryable
 * tombstone from GC forever. The switch has no default-to-alive: adding a state to
 * the SandboxState union without teaching it here yields 'unknown', not 'alive'.
 */
export function mapCubeInfoToLiveness(
  info: CubeSandboxInfo | null
): SandboxLiveness {
  if (!info) {
    return "dead"
  }
  switch (info.state) {
    case "running":
    case "paused":
    case "pausing":
      return "alive"
    default:
      return "unknown"
  }
}

/**
 * R3.4-tristate liveness off the control plane. A PRESENT sandbox maps via
 * {@link mapCubeInfoToLiveness} (live/keep state → 'alive'; unrecognized → 'unknown'
 * shield). A gone sandbox (getInfo null on 404) → 'dead'. A transport error (throw)
 * → 'unknown' (shield). Irreversible reap is gated on 'dead' only.
 */
async function probeCubesandboxLiveness(
  control: CubeControlClient,
  sandboxID: string
): Promise<SandboxLiveness> {
  try {
    const info = await control.getInfo(sandboxID)
    return mapCubeInfoToLiveness(info)
  } catch (err) {
    log.debug(
      { sandboxID, err: errMessage(err) },
      "cubesandbox liveness probe failed → unknown (shield)"
    )
    return "unknown"
  }
}
