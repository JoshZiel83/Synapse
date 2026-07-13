// Shared types for the sandbox manager.

import { z } from "zod"

/**
 * Conflict-sidecar path prefix WITHIN a mount. On a refresh conflict, dir_sync
 * preserves the agent's pre-conflict local FILE version at
 * `<mountRoot>/.synapse-conflicts/<relpath>`. As an agent-visible VFS path that
 * is `/<mount-subpath>/.synapse-conflicts/<relpath>` — NOT a root-level
 * `/.synapse-conflicts/...` (which isn't a granted mount). Must match
 * CONFLICTS_DIRNAME in sidecars/fs-helper/src/manifest.rs.
 */
export const CONFLICT_SIDECAR_PREFIX = "/.synapse-conflicts"

/**
 * Why a pending conflict sidecar could not be re-materialized on a provision.
 * Drives the agent notice wording (P3): a transient failure may self-heal, a
 * permanent one never will, so they must not make the same promise.
 */
export type SidecarRestoreFailureReason = "transient" | "permanent"

export interface SidecarRestoreFailure {
  /** Agent-visible sidecar VFS path that could not be re-materialized. */
  sidecar: string
  /**
   * "transient" = may succeed on a LATER provision — the preserved bytes are
   * safe (file bytes in CAS, symlink target recorded) but couldn't be written
   * this turn (no live mount for the subpath yet, or a transient fs error). The
   * notice may promise a retry.
   * "permanent" = the durable record itself LACKS the payload needed to rebuild
   * the sidecar (a pre-round-11 / corrupt record: no contentSha for a file, no
   * target for a symlink, or an unparseable sidecar path). It will NEVER restore;
   * the notice must NOT promise a retry.
   */
  reason: SidecarRestoreFailureReason
}

/**
 * Frozen capability descriptor for a sandbox adapter (§4.1 / §4.4). Persisted
 * verbatim into `sandboxes.capability_descriptor` at mint and read back on
 * reconnect (never re-derived from live config — mode-flip safety). It is the
 * single source of truth for (a) which CORE tool families the api-authored
 * static catalog exposes (the descriptor-gated subset, F-D), and (b) the per-op
 * caps + confinement posture the canonical data-plane layer enforces.
 */
export interface SandboxCapabilityDescriptor {
  /** Mode discriminant. 'resident' descriptors are `{}`-degenerate today. */
  mode: "resident" | "bare"
  /** Default transport to the data plane. 'direct' = in-process/docker-exec. */
  transportDefault: "direct" | "indirect"
  /**
   * Whether the plane can confine fs ops to a sub-prefix of the sandbox root.
   * 'native' = the host-side/in-process vfs kernel realpath-confines every op.
   * 'unsupported' = a genuinely remote fs that can't (degraded branch, S13).
   */
  confinedFs: "native" | "unsupported"
  /** CORE (always-present) tool-family features + per-op safety caps. */
  core: {
    atomicWrite: boolean
    /** 'strict' = expected_sha256/create_only enforced; 'advisory' = best-effort. */
    staleWriteGuard: "strict" | "advisory"
    rangeRead: boolean
    search: boolean
    mkdir: boolean
    move: boolean
    remove: boolean
    /** pty is machinery-only in P4a — NEVER true in the production catalog (F-D). */
    pty: boolean
    /** Whole-file read cap (bytes). */
    maxReadBytes: number
    /** Oversized-write reject-before-hash cap (bytes). */
    maxWriteBytes: number
    /** Concurrent exec cap. */
    maxConcurrentExec: number
  }
  /** Advanced/optional tool families beyond CORE (none in P4a). */
  advancedTools: string[]
  /**
   * Command isolation posture. null = NO commandline exposure/grant (fail-closed
   * on the API host when bwrap is absent). 'bwrap' = bubblewrap jail (local:bare).
   */
  isolation: "bwrap" | "container" | "provider" | null
  /** Egress posture (provider-backed; unused in P4a's direct adapters). */
  egress?: "none" | "named"
  /** Whether the adapter supports connect()/reconnect after an API restart. */
  reconnectable: boolean
  /** Provider-backed lifecycle knobs (unused/false in P4a). */
  setTimeout?: boolean
  pause?: boolean
  portIngress?: boolean
}

/**
 * Repo-exit Zod decode for the persisted `sandboxes.capability_descriptor` JSONB
 * (P1.3). The descriptor is a TRUST boundary: the bare data plane reads its per-op
 * safety caps (maxWriteBytes / maxReadBytes / maxConcurrentExec) from it, so a
 * corrupt or hand-edited row — e.g. `maxWriteBytes:"corrupt"` — must NOT silently
 * disable a cap. `getBareSandboxForDispatch` safeParses at the repo exit and the
 * dispatch fork fails CLOSED on a decode miss rather than running with a NaN /
 * defaulted cap. NOT `.strict()` — forward-compat provider knobs (extra keys) are
 * tolerated; `isolation` MUST allow null (a no-commandline sandbox). Kept in sync
 * with SandboxCapabilityDescriptor by the `satisfies` assertion below.
 */
export const SandboxCapabilityDescriptorSchema = z.object({
  mode: z.enum(["resident", "bare"]),
  transportDefault: z.enum(["direct", "indirect"]),
  confinedFs: z.enum(["native", "unsupported"]),
  core: z.object({
    atomicWrite: z.boolean(),
    staleWriteGuard: z.enum(["strict", "advisory"]),
    rangeRead: z.boolean(),
    search: z.boolean(),
    mkdir: z.boolean(),
    move: z.boolean(),
    remove: z.boolean(),
    pty: z.boolean(),
    maxReadBytes: z.number().int().nonnegative(),
    maxWriteBytes: z.number().int().nonnegative(),
    maxConcurrentExec: z.number().int().nonnegative(),
  }),
  advancedTools: z.array(z.string()),
  isolation: z.enum(["bwrap", "container", "provider"]).nullable(),
  egress: z.enum(["none", "named"]).optional(),
  reconnectable: z.boolean(),
  setTimeout: z.boolean().optional(),
  pause: z.boolean().optional(),
  portIngress: z.boolean().optional(),
}) satisfies z.ZodType<SandboxCapabilityDescriptor>

/**
 * Decode a persisted capability_descriptor JSONB. Returns null on ANY decode
 * failure (missing field, wrong type, non-finite/negative cap) — the bare
 * dispatch fork treats null as a hard fail-closed deny.
 */
export function decodeSandboxCapabilityDescriptor(
  raw: unknown
): SandboxCapabilityDescriptor | null {
  const parsed = SandboxCapabilityDescriptorSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export interface SandboxProvisionResult {
  sessionId: string
  /** The sandbox FS root; its children are the materialized mount points. */
  sandboxRoot: string
  /** The provisioned sandbox runtime id (== sandboxes.id; device-less). */
  runtimeId: string
  /** Whether the commandline (bwrap-confined) tool was authorized. */
  commandlineEnabled: boolean
  mountIds: string[]
  /**
   * Whether every durable pending conflict sidecar was successfully
   * re-materialized into the fresh live dirs (round-11 #1 / R12-3). false = at
   * least one sidecar could not be restored; the caller must NOT clear the
   * pending store after actorThink (keep it retryable next provision) and should
   * not promise the agent it can read that sidecar.
   */
  sidecarRestoreOk: boolean
  /**
   * The pending conflict sidecars that could NOT be re-materialized this
   * provision, each tagged with WHY (P2/P3). The notice lists these WITHOUT a
   * "read it" instruction; "transient" ones promise a later-turn retry while
   * "permanent" ones (missing/corrupt payload) do not. Empty when
   * sidecarRestoreOk is true.
   */
  failedSidecars: SidecarRestoreFailure[]
}
