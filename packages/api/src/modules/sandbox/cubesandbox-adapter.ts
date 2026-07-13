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
import type {
  AdapterReadyOptions,
  ReadinessReport,
  SandboxAdapter,
  SandboxReconnectOptions,
} from "./adapter-registry.js"
import {
  brandRedactedCredentials,
  encodeSandboxDataPlaneCredentials,
  hasAnyToken,
  tokensForEnvd,
} from "./data-plane-credentials.js"
import { repersistBareSandboxCredentials } from "./repo.js"
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

/**
 * (§1.5/§6.9) Minimum envd version the readiness gate accepts. The cube data
 * plane was pinned against envd 0.5.11; anything below the 0.5 line is a
 * different, unvalidated wire shape. Bump when a newer envd introduces a
 * breaking data-plane change the plane relies on.
 */
const MIN_ENVD_VERSION = "0.5.0"

/** Compare dotted numeric versions ("0.5.11" >= "0.5.0"). A non-numeric / empty
 *  version fails the gate (treated as below-min) rather than passing blindly. */
export function envdVersionMeetsMin(version: string, min: string): boolean {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".")
    if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) return null
    return parts.map((p) => Number(p))
  }
  const a = parse(version)
  const b = parse(min)
  if (!a || !b) return false
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return true // equal
}

/** Map `uname -s` / `uname -m` to node-style platform/arch so the persisted
 *  facts share the vocabulary host adapters write (process.platform/arch) — the
 *  capability projection COALESCEs + exact-matches bundle platformKeys on it. */
const UNAME_ARCH_TO_NODE: Readonly<Record<string, string>> = {
  x86_64: "x64",
  amd64: "x64",
  aarch64: "arm64",
  arm64: "arm64",
  armv7l: "arm",
  armv6l: "arm",
  i386: "ia32",
  i686: "ia32",
}
function unameSysToNodePlatform(s: string): string {
  if (s === "linux") return "linux"
  if (s === "darwin") return "darwin"
  if (
    s.startsWith("mingw") ||
    s.startsWith("cygwin") ||
    s.includes("windows")
  ) {
    return "win32"
  }
  return s
}
export function unameToNodeFacts(
  unameS: string,
  unameM: string
): { platform: string; arch: string } {
  const m = unameM.trim().toLowerCase()
  return {
    platform: unameSysToNodePlatform(unameS.trim().toLowerCase()),
    arch: UNAME_ARCH_TO_NODE[m] ?? m,
  }
}

/** Whether a freshly re-minted token differs from the persisted one (gates the
 *  reconnect re-persist so the read path stays write-free when nothing changed). */
function tokensDiffer(
  fresh: { envdAccessToken?: string; trafficAccessToken?: string },
  persisted: SandboxDataPlaneCredentials | null
): boolean {
  return (
    fresh.envdAccessToken !== (persisted?.envdAccessToken ?? undefined) ||
    fresh.trafficAccessToken !== (persisted?.trafficAccessToken ?? undefined)
  )
}

/**
 * (§1.6/2e) Obtain the OFF-BOX VM's platform/arch via a one-shot envd exec — the
 * cube control plane carries no arch, and the API host's process.* would misgrant
 * bundles (arm64 API standing up an x86_64 VM). Best-effort: any failure returns
 * null and the mint falls back to sandboxHostPlatformArch (no worse than pre-R4).
 */
export async function detectCubePlatformArch(
  envd: RemoteEnvdTransport,
  timeoutMs = 15_000
): Promise<{ platform: string; arch: string } | null> {
  try {
    const res = await envd.exec({ cmd: "uname -s && uname -m" }, { timeoutMs })
    if (res.exitCode !== 0) return null
    const lines = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length < 2) return null
    return unameToNodeFacts(lines[0], lines[1])
  } catch {
    return null
  }
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
      // ② build the REMOTE envd transport (with the freshly-minted tokens, if the
      // deployment gated envd behind them). Declared OUT of the try so a failure
      // BEFORE the plane takes ownership (register) closes it here, no leak.
      const envd = envdFactory(runOpts, sandboxID, {
        trafficAccessToken: created.trafficAccessToken,
        envdAccessToken: created.envdAccessToken,
      })
      let envdOwnedByPlane = false
      try {
        const runtimeId = randomUUID()
        const serviceId = randomUUID()
        // R3.2 target-confusion binding: the endpoint carries the AUTHORITATIVE
        // sandbox id (== sandboxes.resource_id), never sliced back out of the
        // free-string endpoint on dispatch.
        const dataPlaneEndpoint = `envd:${sandboxID}`
        // (R4 §1.3/§1.6/§6.7) Compute resource_id + encrypted creds + provider
        // platform/arch BEFORE mint so they persist ATOMICALLY in the sandbox
        // INSERT (no back-fill window). The AAD binds the cred envelope to THIS
        // row's identity (runtimeId ‖ workspaceId) so it can't be swapped onto
        // another row. Creds are null on the unauthenticated local cube (no
        // tokens) → the column stays NULL, dormant until a gated deploy.
        const rawCredentials = {
          envdAccessToken: created.envdAccessToken,
          trafficAccessToken: created.trafficAccessToken,
        }
        const platformArch = await detectCubePlatformArch(envd)
        const credentialsEncrypted = encodeSandboxDataPlaneCredentials(
          rawCredentials,
          { sandboxRowId: runtimeId, workspaceId: spec.workspaceId }
        )
        await mint({
          runtimeId,
          workspaceId: spec.workspaceId,
          sessionId: spec.sessionId,
          serviceId,
          adapter: "cubesandbox",
          dataPlaneEndpoint,
          resourceId: sandboxID,
          credentialsEncrypted,
          platform: platformArch?.platform,
          arch: platformArch?.arch,
          capabilityDescriptor: descriptor as unknown as Record<
            string,
            unknown
          >,
          exposures: buildBareCoreCatalog(descriptor),
        })
        mintedRuntimeId = runtimeId
        const plane = createRemoteBareDataPlane({
          sandboxID,
          descriptor,
          vmRoot: runOpts.vmRoot,
          envd,
        })
        envdOwnedByPlane = true // dispose(plane) now closes envd
        registerBareDataPlane(runtimeId, plane)
        // ③ the runtime's DB identity now exists → let the spine back-fill mounts.
        await spec.onRuntimeReady?.(runtimeId)
        return makeCubesandboxBareHandle({
          sessionId: spec.sessionId,
          runtimeId,
          serviceId,
          sandboxID,
          control,
          // (R4 §1.3/§6.7) BRANDED redacted creds on the handle — the plane above
          // already holds the live tokens; these are persisted (encrypted) and
          // redacted so a stray log/serialize can't leak them.
          credentials: brandRedactedCredentials(rawCredentials),
        })
      } catch (err) {
        // Self-clean on ANY failure: drop the plane, soft-delete the runtime, and
        // kill the VM we stood up (best-effort + idempotent).
        if (mintedRuntimeId) {
          const p = unregisterBareDataPlane(mintedRuntimeId)
          if (p) await p.dispose().catch(() => {})
          await deleteRuntime(spec.workspaceId, mintedRuntimeId).catch(() => {})
        }
        // No plane took ownership of the transport → close it so its pooled
        // dispatcher doesn't leak (e.g. a mint failure before the plane build).
        if (!envdOwnedByPlane) await envd.close().catch(() => {})
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
    // OFF-BOX readiness negotiation (§1.5/§6.9): control reachability + an envd
    // version gate + a domain-suffix (SSRF-inversion) guard + envd data-plane
    // reachability, BEFORE the spine flips the sandbox active. On any failure
    // returns { ok:false, reason } — the spine's provision-fail fork then re-probes
    // liveness and LEAVES the (possibly-live) VM in 'closing' rather than DELETEing
    // it (§6.9). `tunnelTimeoutMs <= 0` opts out of the envd reachability probe
    // (test seam), mirroring the resident tunnel-wait opt-out.
    async ready(
      handle: SandboxHandle,
      opts: AdapterReadyOptions
    ): Promise<ReadinessReport> {
      const sandboxID = handle.resourceId
      const control = controlFactory(runOpts)
      // (1) control-plane reachability + the authoritative envdVersion/domain.
      let info: CubeSandboxInfo | null
      try {
        info = await control.getInfo(sandboxID)
      } catch (err) {
        return { ok: false, reason: `control_unreachable: ${errMessage(err)}` }
      }
      if (!info) return { ok: false, reason: "sandbox_absent" }
      // (2) version gate — reject an envd below the validated data-plane floor.
      if (!envdVersionMeetsMin(info.envdVersion, MIN_ENVD_VERSION)) {
        return {
          ok: false,
          reason: `envd_version_below_min: ${info.envdVersion || "<none>"} < ${MIN_ENVD_VERSION}`,
        }
      }
      // (3) domain-suffix guard (SSRF-inversion): the VM's reported vhost domain
      // MUST be the deployment's configured domain — a rogue control plane can't
      // redirect our envd dials at an attacker-chosen host.
      if (
        info.domain &&
        info.domain !== runOpts.domain &&
        !info.domain.endsWith(`.${runOpts.domain}`)
      ) {
        return {
          ok: false,
          reason: `domain_mismatch: ${info.domain} not under ${runOpts.domain}`,
        }
      }
      // (4) envd data-plane reachability. envd speaks the Connect protocol (no
      // plain GET /health on this deployment), so a proven unary fs RPC (stat the
      // VM root) is the reachability signal. tunnelTimeoutMs<=0 skips it (test).
      if (opts.tunnelTimeoutMs > 0) {
        const envd = envdFactory(
          runOpts,
          sandboxID,
          tokensForEnvd(handle.credentials)
        )
        try {
          await envd.stat(runOpts.vmRoot)
        } catch (err) {
          await envd.close?.().catch(() => {})
          return { ok: false, reason: `envd_unreachable: ${errMessage(err)}` }
        }
        await envd.close?.().catch(() => {})
      }
      return {
        ok: true,
        envdVersion: info.envdVersion,
        domain: info.domain,
      }
    },
    // R4 Phase 1c: ALL adapters return the pass-through product bridge for now;
    // the off-box envd DETACHED bridge (delete-aware mirror over the plane's
    // RemoteEnvdTransport) replaces this in a later sub-phase.
    workingSet: () => createProductWorkingSetBridge(),
    // §1.8 seam: reconstruct the REMOTE plane from the PERSISTED row — resource_id
    // (== sandbox id) + descriptor + the DECRYPTED creds threaded by the dispatch
    // repo exit. deployment-wide connection facts (domain/proxy/vmRoot/port) come
    // from config, never live config for the adapter kind. ASYNC (§1.2). The
    // dispatch fast path is DB-read-only: it re-injects the PERSISTED token (no
    // control-plane connect/re-mint here — that is the reconnect seam's job, §6.2).
    async rebuildDataPlane(
      row: BareDataPlaneRebuildRow
    ): Promise<SandboxDataPlane> {
      const sandboxID = row.resourceId ?? ""
      const envd = envdFactory(
        runOpts,
        sandboxID,
        tokensForEnvd(row.credentials)
      )
      return createRemoteBareDataPlane({
        sandboxID,
        descriptor: row.descriptor,
        vmRoot: runOpts.vmRoot,
        envd,
      })
    },
    // Token-bearing off-box reconnect (§6.2), for teardown/recovery pull (wired
    // later). control.connect MAY re-mint tokens (E2B does; the local
    // unauthenticated deploy returns none — live-verified). Prefer a FRESH token;
    // else fall back to the persisted decrypted creds. When the token CHANGED and
    // the sandbox is non-terminal, re-persist the fresh envelope via the injected
    // executor (skipped on the read-only path unless it changed).
    async reconnectDataPlane(
      ref: SandboxRef,
      opts?: SandboxReconnectOptions
    ): Promise<{
      plane: SandboxDataPlane
      credentials: SandboxDataPlaneCredentials | null
    }> {
      const sandboxID = ref.resourceId
      const control = controlFactory(runOpts)
      const connected = await control.connect(sandboxID).catch(() => null)
      const fresh =
        connected && (connected.envdAccessToken || connected.trafficAccessToken)
          ? {
              envdAccessToken: connected.envdAccessToken,
              trafficAccessToken: connected.trafficAccessToken,
            }
          : null
      const persisted = opts?.persistedCredentials ?? null
      // Prefer the fresh re-minted token; else fall back to the persisted creds.
      const chosen =
        fresh ??
        (hasAnyToken(persisted)
          ? {
              envdAccessToken: persisted?.envdAccessToken,
              trafficAccessToken: persisted?.trafficAccessToken,
            }
          : null)
      const envd = envdFactory(runOpts, sandboxID, chosen ?? undefined)
      const plane = createRemoteBareDataPlane({
        sandboxID,
        descriptor,
        vmRoot: runOpts.vmRoot,
        envd,
      })
      const credentials = chosen ? brandRedactedCredentials(chosen) : null
      // Re-persist ONLY when connect actually re-minted a token that DIFFERS from
      // the persisted one, and we can (executor + workspaceId). The repo update
      // CASes on non-terminal state so a racing teardown can't resurrect it.
      if (
        fresh &&
        opts?.executor &&
        opts?.workspaceId &&
        tokensDiffer(fresh, persisted)
      ) {
        const encrypted = encodeSandboxDataPlaneCredentials(
          brandRedactedCredentials(fresh),
          { sandboxRowId: ref.runtimeId, workspaceId: opts.workspaceId }
        )
        await repersistBareSandboxCredentials(
          ref.runtimeId,
          encrypted,
          opts.executor
        ).catch((err) => {
          log.warn(
            { sandboxID, err: errMessage(err) },
            "reconnect re-persist of fresh creds failed (non-fatal)"
          )
        })
      }
      return { plane, credentials }
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
    // (R4 §1.3) captured at create + persisted encrypted at mint; BRANDED redacted.
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
