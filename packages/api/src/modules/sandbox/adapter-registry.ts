// Sandbox ADAPTER registry (§4.1 / §4.7.2). The SandboxAdapter is the SOLE lifecycle
// abstraction — it carries create/connect directly (there is no second wrapper
// interface). An adapter is keyed `${provider}:${mode}` and carries the metadata the
// provision spine forks on (capabilities, kind) plus the lifecycle
// (create/connect). The bare data plane is rebuilt lazily by bare-dispatch on a
// registry miss (adapter-bound endpoint scheme, P1.3); it is NOT carried on the
// adapter (the dead `dataPlane?()` method was removed in P1.2). Every BARE adapter
// declares the two dispatch seams — adapter.rebuildDataPlane (rebuild-on-miss) + a
// non-null endpoint contract (R3.2 scheme/identity) — COMPILE-enforced by the
// HostBareAdapter/OffBoxBareAdapter interfaces + the ADAPTER_FACTORIES mapped type (R9),
// not a runtime test. R4 INVERTED the old host-side-only rule: an off-box adapter
// (cubesandbox:bare, confinedFs:'unsupported') is now first-class, carrying the off-box
// working-set + orphan seams instead of a host-dir materialize.
//
// F-A (preserved): a docker adapter's teardown/liveness/reconnect NEVER forces the
// provision config to evaluate. `create()` (provision) calls
// provisionDockerSandbox(dockerSandboxOptionsFromEnv()) with the env read LAZILY only
// when create() is actually invoked; `connect()` (teardown/liveness/reconnect) calls the
// env-free connectDockerSandbox (it takes no provision options at all). So a docker
// sandbox stays reapable after a fallback to local / SANDBOX_PROVIDER=none / a lost
// FRP_SHARED_TOKEN. adapterForRow ALWAYS resolves from the persisted row, never current
// config (inv-45).

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
  provisionLocalSandbox,
  connectLocalSandbox,
  requireHostSpec,
  SandboxAdapterError,
  type SandboxDataPlaneCredentials,
  type SandboxHandle,
  type WorkingSetHandle,
  type SandboxInfo,
  type SandboxLiveness,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-lifecycle.js"
import {
  provisionDockerSandbox,
  connectDockerSandbox,
  buildBareDockerRunArgs,
  runDockerCapture,
  probeDockerContainerLiveness,
  SANDBOX_SESSION_LABEL,
  type DockerSandboxOptions,
  type SpawnImpl,
} from "./docker-sandbox.js"
import { createLocalHostProvider, type HostProvider } from "./host-provider.js"
import {
  createLocalBareDataPlane,
  createDockerBareDataPlane,
  type SandboxDataPlane,
  type BareDataPlaneRebuildRow,
  type WorkingSetBridge,
  type OffBoxWorkingSetBridge,
} from "./data-plane.js"
import { createProductWorkingSetBridge } from "./working-set-bridge.js"
import type { Executor } from "./repo.js"
import { makeCubesandboxBareAdapter } from "./cubesandbox-adapter.js"
import {
  registerBareDataPlane,
  unregisterBareDataPlane,
  getLiveBareDataPlane,
  sandboxRootForSession,
} from "./bare-dispatch.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import {
  sandboxAdapterMetadata,
  isRegisteredSandboxAdapterKey,
  type SandboxAdapterMeta,
  type AdapterEndpointContract,
  type SandboxAdapterKey,
  type KindForKey,
} from "./adapter-metadata.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

const log = createLogger("sandbox.adapter-registry")

/** (R4 §1.1 2d/2e) readiness + negotiated provider facts, surfaced to the spine. */
export interface ReadinessReport {
  ok: boolean
  /** e.g. "envd_version_below_min", "unreachable". */
  reason?: string
  /** (2e) off-box negotiation results surfaced by the off-box ready(): the VM's envd
   *  version + its vhost domain (the cube adapter sets both on a successful probe). */
  envdVersion?: string
  domain?: string
}

/** (R4 §1.1 2f) one provider resource the reconciler may DELETE if untracked. */
export interface OrphanResource {
  resourceId: string
}

/**
 * (R4 §1.5) Injected into the RESIDENT adapters so their `ready()` can wait for
 * the control-plane catalog + tunnel endpoint WITHOUT adapter-registry importing
 * sandbox/service.ts (which would form a module cycle). The spine passes its own
 * waitForCatalog/waitForTunnelEndpoint when resolving the provision adapter.
 */
export interface ResidentReadinessWaiters {
  waitForCatalog(
    runtimeId: string,
    opts: { timeoutMs: number; pollMs?: number }
  ): Promise<void>
  waitForTunnelEndpoint(
    runtimeServiceId: string,
    opts: { timeoutMs: number; pollMs?: number }
  ): Promise<void>
}

/** The two PROVIDER-NEUTRAL readiness budgets the spine passes to `ready()` (§6.9); each
 *  variant interprets them for its own substrate. */
export interface AdapterReadyOptions {
  /** primary readiness budget — resident: the control-plane catalog wait; off-box: unused. */
  primaryTimeoutMs: number
  /** reachability-probe budget — resident: the tunnel-endpoint wait; off-box: the envd
   *  reachability probe. `<= 0` opts out of the probe (test seam). */
  reachabilityProbeTimeoutMs: number
}

/** (§6.2) options threaded into the token-bearing reconnect seam. */
export interface SandboxReconnectOptions {
  /** Executor for the FRESH-token re-persist (skipped when absent). */
  executor?: Executor
  /**
   * The persisted decrypted creds to FALL BACK to when connect does not re-mint
   * (the local unauthenticated cube returns no tokens). The caller (teardown /
   * recovery) already decrypted the row, so it supplies them here.
   */
  persistedCredentials?: SandboxDataPlaneCredentials | null
  /** Workspace id for the re-persist AAD (SandboxRef carries no workspace id). */
  workspaceId?: string
}

/**
 * (#13) The SandboxAdapter DISCRIMINATED UNION. `kind` is the discriminant, and each
 * variant declares ONLY the lifecycle methods it implements — so the compiler enforces
 * the per-substrate method set (a value with kind:"offBoxBare" CANNOT exist without the
 * off-box methods, which is what makes {@link isOffBoxAdapter} sound). The `kind`
 * literals mirror the SINGLE-source metadata table (SANDBOX_ADAPTER_METADATA); the
 * ADAPTER_FACTORIES mapped type (AdapterForKey<K>) pins every factory's kind to its
 * table entry AT COMPILE TIME (no runtime kind-invariant test needed).
 *   - 'resident'   → Mode-A (local/docker resident); no bare data plane, no orphans.
 *   - 'hostBare'   → Mode-B on THIS host (local/docker bare); a rebuildable plane +
 *                    reconnect (host mints no token), but no provider resources to reap.
 *   - 'offBoxBare' → a remote-VM provider (cubesandbox); the FULL off-box lifecycle
 *                    (token-bearing reconnect + orphan sweep + keepalive).
 */
interface AdapterBase {
  readonly key: string
  readonly provider: string
  /** (2h) adapter-declared metadata (config-free leaf). `meta.tag` (== provider) is the
   *  sole persisted adapter tag (written to sandboxes.adapter). */
  readonly meta: SandboxAdapterMeta
  create(spec: SandboxSpec): Promise<SandboxHandle>
  connect(ref: SandboxRef): Promise<SandboxHandle>
  /** (2a/2d) readiness/negotiation BEFORE the active-flip. On `{ ok:false }` the spine
   *  fails provision (the catch tears the half-built sandbox down). */
  ready(
    handle: SandboxHandle,
    opts: AdapterReadyOptions
  ): Promise<ReadinessReport>
}

/** Mode-A resident adapter (local/docker): CAS-materialized on the host, no bare data
 *  plane, no provider resources. */
export interface ResidentAdapter extends AdapterBase {
  readonly kind: "resident"
  readonly mode: "resident"
  readonly capabilities: null
  readonly endpoint: null
  workingSet(handle: WorkingSetHandle): WorkingSetBridge
}

/** Mode-B HOST bare adapter (local:bare / docker:bare): a rebuildable host data plane +
 *  a reconnect that wraps the existing plane (NO data-plane secret → credentials: null);
 *  its resources live on THIS host, so there is nothing for a provider orphan sweep. */
export interface HostBareAdapter extends AdapterBase {
  readonly kind: "hostBare"
  readonly mode: "bare"
  readonly capabilities: SandboxCapabilityDescriptor
  readonly endpoint: AdapterEndpointContract
  workingSet(handle: WorkingSetHandle): WorkingSetBridge
  /** (§1.8) rebuild the host bare plane (local in-process / docker-exec) from a row. */
  rebuildDataPlane(row: BareDataPlaneRebuildRow): Promise<SandboxDataPlane>
  /** (§6.2) host reconnect wraps the existing plane — no token to mint. */
  reconnectDataPlane(
    ref: SandboxRef,
    opts?: SandboxReconnectOptions
  ): Promise<{ plane: SandboxDataPlane; credentials: null }>
}

/** OFF-BOX bare adapter (cubesandbox): a remote VM is the store, so it carries the FULL
 *  off-box lifecycle — token-bearing reconnect, the pull-required working-set bridge, and
 *  the provider orphan sweep + TTL keepalive. */
export interface OffBoxBareAdapter extends AdapterBase {
  readonly kind: "offBoxBare"
  readonly mode: "bare"
  readonly capabilities: SandboxCapabilityDescriptor
  readonly endpoint: AdapterEndpointContract
  /** (R6 #6) the off-box bridge where `pull` is REQUIRED (teardown/recovery call it
   *  unconditionally + branch on the PullOutcome). */
  workingSet(handle: WorkingSetHandle): OffBoxWorkingSetBridge
  rebuildDataPlane(row: BareDataPlaneRebuildRow): Promise<SandboxDataPlane>
  /** (§6.2) token-bearing reconnect: control.connect → prefer a FRESH re-minted token,
   *  else the persisted decrypted creds → a token-bearing remote plane. */
  reconnectDataPlane(
    ref: SandboxRef,
    opts?: SandboxReconnectOptions
  ): Promise<{
    plane: SandboxDataPlane
    credentials: SandboxDataPlaneCredentials | null
  }>
  /** (2f) enumerate provider VMs tagged ours but not in the live set → reconciler DELETEs. */
  listOrphans(opts: {
    activeResourceIds: ReadonlySet<string>
    /** Never report a resource younger than this (its mint may be in flight). */
    minAgeMs?: number
  }): Promise<OrphanResource[]>
  destroyResource(resourceId: string): Promise<void>
  /** (2f keepalive) push a non-terminal VM's hard provider TTL forward so an active
   *  session's VM never self-destructs mid-session. */
  refreshResourceDeadline(resourceId: string): Promise<void>
}

export type SandboxAdapter =
  | ResidentAdapter
  | HostBareAdapter
  | OffBoxBareAdapter
/** The two BARE variants (host + off-box): both carry a rebuildable data plane + a
 *  non-null endpoint (bare-dispatch's rebuild-on-miss narrows to this). */
export type BareAdapter = HostBareAdapter | OffBoxBareAdapter

/** The exact SandboxAdapter variant a given registered key K must produce — the union
 *  member whose `kind` is the key's leaf kind (KindForKey<K>). ADAPTER_FACTORIES keys off
 *  this so a factory returning the wrong variant is a COMPILE error (closes over any
 *  future kind automatically — no hand-maintained per-kind branch). */
export type AdapterForKey<K extends SandboxAdapterKey> = Extract<
  SandboxAdapter,
  { kind: KindForKey<K> }
>

/** (#13) Narrow a SandboxAdapter to its OFF-BOX variant on the discriminant. SOUND: the
 *  only union member with kind 'offBoxBare' is OffBoxBareAdapter, which DECLARES every
 *  off-box method — so teardown/recovery/reap/keepalive call reconnectDataPlane /
 *  rebuildDataPlane / listOrphans / destroyResource / refreshResourceDeadline with no `!`
 *  and no runtime truthiness guard, and the compiler guarantees they exist. */
export function isOffBoxAdapter(
  adapter: SandboxAdapter
): adapter is OffBoxBareAdapter {
  return adapter.kind === "offBoxBare"
}

/** Narrow to a BARE adapter (host or off-box) — the variants that carry rebuildDataPlane
 *  + reconnectDataPlane + a non-null endpoint (used by bare-dispatch's rebuild-on-miss). */
export function isBareAdapter(adapter: SandboxAdapter): adapter is BareAdapter {
  return adapter.kind !== "resident"
}

/**
 * Fetch the metadata leaf's `meta` for a RESIDENT adapter (registration invariant: every
 * factory key is in the leaf table). Throws on a drift so a mis-registered adapter fails
 * loud at construction, not silently at dispatch.
 */
function residentMetaFor(provider: string): { meta: SandboxAdapterMeta } {
  const entry = sandboxAdapterMetadata(provider, "resident")
  if (!entry) {
    throw new SandboxAdapterError(
      `no adapter-metadata leaf for '${provider}:resident' (registry/metadata drift)`
    )
  }
  return { meta: entry.meta }
}

/**
 * Fetch the metadata leaf's `meta` + NON-NULL `endpoint` for a BARE adapter (host or
 * off-box). A bare leaf always carries an endpoint scheme; a null one is a registration
 * bug → throw loud.
 */
export function bareMetaFor(provider: string): {
  meta: SandboxAdapterMeta
  endpoint: AdapterEndpointContract
} {
  const entry = sandboxAdapterMetadata(provider, "bare")
  if (!entry || !entry.endpoint) {
    throw new SandboxAdapterError(
      `no bare adapter-metadata leaf (with endpoint) for '${provider}:bare' (registry/metadata drift)`
    )
  }
  return { meta: entry.meta, endpoint: entry.endpoint }
}

/** Build the docker backend options from the validated config.sandbox namespace.
 *  (Relocated from service.ts so the registry can build the LAZY provision backend
 *  without a value cycle. Consumed HERE only — the docker:resident factory below;
 *  service.ts no longer imports it.) */
export function dockerSandboxOptionsFromEnv(): DockerSandboxOptions {
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

/** (§1.5) resident readiness: the catalog + tunnel wait moved OFF the spine's
 *  catalogSource fork INTO `ready()`. The waiters are injected (see
 *  ResidentReadinessWaiters) so no adapter-registry→service cycle forms. When no
 *  waiters are injected (a teardown-resolved adapter, which never calls ready),
 *  ready is a no-op ok — preserving today's behavior exactly. */
async function residentReady(
  waiters: ResidentReadinessWaiters | undefined,
  handle: SandboxHandle,
  opts: AdapterReadyOptions
): Promise<ReadinessReport> {
  if (!waiters) return { ok: true }
  await waiters.waitForCatalog(handle.runtimeLink.runtimeId, {
    timeoutMs: opts.primaryTimeoutMs,
  })
  if (opts.reachabilityProbeTimeoutMs > 0) {
    await waiters.waitForTunnelEndpoint(handle.runtimeLink.runtimeServiceId, {
      timeoutMs: opts.reachabilityProbeTimeoutMs,
    })
  }
  return { ok: true }
}

function makeLocalResidentAdapter(deps?: {
  hostProvider?: HostProvider
  readiness?: ResidentReadinessWaiters
}): ResidentAdapter {
  const hostProvider = deps?.hostProvider ?? createLocalHostProvider()
  const { meta } = residentMetaFor("local")
  return {
    key: "local:resident",
    provider: "local",
    mode: "resident",
    kind: "resident",
    capabilities: null,
    meta,
    endpoint: null,
    create: (spec) => provisionLocalSandbox(spec, { hostProvider }),
    connect: (ref) => connectLocalSandbox(ref),
    ready: (handle, opts) => residentReady(deps?.readiness, handle, opts),
    // resident sandboxes are CAS-materialized on the host; the product bridge is the
    // pass-through spine primitive.
    workingSet: () => createProductWorkingSetBridge(),
  }
}

function makeDockerResidentAdapter(deps?: {
  dockerSpawnImpl?: SpawnImpl
  readiness?: ResidentReadinessWaiters
}): ResidentAdapter {
  // F-A: connect (teardown/liveness/reconnect) is ENV-FREE — connectDockerSandbox
  // takes only the spawnImpl seam, no provision env; create (provision) reads
  // dockerSandboxOptionsFromEnv() LAZILY, ONLY when invoked. The teardown path never
  // touches the provision env.
  const { meta } = residentMetaFor("docker")
  return {
    key: "docker:resident",
    provider: "docker",
    mode: "resident",
    kind: "resident",
    capabilities: null,
    meta,
    endpoint: null,
    create: (spec) =>
      provisionDockerSandbox(spec, dockerSandboxOptionsFromEnv()),
    connect: (ref) =>
      connectDockerSandbox(ref, { spawnImpl: deps?.dockerSpawnImpl }),
    ready: (handle, opts) => residentReady(deps?.readiness, handle, opts),
    workingSet: () => createProductWorkingSetBridge(),
    // The docker label reaper (reapDockerSandboxOrphans) runs in the reconcile spine;
    // docker does not use the adapter listOrphans path (that is the off-box seam).
  }
}

// ─────────────────────────── local:bare adapter (Mode-B) ─────────────────────

const LOCAL_BARE_CAPS = {
  maxReadBytes: 10 * 1024 * 1024,
  maxWriteBytes: 50 * 1024 * 1024,
  maxConcurrentExec: 4,
} as const

/** Host-probe the local:bare descriptor at create(): isolation (bwrap) + search
 *  (ripgrep). isolation:null ⇒ no commandline exposure/grant and the plane's exec
 *  fail-closes (three fail-closed layers). */
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
): HostBareAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const descriptor = deps.descriptorOverride ?? buildLocalBareDescriptor()
  const { meta, endpoint } = bareMetaFor("local")
  return {
    key: "local:bare",
    provider: "local",
    mode: "bare",
    kind: "hostBare",
    capabilities: descriptor,
    meta,
    endpoint,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // local:bare is host-backed (in-process plane over the session root).
      const host = requireHostSpec(spec)
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
          workspaceId: host.workspaceId,
          sessionId: host.sessionId,
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
          sandboxRoot: host.sandboxRoot,
          descriptor,
        })
        registerBareDataPlane(runtimeId, plane)
        // ③ the runtime's DB identity now exists → let the spine back-fill mounts.
        await host.onRuntimeReady?.(runtimeId)
        return makeLocalBareHandle({
          sessionId: host.sessionId,
          runtimeId,
          serviceId,
          dataPlaneEndpoint,
        })
      } catch (err) {
        if (minted) {
          const p = unregisterBareDataPlane(runtimeId)
          if (p) await p.dispose().catch(() => {})
          await deleteRuntime(host.workspaceId, runtimeId).catch(() => {})
        }
        throw err
      }
    },
    async connect(ref: SandboxRef): Promise<SandboxHandle> {
      if (ref.adapter !== "local" || ref.mode !== "bare") {
        throw new SandboxAdapterError(
          `local:bare adapter cannot connect to a ${ref.adapter}:${ref.mode} sandbox`
        )
      }
      // Pure reconstruction (teardown/liveness). The plane is rebuilt lazily on
      // the next dispatch (bare-dispatch registry miss); this handle only needs
      // to drain any LIVE plane on kill().
      return makeLocalBareRefHandle(ref)
    },
    // Bare (host) → catalog is authored synchronously in create()'s mint tx and
    // there is NO tunnel endpoint to register, so ready is immediate. Same
    // behavior as the old catalogSource==='api_authored' skip.
    ready: async () => ({ ok: true }),
    workingSet: () => createProductWorkingSetBridge(),
    // §1.8: the host scheme fork moved OFF the spine INTO the adapter — wrap
    // createLocalBareDataPlane, using the row-authoritative descriptor + root.
    rebuildDataPlane: async (row: BareDataPlaneRebuildRow) =>
      createLocalBareDataPlane({
        sandboxRoot: row.sandboxRoot,
        descriptor: row.descriptor,
      }),
    // Host wraps the existing in-process plane (no data-plane secret). Only the
    // OFF-BOX reconnect path actually invokes reconnectDataPlane; host adapters expose
    // it for symmetry.
    reconnectDataPlane: async (ref) => ({
      plane: createLocalBareDataPlane({
        sandboxRoot: sandboxRootForSession(ref.sandboxId),
        descriptor,
      }),
      credentials: null,
    }),
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
      throw new SandboxAdapterError(
        "getHost: user-port exposure is not configured for the local:bare sandbox adapter"
      )
    },
    async setTimeout(): Promise<void> {
      throw new SandboxAdapterError(
        "setTimeout is not supported by the local:bare sandbox adapter"
      )
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      // In-process liveness is DEFINITIVE (no transport hop can fail): the plane
      // lives in THIS process's memory, so registered ⇒ 'alive', absent ⇒ 'dead'
      // (nothing live here to kill; a lazy rebuild re-creates it on next dispatch).
      // There is no 'unknown' for an in-process check.
      return getLiveBareDataPlane(args.runtimeId) !== undefined
        ? "alive"
        : "dead"
    },
    async isRunning(): Promise<boolean> {
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
      throw new SandboxAdapterError("getHost is not supported (local:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxAdapterError("setTimeout is not supported (local:bare)")
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      return getLiveBareDataPlane(ref.runtimeId) !== undefined
        ? "alive"
        : "dead"
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
 *  are HOST-SIDE realpath-confined. */
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
  /** Inject the docker CLI spawner (test seam — align with docker-sandbox.test.ts). */
  dockerSpawnImpl?: SpawnImpl
  /** Force the run options (test seam). */
  optionsOverride?: DockerBareRunOptions
}

function sanitizeContainerName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-")
}

export function makeDockerBareAdapter(
  deps: MakeDockerBareAdapterDeps = {}
): HostBareAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const spawnImpl = deps.dockerSpawnImpl ?? nodeSpawn
  const runOpts = deps.optionsOverride ?? dockerBareOptionsFromEnv()
  const descriptor =
    deps.descriptorOverride ??
    buildDockerBareDescriptor({
      egress: runOpts.pureNetwork ? "named" : "none",
    })
  const { meta, endpoint } = bareMetaFor("docker")
  return {
    key: "docker:bare",
    provider: "docker",
    mode: "bare",
    kind: "hostBare",
    capabilities: descriptor,
    meta,
    endpoint,
    async create(spec: SandboxSpec): Promise<SandboxHandle> {
      // docker:bare is host-backed (volume-subpath mounts of the session root).
      const host = requireHostSpec(spec)
      // uid-PARITY create-time probe (defense-in-depth over the boot superRefine):
      // docker:bare fs is host-side, so a container uid ≠ the API uid corrupts
      // shared-volume ownership. State the root-in-container caveat.
      const apiUid =
        typeof process.getuid === "function" ? process.getuid() : undefined
      if (apiUid !== undefined && (runOpts.runAsUid ?? 0) !== apiUid) {
        throw new SandboxAdapterError(
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
      ).filter((name) => existsSync(join(host.sandboxRoot, name)))
      if (mountPoints.length === 0) {
        throw new SandboxAdapterError(
          `docker:bare: no mount-point dirs exist under ${host.sandboxRoot}`
        )
      }
      const containerName = `synapse-sbx-bare-${sanitizeContainerName(host.sessionId)}`
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
        throw new SandboxAdapterError(
          `docker run (bare) failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      if (runRes.code !== 0) {
        throw new SandboxAdapterError(
          `docker run (bare) exited ${runRes.code}: ${runRes.stderr.slice(0, 300)}`
        )
      }
      const containerId = runRes.stdout.trim().split("\n").pop()?.trim() ?? ""
      if (!containerId) {
        throw new SandboxAdapterError(
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
          throw new SandboxAdapterError(
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
          sandboxRoot: host.sandboxRoot,
          descriptor,
          containerId,
          spawnImpl,
        })
        registerBareDataPlane(runtimeId, plane)
        await host.onRuntimeReady?.(runtimeId)
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
        throw new SandboxAdapterError(
          `docker:bare adapter cannot connect to a ${ref.adapter}:${ref.mode} sandbox`
        )
      }
      // Pure reconstruction (teardown/liveness). The plane rebuilds lazily on the
      // next dispatch (bare-dispatch registry miss forks on docker-exec:<cid>).
      return makeDockerBareRefHandle(ref, spawnImpl)
    },
    // Bare (host) → catalog authored in create()'s mint tx; no tunnel endpoint.
    ready: async () => ({ ok: true }),
    workingSet: () => createProductWorkingSetBridge(),
    // §1.8: the docker-exec scheme fork moved OFF the spine INTO the adapter.
    // R3.2: the container id comes from the row's AUTHORITATIVE resourceId, NEVER
    // sliced out of the free-string endpoint.
    rebuildDataPlane: async (row: BareDataPlaneRebuildRow) =>
      createDockerBareDataPlane({
        sandboxRoot: row.sandboxRoot,
        descriptor: row.descriptor,
        containerId: row.resourceId ?? "",
        spawnImpl,
      }),
    // Host wraps the existing docker-exec plane (no data-plane secret). Only the
    // OFF-BOX reconnect path actually invokes reconnectDataPlane; host adapters expose
    // it for symmetry.
    reconnectDataPlane: async (ref) => ({
      plane: createDockerBareDataPlane({
        sandboxRoot: sandboxRootForSession(ref.sandboxId),
        descriptor,
        containerId: ref.resourceId,
        spawnImpl,
      }),
      credentials: null,
    }),
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
      throw new SandboxAdapterError("getHost is not supported (docker:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxAdapterError("setTimeout is not supported (docker:bare)")
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      return probeDockerContainerLiveness(args.spawnImpl, args.containerId)
    },
    async isRunning(): Promise<boolean> {
      return (
        (await probeDockerContainerLiveness(
          args.spawnImpl,
          args.containerId
        )) === "alive"
      )
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
      throw new SandboxAdapterError("getHost is not supported (docker:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxAdapterError("setTimeout is not supported (docker:bare)")
    },
    async probeLiveness(): Promise<SandboxLiveness> {
      return probeDockerContainerLiveness(spawnImpl, containerId)
    },
    async isRunning(): Promise<boolean> {
      return (
        (await probeDockerContainerLiveness(spawnImpl, containerId)) === "alive"
      )
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
 * The SINGLE `${provider}:${mode}` → adapter-factory map (P8B). Both the provision
 * resolver (resolveSandboxAdapter) and the persisted-row resolver (adapterForRow)
 * consume it, so the adapter set is declared ONCE and the fail-closed default falls out
 * of a single lookup — there is no second switch to drift. cubesandbox:bare IS the
 * registered off-box adapter (R4); a miss is the fail-closed case both consumers key off.
 *
 * COMPILE-TIME REGISTRATION CLOSURE (R9): the map type `{ [K in SandboxAdapterKey]:
 * (deps?) => AdapterForKey<K> }` proves all three sync arms the metadata leaf implies —
 *  (a) EXACTLY the leaf's keys are registered (a missing OR extra factory is a type
 *      error, since SandboxAdapterKey is derived from the `as const` table),
 *  (b) each factory returns the variant whose `kind` is that key's leaf kind (a wrong
 *      kind is a type error — the factory's concrete return type is checked against
 *      AdapterForKey<K>), and
 *  (c) adding a metadata leaf FORCES a matching factory (K gains a member ⇒ the mapped
 *      type demands its slot).
 * So the registration invariant is now the compiler's, not a runtime test's.
 */
interface AdapterFactoryDeps {
  hostProvider?: HostProvider
  dockerSpawnImpl?: SpawnImpl
  /** (§1.5) injected into the resident adapters so ready() can wait for catalog +
   *  tunnel without an adapter-registry→service module cycle. */
  readiness?: ResidentReadinessWaiters
}

const ADAPTER_FACTORIES: {
  [K in SandboxAdapterKey]: (deps?: AdapterFactoryDeps) => AdapterForKey<K>
} = {
  "local:resident": (deps) =>
    makeLocalResidentAdapter({
      hostProvider: deps?.hostProvider,
      readiness: deps?.readiness,
    }),
  "docker:resident": (deps) =>
    makeDockerResidentAdapter({
      dockerSpawnImpl: deps?.dockerSpawnImpl,
      readiness: deps?.readiness,
    }),
  "local:bare": () => makeLocalBareAdapter(),
  "docker:bare": (deps) =>
    makeDockerBareAdapter({ dockerSpawnImpl: deps?.dockerSpawnImpl }),
  // First OFF-BOX bare adapter (P4b): confinedFs:'unsupported' + rebuildDataPlane.
  "cubesandbox:bare": () => makeCubesandboxBareAdapter(),
}

/**
 * The registered `${provider}:${mode}` keys of ADAPTER_FACTORIES. Exposed so the
 * P1.2 host-side invariant test can drive off the REAL registry (and cross-check
 * it against the SANDBOX_ADAPTER_KEYS leaf), so registering ANY new adapter is
 * forced through the confinedFs='native' guard instead of a hardcoded list.
 */
export function listRegisteredAdapterKeys(): string[] {
  return Object.keys(ADAPTER_FACTORIES)
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
  deps?: AdapterFactoryDeps
): SandboxAdapter | null {
  const key = `${provider}:${mode}`
  // Narrow the untrusted config string to a registered key before indexing the strict
  // map (the type guard closes over the leaf key set — no separate allowlist to drift).
  if (isRegisteredSandboxAdapterKey(key)) return ADAPTER_FACTORIES[key](deps)
  // cubesandbox:bare IS the registered off-box adapter (R4). An unknown tag denies.
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
 * (connect-only), and for docker its connect() is the env-free connectDockerSandbox (F-A).
 *
 * FAIL-CLOSED (P8B): an unknown persisted adapter key THROWS rather than
 * silently downgrading to a local resident adapter. A silent downgrade would run
 * teardown / liveness / reconnect on the WRONG substrate (e.g. treat a persisted
 * docker/cubesandbox row as a local in-process runtime), potentially mis-reaping or
 * declaring a live sandbox dead. Throwing is safe because every teardown caller
 * try/catches with a hostPid fallback, so an unrecognized row degrades to that
 * fallback instead of a wrong-substrate action.
 */
export function adapterForRow(
  adapter: string,
  mode: "resident" | "bare",
  deps?: { dockerSpawnImpl?: SpawnImpl }
): SandboxAdapter {
  const key = `${adapter}:${mode}`
  // Narrow the untrusted PERSISTED string before indexing the strict map; an unknown
  // key fail-closes (THROWS) rather than silently downgrading to a local resident.
  if (!isRegisteredSandboxAdapterKey(key)) {
    throw new SandboxAdapterError(
      `adapterForRow: unknown persisted adapter key '${key}' (fail-closed; no silent downgrade)`
    )
  }
  return ADAPTER_FACTORIES[key](deps)
}
