// Tool provenance & routing — Layer A (Tool Identity) + projections.
//
// `ToolRef` is the in-process structured identity of a projected tool. It exists
// BEFORE any model request (minted at projection time), with a DETERMINISTIC
// `toolId` so that per-round wireName→toolId snapshots are interpretable across
// turns and processes. It is NEVER keyed by the per-call UUID (that is the
// tool_calls.id minted only AFTER the SDK returns).
//
// Two halves with two different audiences:
//   - `source`  = PUBLIC provenance (safe for the model-facing/audit surface).
//   - `binding` = ROUTE-ONLY coordinates (instanceKey, tunnel, dispatch). NEVER
//     leaves the API process — not into provider requests, not into metadata.
//
// See docs/tool-provenance-and-routing.md and the plan §1.

import type { ProviderType, ToolDefinition } from "../types/index.js"
import { type ToolSourceKind } from "./kinds.js"

// ---------------------------------------------------------------------------
// Source (public provenance) — discriminated by kind.
// ---------------------------------------------------------------------------

export type ToolSource =
  | { kind: "system"; registryKey: string }
  | { kind: "plugin"; installationId: string; upstreamToolName: string }
  | {
      kind: "device"
      deviceToolId: string
      exposureStableKey: string
      deviceName?: string
    }

// Route-only binding coordinates. Never serialized outward.
export type ToolBinding =
  | { transport: "in_process"; dispatch: "action" | "callable" }
  | { transport: "stdio" | "http" | "sse"; instanceKey: string }
  | {
      transport: "device_tunnel"
      deviceId: string
      deviceServiceId: string
      deviceCapabilityId: string
      deviceExposureId: string
      deviceToolRevisionId?: string
    }

export interface ToolRef {
  /** Deterministic, source-owned, stable across turns/processes. */
  toolId: string
  source: ToolSource
  binding: ToolBinding
  identity: { stableKey: string; revisionId?: string }
}

// ---------------------------------------------------------------------------
// Deterministic toolId construction (finding #1 — never randomUUID).
// ---------------------------------------------------------------------------

export function systemToolId(registryKey: string): string {
  return `system:${registryKey}`
}
export function pluginToolId(
  installationId: string,
  upstreamToolName: string
): string {
  return `plugin:${installationId}:${upstreamToolName}`
}
export function deviceToolId(deviceToolsId: string): string {
  return `device:${deviceToolsId}`
}

// ---------------------------------------------------------------------------
// Snapshot frozen onto the tool_calls audit row (Layer C). Immutable: it must
// remain fully readable after the source entity is hard-purged, so it carries
// the whole discriminated public source, not just an id.
// ---------------------------------------------------------------------------

export type SourceSnapshot = ToolSource

export function stripForAuditSnapshot(ref: ToolRef): SourceSnapshot {
  // The audit snapshot IS the public source — a structural clone keeps it
  // decoupled from the live ref object.
  switch (ref.source.kind) {
    case "system":
      return { kind: "system", registryKey: ref.source.registryKey }
    case "plugin":
      return {
        kind: "plugin",
        installationId: ref.source.installationId,
        upstreamToolName: ref.source.upstreamToolName,
      }
    case "device":
      return {
        kind: "device",
        deviceToolId: ref.source.deviceToolId,
        exposureStableKey: ref.source.exposureStableKey,
        ...(ref.source.deviceName !== undefined
          ? { deviceName: ref.source.deviceName }
          : {}),
      }
  }
}

// ---------------------------------------------------------------------------
// Public result-origin projection. Result origins span the routed families
// PLUS provider_native (SDK server tools) and model_response (media ingest),
// which never carry a ToolRef. `toPublicOrigin` covers only the routed three;
// the union itself admits the extra kinds for the non-ToolRef paths.
//
// NOTE (Phase 1 naming): named `PublicToolOrigin` to avoid colliding with the
// legacy `ToolResultOrigin` still living in types/index.ts. Phase 4 converges
// the canonical `ToolResultOrigin` onto this shape and drops the legacy union.
// ---------------------------------------------------------------------------

export const PUBLIC_TOOL_ORIGIN_KINDS = [
  "system",
  "plugin",
  "device",
  "provider_native",
  "model_response",
] as const
export type PublicToolOriginKind = (typeof PUBLIC_TOOL_ORIGIN_KINDS)[number]

export type PublicToolOrigin =
  | { kind: "system"; registryKey: string }
  | { kind: "plugin"; installationId: string; upstreamToolName: string }
  | {
      kind: "device"
      deviceToolId: string
      exposureStableKey: string
      deviceName?: string
    }
  | { kind: "provider_native"; providerType: ProviderType; toolName: string }
  | { kind: "model_response"; providerType: ProviderType }

/** Project a routed ToolRef onto its public result origin (no binding). */
export function toPublicOrigin(ref: ToolRef): PublicToolOrigin {
  switch (ref.source.kind) {
    case "system":
      return { kind: "system", registryKey: ref.source.registryKey }
    case "plugin":
      return {
        kind: "plugin",
        installationId: ref.source.installationId,
        upstreamToolName: ref.source.upstreamToolName,
      }
    case "device":
      return {
        kind: "device",
        deviceToolId: ref.source.deviceToolId,
        exposureStableKey: ref.source.exposureStableKey,
        ...(ref.source.deviceName !== undefined
          ? { deviceName: ref.source.deviceName }
          : {}),
      }
  }
}

export function originKindToSourceKind(
  kind: PublicToolOriginKind
): ToolSourceKind | null {
  return kind === "system" || kind === "plugin" || kind === "device"
    ? kind
    : null
}

// ---------------------------------------------------------------------------
// stripForProvider — produce the model-facing ToolDefinition. Takes the
// definition + ref + chosen wire name (finding #5: a ToolRef alone has no
// description/schema). The returned ToolDefinition carries NO source/binding.
// ---------------------------------------------------------------------------

export function stripForProvider(input: {
  definition: ToolDefinition
  wireName: string
}): ToolDefinition {
  const { definition, wireName } = input
  return {
    name: wireName,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.rawInputSchema !== undefined
      ? { rawInputSchema: definition.rawInputSchema }
      : {}),
  }
}
