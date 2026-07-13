// dispatchBareRuntimeTool — the PURE dispatch fork for Mode-B (bare) sandboxes
// (§4.2 / §4.7.1.1). It is keyed STRICTLY on `runtime_services.service_kind=
// 'bare_dataplane'` (surfaced as the S1 `serviceKind` discriminant on the
// projection row / auto-retry target). The fork is CLOSED OVER ABSENCE: only a
// bare adapter's create() ever mints a bare_dataplane service and links exposures
// to it, so every device/resident builtin exposure projects
// serviceKind='device_runtime' and NEVER reaches here (F-B). Everything ABOVE the
// fork (claim / matchers / envelope-sign / ledger-open) is unchanged; this branch
// replaces ONLY the network hop dispatchSyncTool would have made — there is no
// tunnel endpoint, no registry entry, and the endpoint scheme is non-dialable.

import { join } from "node:path"
import type { OperationEnvelope } from "@synapse/device-protocol"
import { fromExternalRfc3339 } from "@synapse/device-protocol/instant"
import { STORAGE_DIR } from "../../infrastructure/storage/index.js"
import { config } from "../../config/index.js"
import { adapterForRow } from "./adapter-registry.js"
import { SandboxBackendError } from "./sandbox-backend.js"
import type { McpDispatchResult } from "../devices/dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import {
  getBareSandboxForDispatch,
  verifyBareDispatchTarget,
  type Executor,
} from "./repo.js"
import {
  coreInvokeBarePlane,
  createLocalBareDataPlane,
  createDockerBareDataPlane,
  deriveConfinementScope,
  deriveConfinementAccess,
  EmptyScopeDeniedError,
  type ConfinementCtx,
  type SandboxDataPlane,
} from "./data-plane.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

// ── live plane registry ───────────────────────────────────────────────────────
// Keyed by runtimeId, populated by the bare adapter's create() and drained on
// teardown. A registry HIT means the plane is live (teardown always unregisters),
// so the hot path never touches the DB. A MISS is the ONLY place the lazy
// rebuild-on-restart runs — never a registry-first gate (preservation #2).
const liveBarePlanes = new Map<string, SandboxDataPlane>()

// P1.3(b): singleflight the lazy rebuild-on-miss. Two concurrent misses for the
// same runtime must NOT each build a plane — the second liveBarePlanes.set would
// overwrite the first, orphaning the first plane's child process past teardown
// (teardown only unregisters the plane it knows about). One in-flight promise per
// runtimeId; the body does a compare-and-set + disposes any loser.
const inflightBareRebuilds = new Map<
  string,
  Promise<{ plane: SandboxDataPlane } | { deny: McpDispatchResult }>
>()

// R3.3 (rebuild/teardown race — generation fence). A teardown that unregisters a
// plane MUST invalidate any rebuild that started BEFORE the unregister but whose
// compare-and-set has not yet fired (the rebuild's async factory window). Each
// unregister bumps a per-runtimeId generation; the singleflighted rebuild
// captures the generation at START and, in ONE synchronous span immediately
// before its compare-and-set, re-checks that the generation is UNCHANGED — else it
// disposes the built plane and denies. A kill() writes no DB, so the DB re-read
// alone can't catch this window; the fence is what makes it fail closed.
const bareTeardownGen = new Map<string, number>()

// R3.7 (teardown close-gate — in-process tombstone). While teardownSandbox is
// stopping a runtime, its id sits in this set so NO new dispatch in THIS process
// starts a plane for it (the DB state='closing' gate closes the cross-process
// window; this closes the same-process TOCTOU between the DB read and the
// compare-and-set). Cleared in teardown's finally.
const closingBarePlanes = new Set<string>()

// R3.2 (target-confusion, SECURITY). A bare data-plane endpoint is only a SCHEME
// discriminant — local:bare ⇒ `inprocess:<runtimeId>`, docker:bare ⇒
// `docker-exec:<containerId>`. The docker container id is bound to the
// AUTHORITATIVE `sandboxes.resource_id`, never sliced out of the free-string
// endpoint, so a hand-edited endpoint can't redirect the docker-exec plane at an
// arbitrary container. An unknown adapter, a scheme/adapter mismatch, an
// endpoint that doesn't bind its resource id, or a null endpoint is row
// CORRUPTION — fail closed, never fall through to the in-process local plane.
function bareTargetIdentityOk(row: {
  adapter: string
  runtimeId: string
  resourceId: string | null
  dataPlaneEndpoint: string | null
}): boolean {
  if (row.adapter === "docker") {
    return (
      !!row.resourceId &&
      row.dataPlaneEndpoint === `docker-exec:${row.resourceId}`
    )
  }
  if (row.adapter === "local") {
    return row.dataPlaneEndpoint === `inprocess:${row.runtimeId}`
  }
  if (row.adapter === "cubesandbox") {
    // R3.2: the off-box sandbox id is the AUTHORITATIVE `sandboxes.resource_id`,
    // bound into the endpoint as `envd:${resource_id}` — NEVER endpoint.slice, so
    // a hand-edited endpoint can't redirect the remote plane at another sandbox.
    return (
      !!row.resourceId && row.dataPlaneEndpoint === `envd:${row.resourceId}`
    )
  }
  return false
}

export function registerBareDataPlane(
  runtimeId: string,
  plane: SandboxDataPlane
): void {
  liveBarePlanes.set(runtimeId, plane)
}

export function unregisterBareDataPlane(
  runtimeId: string
): SandboxDataPlane | undefined {
  const plane = liveBarePlanes.get(runtimeId)
  liveBarePlanes.delete(runtimeId)
  // R3.3: invalidate any in-flight rebuild that started before this unregister.
  bareTeardownGen.set(runtimeId, (bareTeardownGen.get(runtimeId) ?? 0) + 1)
  return plane
}

export function getLiveBareDataPlane(
  runtimeId: string
): SandboxDataPlane | undefined {
  return liveBarePlanes.get(runtimeId)
}

/**
 * R3.7 close-gate: mark a runtime's bare plane as tearing down so no new dispatch
 * (HIT or rebuild) in THIS process resurrects a plane while teardown stops the
 * writer. Idempotent. Paired with {@link clearBareDataPlaneClosing} in teardown's
 * finally. The persisted state='closing' keeps denying cross-process rebuilds
 * after the tombstone clears.
 */
export function markBareDataPlaneClosing(runtimeId: string): void {
  closingBarePlanes.add(runtimeId)
}

/** R3.7: clear the close-gate tombstone (teardown finally, both branches). */
export function clearBareDataPlaneClosing(runtimeId: string): void {
  closingBarePlanes.delete(runtimeId)
}

/** Test-only: drop every live plane + fence/tombstone (isolation between tests). */
export function __clearBareDataPlanes(): void {
  liveBarePlanes.clear()
  bareTeardownGen.clear()
  closingBarePlanes.clear()
}

function sandboxRootForSession(sessionId: string): string {
  return join(STORAGE_DIR, "sandboxes", sessionId)
}

export interface DispatchBareRuntimeToolInput {
  runtimeId: string
  runtimeServiceId: string
  /** The API-signed envelope (already minted above the fork). */
  envelope: OperationEnvelope
  args: Record<string, unknown>
  builtinKind: string | null
  /** Visible tool name (e.g. "fs_read", "bash"). */
  toolName: string
  /** The claimed grant record (never re-parsed from the envelope). */
  grant: RuntimeAuthorizationGrantRecord
  /**
   * The active sandbox substrate name (P2). Defaults to config.sandbox.provider.
   * When "none" the substrate is disabled and this (kind='sandbox') dispatch is
   * refused. A test seam so a provider can be forced independent of ambient env.
   */
  sandboxProvider?: string
  /** Test seams. */
  now?: () => number
  run?: Executor
  /** Rebuild factory (default: scheme-forked local:bare / docker:bare plane). */
  planeFactory?: (opts: {
    /** The persisted adapter tag (row-authoritative) — forks the rebuild kind. */
    adapter: string
    sandboxRoot: string
    descriptor: SandboxCapabilityDescriptor
    /** The persisted scheme-tagged endpoint (inprocess:/docker-exec:/envd:). */
    dataPlaneEndpoint: string | null
    /** R3.2: the AUTHORITATIVE provider resource id (docker container id / sandbox id / ""). */
    resourceId: string | null
  }) => SandboxDataPlane
}

/**
 * Rebuild the correct plane kind from the persisted, scheme-tagged endpoint
 * (never live config — mode-flip safety). `docker-exec:` → a docker:bare plane
 * bound to the AUTHORITATIVE `sandboxes.resource_id` container id (R3.2 — NOT
 * endpoint.slice, so the free-string endpoint cannot select the target);
 * anything else (`inprocess:<id>`) → the in-process local:bare plane. The plane's
 * fs is host-side either way (same vfs kernel).
 */
function rebuildBarePlane(opts: {
  adapter: string
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  dataPlaneEndpoint: string | null
  resourceId: string | null
}): SandboxDataPlane {
  const endpoint = opts.dataPlaneEndpoint ?? ""
  if (endpoint.startsWith("docker-exec:")) {
    return createDockerBareDataPlane({
      sandboxRoot: opts.sandboxRoot,
      descriptor: opts.descriptor,
      // R3.2: container id from resource_id, never the endpoint string.
      containerId: opts.resourceId ?? "",
    })
  }
  if (endpoint.startsWith("envd:")) {
    // OFF-BOX (P4b): delegate the remote-plane build to the persisted adapter's
    // rebuildDataPlane (never a hardcoded fork here) — resolved row-driven via
    // adapterForRow, so the connection facts come from config but the identity
    // (resource_id) + descriptor come from the row. adapterForRow already
    // fail-closes on an unknown adapter key.
    const adapter = adapterForRow(opts.adapter, "bare")
    if (!adapter.rebuildDataPlane) {
      throw new SandboxBackendError(
        `bare adapter '${opts.adapter}' has an envd: endpoint but no rebuildDataPlane seam`
      )
    }
    return adapter.rebuildDataPlane({
      adapter: opts.adapter,
      resourceId: opts.resourceId,
      dataPlaneEndpoint: opts.dataPlaneEndpoint,
      descriptor: opts.descriptor,
      sandboxRoot: opts.sandboxRoot,
    })
  }
  return createLocalBareDataPlane({
    sandboxRoot: opts.sandboxRoot,
    descriptor: opts.descriptor,
  })
}

function errResult(
  code: "permission_denied" | "runtime_constraint" | "invalid_request",
  message: string
): McpDispatchResult {
  return { ok: false, error: { code, message } }
}

/**
 * The bare fork. Returns the SAME McpDispatchResult shape dispatchSyncTool does,
 * so `completeRuntimeOperation` + downstream handling are byte-identical.
 */
export async function dispatchBareRuntimeTool(
  input: DispatchBareRuntimeToolInput
): Promise<McpDispatchResult> {
  const now = input.now ?? Date.now

  // (0) SANDBOX_PROVIDER=none gate (P2(B)). This fork is reached ONLY for a
  // kind='sandbox' bare runtime — getBareSandboxForDispatch selects from the
  // `sandboxes` detail table, so every dispatch here is by construction a
  // sandbox dispatch. Refusing when the substrate is disabled is exactly
  // "refuse a dispatch to a kind='sandbox' runtime when provider=none",
  // defense-in-depth over the projection gate. Real devices dispatch through
  // dispatchSyncTool and never reach this code, so they are NOT gated here.
  const provider = input.sandboxProvider ?? config.sandbox.provider
  if (provider === "none") {
    return errResult(
      "runtime_constraint",
      `sandbox runtime ${input.runtimeId} is not dispatchable: SANDBOX_PROVIDER=none`
    )
  }

  // R3.7 close-gate: a runtime whose teardown is in flight (in THIS process) must
  // not start OR reuse a plane — deny at the HIT check too, not just rebuild, so a
  // dispatch racing the stop step can't run against a plane about to be disposed.
  if (closingBarePlanes.has(input.runtimeId)) {
    return errResult(
      "runtime_constraint",
      `bare sandbox ${input.runtimeId} is being torn down (dispatch refused)`
    )
  }

  // (1) Resolve the plane. HIT = live; MISS = singleflighted lazy rebuild — the
  // only place the rebuild-on-restart runs (never a registry-first gate).
  let plane = liveBarePlanes.get(input.runtimeId)
  if (!plane) {
    let inflight = inflightBareRebuilds.get(input.runtimeId)
    if (!inflight) {
      // R3.3: capture the teardown generation BEFORE the async rebuild so a
      // concurrent unregister (which bumps it) is detected at the compare-and-set.
      const genAtStart = bareTeardownGen.get(input.runtimeId) ?? 0
      inflight = (async (): Promise<
        { plane: SandboxDataPlane } | { deny: McpDispatchResult }
      > => {
        const row = await getBareSandboxForDispatch(input.runtimeId, input.run)
        // A missing row / soft-deleted runtime / non-live state / non-bare mode ⇒
        // hard runtime_constraint (mirrors no_tunnel_endpoint for resident).
        if (
          !row ||
          row.runtimeDeletedAt !== null ||
          row.state !== "active" ||
          row.mode !== "bare" ||
          !row.sessionId
        ) {
          return {
            deny: errResult(
              "runtime_constraint",
              `bare sandbox ${input.runtimeId} is not dispatchable (rebuild refused)`
            ),
          }
        }
        // P1.3(a): the persisted capability_descriptor must Zod-decode. NULL =
        // corrupt/hand-edited row (e.g. maxWriteBytes:"corrupt") — fail closed
        // rather than run the plane with a NaN/defaulted safety cap.
        if (!row.capabilityDescriptor) {
          return {
            deny: errResult(
              "runtime_constraint",
              `bare sandbox ${input.runtimeId} has an undecodable capability descriptor (rebuild refused)`
            ),
          }
        }
        // R3.2 (target-confusion, SECURITY) — supersedes the old scheme-only gate.
        // The persisted endpoint must not only carry a recognized scheme for its
        // adapter, it must BIND its authoritative resource identity: docker:bare ⇒
        // `docker-exec:${resource_id}` (resource_id non-empty), local:bare ⇒
        // `inprocess:${runtimeId}`. A null / empty / typo'd / cross-adapter /
        // wrong-container endpoint is CORRUPTION — NOT an implicit local plane on
        // the API host, and never a docker-exec plane at an attacker-chosen id.
        if (
          !bareTargetIdentityOk({
            adapter: row.adapter,
            runtimeId: input.runtimeId,
            resourceId: row.resourceId,
            dataPlaneEndpoint: row.dataPlaneEndpoint,
          })
        ) {
          return {
            deny: errResult(
              "runtime_constraint",
              `bare sandbox ${input.runtimeId} data-plane endpoint does not match adapter '${row.adapter}'/identity (rebuild refused)`
            ),
          }
        }
        const factory = input.planeFactory ?? rebuildBarePlane
        const built = factory({
          adapter: row.adapter,
          sandboxRoot: sandboxRootForSession(row.sessionId),
          descriptor: row.capabilityDescriptor,
          dataPlaneEndpoint: row.dataPlaneEndpoint,
          resourceId: row.resourceId,
        })
        // ONE synchronous span: [existing-check → fence/tombstone re-check →
        // compare-and-set]. No await between the reads and liveBarePlanes.set so a
        // teardown can only land BEFORE (caught by the re-checks) or AFTER (the
        // plane is registered and the next unregister disposes it) — never inside.
        const existing = liveBarePlanes.get(input.runtimeId)
        if (existing) {
          // P1.3(b): a concurrent miss already registered — keep that, dispose ours.
          await built.dispose().catch(() => {})
          return { plane: existing }
        }
        // R3.3 fence + R3.7 tombstone: a teardown fired (or is firing) during our
        // async build window → do NOT resurrect a plane. Dispose + deny.
        if (
          (bareTeardownGen.get(input.runtimeId) ?? 0) !== genAtStart ||
          closingBarePlanes.has(input.runtimeId)
        ) {
          await built.dispose().catch(() => {})
          return {
            deny: errResult(
              "runtime_constraint",
              `bare sandbox ${input.runtimeId} teardown raced the rebuild (dispatch refused)`
            ),
          }
        }
        liveBarePlanes.set(input.runtimeId, built)
        return { plane: built }
      })().finally(() => {
        inflightBareRebuilds.delete(input.runtimeId)
      })
      inflightBareRebuilds.set(input.runtimeId, inflight)
    }
    const resolved = await inflight
    if ("deny" in resolved) return resolved.deny
    plane = resolved.plane
  }

  // (2) Envelope expiry — checked IN-FORK (no in-sandbox verifier). This is
  // exactly where the resident device's envelope verifier would reject a stale
  // envelope (e.g. a delayed auto-retry). Route the wire string through the
  // single canonical parser (fails loud on garbage), never a bare Date.parse.
  let expiresAtMs: number
  try {
    expiresAtMs = new Date(
      fromExternalRfc3339(input.envelope.expires_at)
    ).getTime()
  } catch {
    return errResult("runtime_constraint", "envelope_expires_at_unparseable")
  }
  if (expiresAtMs <= now()) {
    return errResult("runtime_constraint", "envelope_expired")
  }

  // (3) Target-id binding — the API-signed envelope must bind to THIS runtime's
  // own catalog entry (exposure→runtime+service, tool→exposure). Rejects a
  // replayed / cross-runtime envelope before any plane call.
  const bound = await verifyBareDispatchTarget(
    {
      runtimeId: input.runtimeId,
      runtimeServiceId: input.runtimeServiceId,
      exposureId: input.envelope.runtime_exposure_id,
      toolId: input.envelope.runtime_tool_id,
      // R3.P2a — resident-parity binding. The visible tool name + the envelope's
      // tool revision + the claimed grant family must ALL re-derive to the CURRENT
      // catalog row, not merely exist. grant.capability is the authoritative family
      // (read here from the claimed grant, so both dispatch call sites agree).
      toolName: input.toolName,
      toolRevisionId: input.envelope.runtime_tool_revision_id,
      capabilityFamily: input.grant.capability,
    },
    input.run
  )
  if (!bound) {
    return errResult(
      "permission_denied",
      "envelope target does not bind to this runtime's catalog"
    )
  }

  // (4) ConfinementCtx from the claimed grant (F-C). A scoped grant that derives
  // ∅ is a HARD DENY here — BEFORE any plane/backend call.
  let ctx: ConfinementCtx
  try {
    const scope = deriveConfinementScope(input.grant)
    // P7: recover the read/write bit the scope-collapse discarded, FAIL-CLOSED —
    // 'write' requires BOTH a write-classified tool AND a grant that explicitly
    // confers write, so an unknown grant/tool can never silently mutate (see
    // deriveConfinementAccess). assertWriteAccess re-imposes it in the plane.
    const access = deriveConfinementAccess(input.grant, input.toolName)
    ctx = { scope, access }
  } catch (err) {
    if (err instanceof EmptyScopeDeniedError) {
      return errResult("permission_denied", err.message)
    }
    throw err
  }

  // (5) Canonical CORE lowering → confined plane invoke.
  return coreInvokeBarePlane({
    plane,
    builtinKind: input.builtinKind,
    toolName: input.toolName,
    args: input.args,
    ctx,
  })
}
