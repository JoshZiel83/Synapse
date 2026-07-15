// Config-free LEAF: the per-adapter metadata table for every registered
// `${provider}:${mode}` sandbox adapter. Imported by BOTH config/index.ts (boot
// validation) AND adapter-registry.ts (which stamps `meta`/`endpoint` onto each
// adapter) AND bare-dispatch.ts (which resolves the endpoint identity predicate
// WITHOUT instantiating an adapter — the R3.2 target-confusion gate). Because it
// is config-free it can never re-introduce the config<->registry value cycle:
//   - it MUST NOT import config or adapter-registry at RUNTIME;
//   - it imports `RawEnv` from config TYPE-ONLY (erased at compile time, so no
//     runtime edge exists — TypeScript resolves the circular type fine).
//
// R4 §1.9 (folds the old adapter-keys.ts leaf + the config superRefine per-
// provider blocks): each entry declares its persisted tag, its off-box/creds
// facts, its endpoint scheme + R3.2 identity predicate, and its boot-config
// contract (`validate` / `validateProduction`). SANDBOX_ADAPTER_KEYS +
// isRegisteredSandboxAdapterKey derive from this one table so the registered set,
// the validated set, and the dispatch identity map can never drift.

import type { RawEnv } from "../../config/index.js"

// ── config contract (folds the config/index.ts superRefine per-provider blocks) ─

/** One boot-validation issue, shaped for zod's `ctx.addIssue({ code:"custom" })`. */
export interface ConfigIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/** (§1.9) the per-adapter env contract the boot superRefine dispatches to when
 *  this adapter's `${provider}:${mode}` is the selected substrate. */
export interface AdapterConfigContract {
  /** env keys this adapter reads (documentation + drift reference). */
  readonly envKeys: readonly string[]
  /** boot validation — issues pushed onto the superRefine ctx when selected. */
  validate(env: RawEnv): ConfigIssue[]
  /**
   * Production fail-closed (called only when NODE_ENV==='production'). The off-box
   * cube adapter enforces https + non-loopback + a non-empty API key here (#10); the
   * host adapters (local/docker) have no production-only network hardening, so they
   * return [].
   */
  validateProduction(env: RawEnv, nodeEnv: string): ConfigIssue[]
}

// ── endpoint contract (folds bare-dispatch's scheme + R3.2 identity forks) ──────

/** (§1.8/§6.1) the scheme + R3.2 identity predicate — the ONLY provider-specific
 *  bit bare-dispatch needs. Replaces the hardcoded bareTargetIdentityOk /
 *  rebuildBarePlane scheme forks. null for resident (no bare data plane). */
export interface AdapterEndpointContract {
  /** "inprocess" | "docker-exec" | "envd" */
  readonly scheme: string
  /** build the persisted scheme-tagged endpoint from row-authoritative facts. */
  build(facts: { runtimeId: string; resourceId: string | null }): string
  /**
   * R3.2: does the persisted endpoint BIND the authoritative resource id? The
   * off-box/docker resource id comes from `sandboxes.resource_id`, NEVER sliced
   * out of the free-string endpoint, so a hand-edited endpoint can't redirect the
   * plane at another sandbox/container. Resolved from THIS leaf by tag (never via
   * adapterForRow, which THROWS on an unknown tag) so an unknown/corrupt tag
   * cleanly denies (undefined lookup → `false`).
   */
  identityOk(row: {
    runtimeId: string
    resourceId: string | null
    dataPlaneEndpoint: string | null
  }): boolean
}

// ── adapter metadata (folds adapter-keys.ts) ────────────────────────────────────

/** Config-facing metadata for a registered adapter. The union discriminant lives on
 *  the entry's `kind` (SandboxAdapterMetadataEntry.kind), NOT here — `meta` carries only
 *  the persisted tag + the env/validate contract. The persisted adapter tag is just
 *  `provider` (written to sandboxes.adapter). */
export interface SandboxAdapterMeta {
  /** persisted adapter tag (== provider); written to sandboxes.adapter. */
  readonly tag: string
  /** env keys this adapter reads + a validate() the boot superRefine dispatches to. */
  readonly config: AdapterConfigContract
}

/** One registered `${provider}:${mode}` adapter's full metadata leaf. This table is
 *  the SINGLE source of truth for the adapter discriminant `kind` — the SandboxAdapter
 *  union variant each factory returns must match its table entry (kind-invariant test). */
export interface SandboxAdapterMetadataEntry {
  readonly key: string
  readonly provider: string
  readonly mode: "resident" | "bare"
  /** The SandboxAdapter union discriminant (resident | hostBare | offBoxBare). */
  readonly kind: "resident" | "hostBare" | "offBoxBare"
  readonly meta: SandboxAdapterMeta
  /** endpoint scheme + R3.2 identity predicate; null for resident. */
  readonly endpoint: AdapterEndpointContract | null
}

// ── validate helpers (verbatim-behavior copies of the config superRefine) ───────

function issue(
  path: readonly (string | number)[],
  message: string
): ConfigIssue {
  return { path, message }
}

/** docker STORAGE_VOLUME gate — required by BOTH docker modes (was the shared
 *  top of the `if (sandboxProvider === "docker")` block). */
function dockerStorageVolumeIssues(env: RawEnv): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if (!env.SANDBOX_DOCKER_STORAGE_VOLUME?.trim()) {
    issues.push(
      issue(
        ["SANDBOX_DOCKER_STORAGE_VOLUME"],
        "SANDBOX_DOCKER_STORAGE_VOLUME is required when SANDBOX_PROVIDER=docker"
      )
    )
  }
  return issues
}

const NO_PRODUCTION_ISSUES = (): ConfigIssue[] => []

/** (#10, review-fix) Whether a URL hostname is a loopback address — the FULL
 *  127.0.0.0/8 block, IPv6 ::1, and IPv4-mapped-IPv6 loopback (Node hex-encodes
 *  ::ffff:127.x.x.x → ::ffff:7fxx:xxxx), not just the literal 127.0.0.1/::1. A prod
 *  off-box "remote" control plane bound to ANY loopback is a misconfig. (Integer /
 *  hex host forms like 2130706433 or 0x7f.0.0.1 are already normalized to 127.0.0.1
 *  by `new URL`, so the 127. prefix catches them too.) */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost") return true
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true
  if (/^127\.\d+\.\d+\.\d+$/.test(h) || h === "127.0.0.1") return true
  // IPv4-mapped IPv6 loopback: ::ffff:127.x.x.x, hex-encoded as ::ffff:7fxx:xxxx.
  if (/^::ffff:127\.\d+\.\d+\.\d+$/.test(h)) return true
  if (/^::ffff:(0:)?7f[0-9a-f]{2}:[0-9a-f]+$/.test(h)) return true
  return false
}

/** Off-box cube production hardening (#10). In production the control + proxy
 *  URLs must be https:// to a NON-loopback host and an API key must be set — an
 *  unauthenticated, plaintext, or loopback-bound off-box control plane would let
 *  anyone on the path create/exec/read remote VMs. A dev/local deploy
 *  (NODE_ENV!=='production') is exempt so the unauthenticated local cube keeps
 *  working. Absence of a URL is already reported by `validate`, so this only
 *  hardens a URL that IS present. */
function cubeProductionIssues(env: RawEnv, nodeEnv: string): ConfigIssue[] {
  if (nodeEnv !== "production") return []
  const issues: ConfigIssue[] = []
  const checkUrl = (key: string, raw: string | undefined): void => {
    const value = raw?.trim()
    if (!value) return
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      issues.push(issue([key], `${key} must be a valid URL in production`))
      return
    }
    if (parsed.protocol !== "https:") {
      issues.push(
        issue(
          [key],
          `${key} must use https:// in production (got '${parsed.protocol}//') — ` +
            `an off-box sandbox control plane must not carry credentials in the clear`
        )
      )
    }
    if (isLoopbackHost(parsed.hostname)) {
      issues.push(
        issue(
          [key],
          `${key} must not point at a loopback host in production (got '${parsed.hostname}')`
        )
      )
    }
  }
  checkUrl("SANDBOX_CUBESANDBOX_API_URL", env.SANDBOX_CUBESANDBOX_API_URL)
  checkUrl("SANDBOX_CUBESANDBOX_PROXY_URL", env.SANDBOX_CUBESANDBOX_PROXY_URL)
  if (!env.SANDBOX_CUBESANDBOX_API_KEY?.trim()) {
    issues.push(
      issue(
        ["SANDBOX_CUBESANDBOX_API_KEY"],
        "SANDBOX_CUBESANDBOX_API_KEY is required in production — an unauthenticated " +
          "off-box sandbox control plane is reachable by anyone who can route to it"
      )
    )
  }
  return issues
}

// ── endpoint contracts ──────────────────────────────────────────────────────

const ENDPOINT_INPROCESS: AdapterEndpointContract = {
  scheme: "inprocess",
  build: ({ runtimeId }) => `inprocess:${runtimeId}`,
  identityOk: (row) => row.dataPlaneEndpoint === `inprocess:${row.runtimeId}`,
}

const ENDPOINT_DOCKER_EXEC: AdapterEndpointContract = {
  scheme: "docker-exec",
  build: ({ resourceId }) => `docker-exec:${resourceId ?? ""}`,
  identityOk: (row) =>
    !!row.resourceId &&
    row.dataPlaneEndpoint === `docker-exec:${row.resourceId}`,
}

const ENDPOINT_ENVD: AdapterEndpointContract = {
  scheme: "envd",
  build: ({ resourceId }) => `envd:${resourceId ?? ""}`,
  identityOk: (row) =>
    !!row.resourceId && row.dataPlaneEndpoint === `envd:${row.resourceId}`,
}

// ── the table ───────────────────────────────────────────────────────────────

/**
 * The SINGLE source of truth for the registered adapter set. Every consumer
 * (config boot validation, the ADAPTER_FACTORIES registry, the P1.2 fail-closed
 * guard, bare-dispatch identity resolution) derives from this table.
 */
export const SANDBOX_ADAPTER_METADATA = [
  {
    key: "local:resident",
    provider: "local",
    mode: "resident",
    kind: "resident",
    meta: {
      tag: "local",
      config: {
        envKeys: [],
        validate: () => [],
        validateProduction: NO_PRODUCTION_ISSUES,
      },
    },
    endpoint: null,
  },
  {
    key: "docker:resident",
    provider: "docker",
    mode: "resident",
    kind: "resident",
    meta: {
      tag: "docker",
      config: {
        envKeys: [
          "SANDBOX_DOCKER_STORAGE_VOLUME",
          "SANDBOX_DOCKER_IMAGE",
          "SANDBOX_DOCKER_NETWORK",
          "FRP_SHARED_TOKEN",
          "SYNAPSE_TUNNEL_VHOST_HOST",
          "SYNAPSE_DEVICE_TUNNEL_EDGE_URL",
        ],
        validate: (env: RawEnv): ConfigIssue[] => {
          // A docker RESIDENT sandbox runs the cloud-sandbox IMAGE on its egress
          // NETWORK and rides the frp tunnel, so it requires STORAGE_VOLUME +
          // IMAGE + NETWORK + FRP_SHARED_TOKEN + edge<->vhost consistency.
          const issues = dockerStorageVolumeIssues(env)
          if (!env.SANDBOX_DOCKER_IMAGE?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_DOCKER_IMAGE"],
                "SANDBOX_DOCKER_IMAGE is required when SANDBOX_PROVIDER=docker + SANDBOX_MODE=resident"
              )
            )
          }
          if (!env.SANDBOX_DOCKER_NETWORK?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_DOCKER_NETWORK"],
                "SANDBOX_DOCKER_NETWORK is required when SANDBOX_PROVIDER=docker + SANDBOX_MODE=resident"
              )
            )
          }
          if (!env.FRP_SHARED_TOKEN?.trim()) {
            issues.push(
              issue(
                ["FRP_SHARED_TOKEN"],
                "FRP_SHARED_TOKEN is required when SANDBOX_PROVIDER=docker (a docker sandbox is only reachable over the frp tunnel)"
              )
            )
          }
          // frps routes by the HTTP Host header (SYNAPSE_TUNNEL_VHOST_HOST); the
          // API reaches the device by fetching SYNAPSE_DEVICE_TUNNEL_EDGE_URL. If
          // the two disagree the route silently won't match. Both default to
          // `tunnel-edge`, so they only diverge under explicit custom config.
          const effectiveVhost =
            env.SYNAPSE_TUNNEL_VHOST_HOST?.trim() || "tunnel-edge"
          const edgeUrl = env.SYNAPSE_DEVICE_TUNNEL_EDGE_URL?.trim()
          let effectiveEdgeHost = "tunnel-edge"
          if (edgeUrl) {
            try {
              effectiveEdgeHost = new URL(edgeUrl).hostname
            } catch {
              issues.push(
                issue(
                  ["SYNAPSE_DEVICE_TUNNEL_EDGE_URL"],
                  `SYNAPSE_DEVICE_TUNNEL_EDGE_URL is not a valid URL: '${edgeUrl}'`
                )
              )
            }
          }
          if (effectiveEdgeHost !== effectiveVhost) {
            issues.push(
              issue(
                ["SYNAPSE_DEVICE_TUNNEL_EDGE_URL"],
                `SYNAPSE_DEVICE_TUNNEL_EDGE_URL host ('${effectiveEdgeHost}') must match ` +
                  `SYNAPSE_TUNNEL_VHOST_HOST ('${effectiveVhost}') — frps routes by the ` +
                  `vhost Host header, so a mismatch makes every sandbox dispatch fail to route`
              )
            )
          }
          return issues
        },
        validateProduction: NO_PRODUCTION_ISSUES,
      },
    },
    endpoint: null,
  },
  {
    key: "local:bare",
    provider: "local",
    mode: "bare",
    kind: "hostBare",
    meta: {
      tag: "local",
      config: {
        envKeys: [],
        validate: () => [],
        validateProduction: NO_PRODUCTION_ISSUES,
      },
    },
    endpoint: ENDPOINT_INPROCESS,
  },
  {
    key: "docker:bare",
    provider: "docker",
    mode: "bare",
    kind: "hostBare",
    meta: {
      tag: "docker",
      config: {
        envKeys: [
          "SANDBOX_DOCKER_STORAGE_VOLUME",
          "SANDBOX_DOCKER_BARE_IMAGE",
          "SANDBOX_DOCKER_RUN_AS_UID",
          "SANDBOX_DOCKER_PURE_NETWORK",
          "SANDBOX_DOCKER_NETWORK",
        ],
        validate: (env: RawEnv): ConfigIssue[] => {
          // docker:bare (Mode-B) boots WITHOUT frp (no tunnel). Requires
          // STORAGE_VOLUME + a non-empty BARE_IMAGE + uid-parity + a dedicated
          // pure-network for opt-in egress. (frp/IMAGE/NETWORK are resident-only.)
          const issues = dockerStorageVolumeIssues(env)
          if (!env.SANDBOX_DOCKER_BARE_IMAGE?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_DOCKER_BARE_IMAGE"],
                "SANDBOX_DOCKER_BARE_IMAGE is required (non-empty) when SANDBOX_PROVIDER=docker + SANDBOX_MODE=bare"
              )
            )
          }
          // uid-PARITY. docker:bare does host-side fs ops through the SAME backend
          // as local:bare; the container runs `--user <runAsUid>`. A container uid
          // != the API uid corrupts shared-volume ownership. Require equality.
          const apiUid =
            typeof process.getuid === "function" ? process.getuid() : undefined
          const runAsUid = env.SANDBOX_DOCKER_RUN_AS_UID
          if (apiUid !== undefined && (runAsUid ?? 0) !== apiUid) {
            issues.push(
              issue(
                ["SANDBOX_DOCKER_RUN_AS_UID"],
                `SANDBOX_DOCKER_RUN_AS_UID (${runAsUid ?? 0}) must equal the API process uid ` +
                  `(${apiUid}) for SANDBOX_PROVIDER=docker + SANDBOX_MODE=bare — docker:bare fs ` +
                  `ops are host-side, so a uid mismatch corrupts shared-volume ownership`
              )
            )
          }
          // PURE-NETWORK guard. Opt-in egress via SANDBOX_DOCKER_PURE_NETWORK must
          // name a DEDICATED network — never the compose default or the resident
          // frp egress network (which reach the API/tunnel).
          const pureNet = env.SANDBOX_DOCKER_PURE_NETWORK?.trim()
          if (
            pureNet &&
            (pureNet === env.SANDBOX_DOCKER_NETWORK?.trim() ||
              pureNet === "synapse-sandbox-egress" ||
              pureNet === "bridge" ||
              pureNet === "host")
          ) {
            issues.push(
              issue(
                ["SANDBOX_DOCKER_PURE_NETWORK"],
                `SANDBOX_DOCKER_PURE_NETWORK ('${pureNet}') must be a DEDICATED egress ` +
                  `network — not the compose default, 'bridge', 'host', or the resident ` +
                  `'synapse-sandbox-egress' network (those reach the API/tunnel; a bare ` +
                  `sandbox must not)`
              )
            )
          }
          return issues
        },
        validateProduction: NO_PRODUCTION_ISSUES,
      },
    },
    endpoint: ENDPOINT_DOCKER_EXEC,
  },
  {
    key: "cubesandbox:bare",
    provider: "cubesandbox",
    mode: "bare",
    kind: "offBoxBare",
    meta: {
      tag: "cubesandbox",
      // OFF-BOX: a genuinely remote VM — the data plane carries an envd/traffic
      // token secret captured at create and re-minted at reconnect (Phase 1b).
      config: {
        envKeys: [
          "SANDBOX_CUBESANDBOX_API_URL",
          "SANDBOX_CUBESANDBOX_PROXY_URL",
          "SANDBOX_CUBESANDBOX_TEMPLATE",
          "SANDBOX_CUBESANDBOX_API_KEY",
          "SANDBOX_DEPLOYMENT_ID",
        ],
        validate: (env: RawEnv): ConfigIssue[] => {
          // A remote sandbox provider is unreachable without its control/data-plane
          // URLs + a template to instantiate — fail fast at boot. (API_URL/PROXY_URL
          // carry dev defaults; TEMPLATE has none and is always required.)
          const issues: ConfigIssue[] = []
          if (!env.SANDBOX_CUBESANDBOX_API_URL?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_CUBESANDBOX_API_URL"],
                "SANDBOX_CUBESANDBOX_API_URL is required when SANDBOX_PROVIDER=cubesandbox"
              )
            )
          }
          if (!env.SANDBOX_CUBESANDBOX_PROXY_URL?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_CUBESANDBOX_PROXY_URL"],
                "SANDBOX_CUBESANDBOX_PROXY_URL is required when SANDBOX_PROVIDER=cubesandbox"
              )
            )
          }
          if (!env.SANDBOX_CUBESANDBOX_TEMPLATE?.trim()) {
            issues.push(
              issue(
                ["SANDBOX_CUBESANDBOX_TEMPLATE"],
                "SANDBOX_CUBESANDBOX_TEMPLATE is required when SANDBOX_PROVIDER=cubesandbox (the sandbox template to instantiate)"
              )
            )
          }
          // (R6 H-6) On an AUTHENTICATED (shared) Cube account, the orphan sweep reaps
          // VMs by THIS deployment's provenance marker. A DEFAULT-EMPTY
          // SANDBOX_DEPLOYMENT_ID makes this deployment the "empty-id owner" — it would
          // reap every un-marked VM, and two deployments both defaulting to empty would
          // CROSS-REAP each other's LIVE VMs. Require a non-empty deployment id whenever
          // an api key is set. (An unauthenticated self-hosted dev deployment is
          // single-tenant, so an empty id stays safe there.)
          if (
            env.SANDBOX_CUBESANDBOX_API_KEY?.trim() &&
            !env.SANDBOX_DEPLOYMENT_ID?.trim()
          ) {
            issues.push(
              issue(
                ["SANDBOX_DEPLOYMENT_ID"],
                "SANDBOX_DEPLOYMENT_ID is required when SANDBOX_CUBESANDBOX_API_KEY is set — " +
                  "on a shared/authenticated Cube account the orphan sweep reaps by this " +
                  "deployment's provenance marker, and a default-empty id would cross-reap a " +
                  "sibling deployment's live VMs"
              )
            )
          }
          return issues
        },
        // #10: production fail-closed — reject http:// control/proxy URLs,
        // loopback hosts, and an empty API key when NODE_ENV==='production'.
        validateProduction: cubeProductionIssues,
      },
    },
    endpoint: ENDPOINT_ENVD,
  },
] as const satisfies readonly SandboxAdapterMetadataEntry[]

export const SANDBOX_ADAPTER_KEYS = SANDBOX_ADAPTER_METADATA.map(
  (m) => m.key
) as readonly string[]

export type SandboxAdapterKey = (typeof SANDBOX_ADAPTER_METADATA)[number]["key"]

/** True iff `${provider}:${mode}` names a registered adapter. */
export function isRegisteredSandboxAdapterKey(key: string): boolean {
  return SANDBOX_ADAPTER_METADATA.some((m) => m.key === key)
}

/** Resolve the metadata leaf for a `${provider}:${mode}` — undefined if unknown.
 *  Config-free, so BOTH the boot superRefine and bare-dispatch can call it. */
export function sandboxAdapterMetadata(
  provider: string,
  mode: "resident" | "bare"
): SandboxAdapterMetadataEntry | undefined {
  const key = `${provider}:${mode}`
  return SANDBOX_ADAPTER_METADATA.find((m) => m.key === key)
}
