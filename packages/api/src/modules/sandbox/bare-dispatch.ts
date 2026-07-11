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
  return plane
}

export function getLiveBareDataPlane(
  runtimeId: string
): SandboxDataPlane | undefined {
  return liveBarePlanes.get(runtimeId)
}

/** Test-only: drop every live plane (isolation between unit tests). */
export function __clearBareDataPlanes(): void {
  liveBarePlanes.clear()
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
    sandboxRoot: string
    descriptor: SandboxCapabilityDescriptor
    /** The persisted scheme-tagged endpoint (inprocess:/docker-exec:). */
    dataPlaneEndpoint: string | null
  }) => SandboxDataPlane
}

/**
 * Rebuild the correct plane kind from the persisted, scheme-tagged endpoint
 * (never live config — mode-flip safety). `docker-exec:<cid>` → a docker:bare
 * plane bound to that container; anything else (`inprocess:<id>`) → the in-process
 * local:bare plane. The plane's fs is host-side either way (same vfs kernel).
 */
function rebuildBarePlane(opts: {
  sandboxRoot: string
  descriptor: SandboxCapabilityDescriptor
  dataPlaneEndpoint: string | null
}): SandboxDataPlane {
  const endpoint = opts.dataPlaneEndpoint ?? ""
  if (endpoint.startsWith("docker-exec:")) {
    const containerId = endpoint.slice("docker-exec:".length)
    return createDockerBareDataPlane({
      sandboxRoot: opts.sandboxRoot,
      descriptor: opts.descriptor,
      containerId,
    })
  }
  return createLocalBareDataPlane({
    sandboxRoot: opts.sandboxRoot,
    descriptor: opts.descriptor,
  })
}

/**
 * The bare data-plane endpoint schemes rebuildBarePlane recognizes:
 * `docker-exec:<cid>` → a docker:bare plane; `inprocess:<id>` → the local:bare
 * plane. ANYTHING else — null / empty / a typo / a future DIALABLE scheme like
 * `https:` — is row CORRUPTION, NOT an implicit local plane on the API host.
 * Kept in lockstep with rebuildBarePlane's fork so the fail-closed guard (P8A)
 * and the (TOTAL, never-throwing) rebuild can never disagree on what "local"
 * means. An empty endpoint is corruption, not a fall-through to local.
 */
function isRecognizedBarePlaneEndpoint(endpoint: string | null): boolean {
  return (
    endpoint !== null &&
    (endpoint.startsWith("docker-exec:") || endpoint.startsWith("inprocess:"))
  )
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

  // (1) Resolve the plane. HIT = live; MISS = lazy rebuild (this branch only).
  let plane = liveBarePlanes.get(input.runtimeId)
  if (!plane) {
    const row = await getBareSandboxForDispatch(input.runtimeId, input.run)
    // A missing row / soft-deleted runtime / non-live state / non-bare mode ⇒
    // hard runtime_constraint (mirrors no_tunnel_endpoint for the resident path).
    if (
      !row ||
      row.runtimeDeletedAt !== null ||
      row.state !== "active" ||
      row.mode !== "bare" ||
      !row.sessionId
    ) {
      return errResult(
        "runtime_constraint",
        `bare sandbox ${input.runtimeId} is not dispatchable (rebuild refused)`
      )
    }
    // P8(A): the persisted data-plane endpoint MUST carry a recognized,
    // non-dialable scheme. A null / empty / typo'd / future 'https:' endpoint is
    // CORRUPTION — NOT an implicit local plane. Without this guard
    // rebuildBarePlane's else-branch silently falls through to the LOCAL plane
    // and executes on the API host. Fail-closed here (rebuildBarePlane stays
    // TOTAL for the recognized set — a raw throw there would escape the
    // McpDispatchResult contract).
    if (!isRecognizedBarePlaneEndpoint(row.dataPlaneEndpoint)) {
      return errResult(
        "runtime_constraint",
        `bare sandbox ${input.runtimeId} has an unrecognized data-plane endpoint scheme (rebuild refused)`
      )
    }
    const descriptor =
      row.capabilityDescriptor as unknown as SandboxCapabilityDescriptor
    const factory = input.planeFactory ?? rebuildBarePlane
    plane = factory({
      sandboxRoot: sandboxRootForSession(row.sessionId),
      descriptor,
      dataPlaneEndpoint: row.dataPlaneEndpoint,
    })
    liveBarePlanes.set(input.runtimeId, plane)
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
