// Sandbox ADAPTER registry (§4.1 / §4.7.2). Supersedes the P2 `selectSandboxBackend`
// (which forked ONLY on provider and never on mode — so SANDBOX_MODE=bare was
// inert). An adapter is keyed `${provider}:${mode}` and carries the metadata the
// provision spine forks on (capabilities, meta.offBox / kind) plus the lifecycle
// (create/connect). The bare data plane is rebuilt lazily by bare-dispatch on a
// registry miss (adapter-bound endpoint scheme, P1.3); it is NOT carried on the
// adapter (the dead `dataPlane?()` method was removed in P1.2). P1.2 INVARIANT
// (machine-enforced by adapter-registry-fail-closed.test.ts): every BARE adapter
// is host-side (capabilities.confinedFs==='native') — that is what makes the
// current host-dir materialize/commit-scan + host-side endpoint fork valid. The
// first OFF-BOX adapter (cubesandbox:bare, confinedFs:'unsupported') TRIPS that
// guard, which is why the adapter.rebuildDataPlane + off-box working-set seam are
// built + VALIDATED alongside it (R4).
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
  requireHostSpec,
  SandboxBackendError,
  type SandboxBackend,
  type SandboxDataPlaneCredentials,
  type SandboxHandle,
  type WorkingSetHandle,
  type SandboxInfo,
  type SandboxLiveness,
  type SandboxRef,
  type SandboxSpec,
} from "./sandbox-backend.js"
import {
  createDockerSandboxBackend,
  createDockerReconnectBackend,
  buildBareDockerRunArgs,
  runDockerCapture,
  probeDockerContainerLiveness,
  SANDBOX_SESSION_LABEL,
  type DockerSandboxBackendOptions,
  type SpawnImpl,
} from "./docker-sandbox-backend.js"
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
  type SandboxAdapterMeta,
  type AdapterEndpointContract,
} from "./adapter-metadata.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

const log = createLogger("sandbox.adapter-registry")

/** (R4 §1.1 2d/2e) readiness + negotiated provider facts, surfaced to the spine. */
export interface ReadinessReport {
  ok: boolean
  /** e.g. "envd_version_below_min", "unreachable". */
  reason?: string
  /** (2e) provider fact; preferred over process.* (threaded in a later phase). */
  platform?: string
  arch?: string
  /** off-box negotiation results (a later phase). */
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

/** The two readiness budgets the spine passes to `ready()` (§6.9). */
export interface AdapterReadyOptions {
  catalogTimeoutMs: number
  /** `<= 0` opts out of the tunnel wait (test seam), preserved from the spine. */
  tunnelTimeoutMs: number
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
 * (#13) The adapter's discriminant — derived from mode + meta.offBox at
 * construction (ONE source of truth: the config-free metadata leaf). It type-narrows
 * the off-box-only lifecycle methods so the teardown/recovery/reap paths call them
 * WITHOUT a `!` non-null assertion or a runtime truthiness guard (see
 * {@link OffBoxSandboxAdapter} / {@link isOffBoxAdapter}).
 *   - 'resident'   → Mode-A (local/docker resident); no bare data plane.
 *   - 'hostBare'   → Mode-B on THIS host (local/docker bare); a rebuildable plane.
 *   - 'offBoxBare' → a remote-VM provider (cubesandbox); the off-box lifecycle.
 */
export type SandboxAdapterKind = "resident" | "hostBare" | "offBoxBare"

export interface SandboxAdapter {
  // ── identity / metadata ────────────────────────────────────────────────────
  readonly key: string
  readonly provider: string
  readonly mode: "resident" | "bare"
  /** (#13) discriminant for off-box narrowing; derived from mode + meta.offBox. */
  readonly kind: SandboxAdapterKind
  /** Frozen descriptor for a bare adapter; null for a resident adapter. */
  readonly capabilities: SandboxCapabilityDescriptor | null
  /**
   * (2h) adapter-declared metadata REPLACES `readonly kind`. Sourced from the
   * config-free adapter-metadata leaf. `meta.tag` (== provider) is the sole
   * persisted adapter tag (written to sandboxes.adapter).
   */
  readonly meta: SandboxAdapterMeta
  /**
   * (2g) endpoint scheme + R3.2 identity predicate (from the leaf). null for
   * resident. bare-dispatch resolves the identity predicate from the LEAF by tag
   * (not this field) so an unknown row can't throw; this field is the adapter's
   * own copy for symmetry.
   */
  readonly endpoint: AdapterEndpointContract | null

  // ── lifecycle ──────────────────────────────────────────────────────────────
  create(spec: SandboxSpec): Promise<SandboxHandle>
  connect(ref: SandboxRef): Promise<SandboxHandle>

  /**
   * (2a/2d) readiness/negotiation BEFORE the active-flip. resident → catalog +
   * tunnel wait; bare (host + off-box) → immediate ok (the api-authored catalog
   * is already committed). ASYNC. On `{ ok:false }` the spine fails provision.
   */
  ready(
    handle: SandboxHandle,
    opts: AdapterReadyOptions
  ): Promise<ReadinessReport>

  /**
   * (2c) working-set contract: the adapter supplies the bridge the spine drives
   * on provision (push) and teardown (pull-before-kill). Host adapters return the
   * pass-through product bridge; the off-box adapter builds the detached envd bridge.
   * Takes only {@link WorkingSetHandle} (resourceId + credentials) — the complete set
   * any impl reads — so the teardown/recovery path never fabricates a full handle.
   */
  workingSet(handle: WorkingSetHandle): WorkingSetBridge

  /**
   * (2a/§1.8) Reconstruct the data plane from a PERSISTED row on a bare-dispatch
   * rebuild-on-miss. EVERY bare adapter implements it now: host adapters wrap
   * createLocalBareDataPlane / createDockerBareDataPlane (the scheme forks moved
   * off the spine INTO the adapters); off-box builds the remote plane. ASYNC (an
   * off-box rebuild must connect + re-mint tokens — a later sub-phase). Resident
   * adapters leave it undefined.
   */
  rebuildDataPlane?(row: BareDataPlaneRebuildRow): Promise<SandboxDataPlane>

  /**
   * (2b/§6.2) token-bearing reconnect seam for teardown/recovery pull. off-box
   * (cube) = control.connect(resourceId) → prefer a FRESH re-minted token, else
   * fall back to the persisted decrypted creds → build a token-bearing remote
   * plane; when the token CHANGED and the sandbox is non-terminal, re-persist the
   * fresh envelope via the injected executor (NEVER on the read-only dispatch fast
   * path unless it changed). host adapters wrap their existing plane (no secret).
   * Wired by teardown/recovery in a later sub-phase.
   */
  reconnectDataPlane?(
    ref: SandboxRef,
    opts?: SandboxReconnectOptions
  ): Promise<{
    plane: SandboxDataPlane
    credentials: SandboxDataPlaneCredentials | null
  }>

  /**
   * (2f) orphan enumeration + destroy-retry so the reconciler can DELETE
   * untracked provider resources. off-box (cube) lists provider VMs tagged as
   * ours whose resource id is not in `activeResourceIds` (the live/non-terminal
   * DB set) and older than `minAgeMs` (the create→mint race grace). resident/host
   * adapters leave it undefined (docker keeps its label-reaper in the spine).
   */
  listOrphans?(opts: {
    activeResourceIds: ReadonlySet<string>
    /** Never report a resource younger than this (its mint may be in flight). */
    minAgeMs?: number
  }): Promise<OrphanResource[]>
  destroyResource?(resourceId: string): Promise<void>

  /**
   * (2f keepalive) Push a non-terminal provider resource's auto-destroy deadline
   * forward. off-box VMs self-destruct on a HARD provider TTL (the paid-resource
   * leak backstop); the maintenance tick calls this for every non-terminal
   * off-box sandbox so an ACTIVE session's VM never expires mid-session. Adapters
   * whose resources don't self-destruct (resident/host) leave it undefined.
   */
  refreshResourceDeadline?(resourceId: string): Promise<void>
}

/**
 * (#13) An OFF-BOX adapter (a remote-VM provider — cubesandbox) with the off-box
 * lifecycle methods TYPE-REQUIRED. The teardown/recovery/reap/keepalive paths accept
 * this narrower type (via {@link isOffBoxAdapter}), so they call reconnectDataPlane /
 * rebuildDataPlane / listOrphans / destroyResource / refreshResourceDeadline with NO
 * `!` non-null assertion or runtime truthiness guard — the compiler now enforces what
 * the `meta.offBox` gate proved. A host/resident adapter can never be passed there.
 */
export interface OffBoxSandboxAdapter extends SandboxAdapter {
  readonly kind: "offBoxBare"
  // (R6 #6) narrow the working-set bridge to the off-box shape where `pull` is REQUIRED
  // — teardown/recovery call it unconditionally + branch on the PullOutcome.
  workingSet(handle: WorkingSetHandle): OffBoxWorkingSetBridge
  rebuildDataPlane(row: BareDataPlaneRebuildRow): Promise<SandboxDataPlane>
  reconnectDataPlane(
    ref: SandboxRef,
    opts?: SandboxReconnectOptions
  ): Promise<{
    plane: SandboxDataPlane
    credentials: SandboxDataPlaneCredentials | null
  }>
  listOrphans(opts: {
    activeResourceIds: ReadonlySet<string>
    minAgeMs?: number
  }): Promise<OrphanResource[]>
  destroyResource(resourceId: string): Promise<void>
  refreshResourceDeadline(resourceId: string): Promise<void>
}

/** (#13) Narrow a SandboxAdapter to {@link OffBoxSandboxAdapter} on its discriminant.
 *  Replaces the scattered `adapter.meta.offBox` checks that TS could not connect to
 *  the optional off-box methods. */
export function isOffBoxAdapter(
  adapter: SandboxAdapter
): adapter is OffBoxSandboxAdapter {
  return adapter.kind === "offBoxBare"
}

/**
 * Fetch the metadata leaf for an adapter key (the registration invariant: every
 * factory key is in the leaf table). Throws on a drift so a mis-registered
 * adapter fails loud at construction, not silently at dispatch.
 */
function metaFor(
  provider: string,
  mode: "resident" | "bare"
): {
  meta: SandboxAdapterMeta
  endpoint: AdapterEndpointContract | null
  kind: SandboxAdapterKind
} {
  const entry = sandboxAdapterMetadata(provider, mode)
  if (!entry) {
    throw new SandboxBackendError(
      `no adapter-metadata leaf for '${provider}:${mode}' (registry/metadata drift)`
    )
  }
  // (#13) derive the discriminant from the leaf — the SINGLE source of off-box truth.
  let kind: SandboxAdapterKind
  if (mode === "resident") kind = "resident"
  else if (entry.meta.offBox) kind = "offBoxBare"
  else kind = "hostBare"
  return { meta: entry.meta, endpoint: entry.endpoint, kind }
}

/** Build the docker backend options from the validated config.sandbox namespace.
 *  (Relocated from service.ts so the registry can build the LAZY provision backend
 *  without a value cycle. Consumed HERE only — the docker:resident factory below;
 *  service.ts no longer imports it.) */
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
    timeoutMs: opts.catalogTimeoutMs,
  })
  if (opts.tunnelTimeoutMs > 0) {
    await waiters.waitForTunnelEndpoint(handle.runtimeLink.runtimeServiceId, {
      timeoutMs: opts.tunnelTimeoutMs,
    })
  }
  return { ok: true }
}

function makeLocalResidentAdapter(deps?: {
  hostProvider?: HostProvider
  readiness?: ResidentReadinessWaiters
}): SandboxAdapter {
  const hostProvider = deps?.hostProvider ?? createLocalHostProvider()
  const backend: SandboxBackend = createLocalSandboxBackend({ hostProvider })
  const { meta, endpoint, kind } = metaFor("local", "resident")
  return {
    key: "local:resident",
    provider: "local",
    mode: "resident",
    kind,
    capabilities: null,
    meta,
    endpoint,
    create: (spec) => backend.create(spec),
    connect: (ref) => backend.connect(ref),
    ready: (handle, opts) => residentReady(deps?.readiness, handle, opts),
    // R4 Phase 1c: resident sandboxes are CAS-materialized on the host; the
    // product bridge is the existing pass-through spine primitive.
    workingSet: () => createProductWorkingSetBridge(),
    // R4 Phase 1d: resident/local has no provider resources to sweep.
    listOrphans: async () => [],
  }
}

function makeDockerResidentAdapter(deps?: {
  dockerSpawnImpl?: SpawnImpl
  readiness?: ResidentReadinessWaiters
}): SandboxAdapter {
  // F-A: connect (teardown/liveness/reconnect) uses the ENV-FREE reconnect
  // backend; create (provision) lazily builds the provision backend ONLY when
  // invoked. The two never share the provision factory on the teardown path.
  const reconnect = createDockerReconnectBackend({
    spawnImpl: deps?.dockerSpawnImpl,
  })
  const { meta, endpoint, kind } = metaFor("docker", "resident")
  return {
    key: "docker:resident",
    provider: "docker",
    mode: "resident",
    kind,
    capabilities: null,
    meta,
    endpoint,
    create: (spec) =>
      createDockerSandboxBackend(dockerBackendOptionsFromEnv()).create(spec),
    connect: (ref) => reconnect.connect(ref),
    ready: (handle, opts) => residentReady(deps?.readiness, handle, opts),
    workingSet: () => createProductWorkingSetBridge(),
    // R4 Phase 1d: the docker label reaper (reapDockerSandboxOrphans) stays in
    // the reconcile spine for now; generalizing it through listOrphans is later.
    listOrphans: async () => [],
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
): SandboxAdapter {
  const mint = deps.mintRuntime ?? mintBareSandboxRuntime
  const descriptor = deps.descriptorOverride ?? buildLocalBareDescriptor()
  const { meta, endpoint, kind } = metaFor("local", "bare")
  return {
    key: "local:bare",
    provider: "local",
    mode: "bare",
    kind,
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
        throw new SandboxBackendError(
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
    // R4 Phase 1b: host wraps the existing in-process plane (no data-plane
    // secret). Uncalled in Phase 1a; the teardown/recovery pull wires it later.
    reconnectDataPlane: async (ref) => ({
      plane: createLocalBareDataPlane({
        sandboxRoot: sandboxRootForSession(ref.sandboxId),
        descriptor,
      }),
      credentials: null,
    }),
    // R4 Phase 1d: local has no provider resources to sweep.
    listOrphans: async () => [],
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
      throw new SandboxBackendError("getHost is not supported (local:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError("setTimeout is not supported (local:bare)")
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
  const { meta, endpoint, kind } = metaFor("docker", "bare")
  return {
    key: "docker:bare",
    provider: "docker",
    mode: "bare",
    kind,
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
      ).filter((name) => existsSync(join(host.sandboxRoot, name)))
      if (mountPoints.length === 0) {
        throw new SandboxBackendError(
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
        throw new SandboxBackendError(
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
    // R4 Phase 1b: host wraps the existing docker-exec plane (no data-plane
    // secret). Uncalled in Phase 1a.
    reconnectDataPlane: async (ref) => ({
      plane: createDockerBareDataPlane({
        sandboxRoot: sandboxRootForSession(ref.sandboxId),
        descriptor,
        containerId: ref.resourceId,
        spawnImpl,
      }),
      credentials: null,
    }),
    // R4 Phase 1d: the docker label reaper stays in the reconcile spine for now.
    listOrphans: async () => [],
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
      throw new SandboxBackendError("getHost is not supported (docker:bare)")
    },
    async setTimeout(): Promise<void> {
      throw new SandboxBackendError("setTimeout is not supported (docker:bare)")
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
 * The SINGLE `${provider}:${mode}` → adapter-factory map (P8B). Both the
 * provision resolver (resolveSandboxAdapter) and the persisted-row resolver
 * (adapterForRow) consume it, so the 4-key adapter set is declared ONCE and the
 * fail-closed default falls out of a single lookup — there is no second switch
 * to drift. cubesandbox:bare IS the registered off-box adapter (R4); a miss is the
 * fail-closed case both consumers key off of.
 */
interface AdapterFactoryDeps {
  hostProvider?: HostProvider
  dockerSpawnImpl?: SpawnImpl
  /** (§1.5) injected into the resident adapters so ready() can wait for catalog +
   *  tunnel without an adapter-registry→service module cycle. */
  readiness?: ResidentReadinessWaiters
}

const ADAPTER_FACTORIES: Record<
  string,
  (deps?: AdapterFactoryDeps) => SandboxAdapter
> = {
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
  const factory = ADAPTER_FACTORIES[key]
  if (factory) return factory(deps)
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
 * (connect-only), and for docker it uses the env-free reconnect backend (F-A).
 *
 * FAIL-CLOSED (P8B): an unknown persisted adapter key THROWS rather than
 * silently downgrading to a local resident adapter. A silent downgrade would run
 * teardown / liveness / reconnect on the WRONG substrate (e.g. treat a persisted
 * docker/cubesandbox row as a local in-process runtime), potentially mis-reaping or
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
