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
//   - `binding` = ROUTE-ONLY coordinates (instanceKey, tunnel). NEVER
//     leaves the API process — not into provider requests, not into metadata.
//
// See docs/design-archive/tool-provenance-and-routing.md (archived design;
// current truth: docs/tool-source-classification-audit-2026-06-20.md).

import type {
  ToolDefinition,
  ToolResultOrigin,
  ToolResultOriginKind,
} from "../types/index.js"
import { type ToolSourceKind } from "./kinds.js"

// ---------------------------------------------------------------------------
// Source (public provenance) — discriminated by kind.
// ---------------------------------------------------------------------------

export type ToolSource =
  | { kind: "system"; registryKey: string }
  | {
      kind: "plugin"
      installationId: string
      upstreamToolName: string
      // Durable display fields so post-purge audit reads as a name, not a UUID.
      publisherSlug?: string
      itemSlug?: string
    }
  | {
      kind: "runtime"
      runtimeToolId: string
      exposureStableKey: string
      deviceName?: string
      // Durable display field (the device-visible tool name) for the same reason.
      visibleToolName?: string
    }

// Route-only binding coordinates. Never serialized outward.
export type ToolBinding =
  | { transport: "in_process" }
  | { transport: "stdio" | "http" | "sse"; instanceKey: string }
  | {
      transport: "device_tunnel"
      runtimeId: string
      runtimeServiceId: string
      runtimeCapabilityId: string
      runtimeExposureId: string
      runtimeToolRevisionId?: string
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
export function runtimeToolId(runtimeToolsId: string): string {
  return `runtime:${runtimeToolsId}`
}

// ---------------------------------------------------------------------------
// Snapshot frozen onto the tool_calls audit row (Layer C). Immutable: it must
// remain fully readable after the source entity is hard-purged, so it carries
// the whole discriminated public source, not just an id.
// ---------------------------------------------------------------------------

// The audit snapshot IS the public source plus the durable dispatch key. The
// `stableKey` (= ref.identity.stableKey) is frozen here so the display-time
// presentation resolver can dispatch a formatter without re-deriving the key
// from the discriminated source fields (which would risk drift vs the builders).
export type SourceSnapshot = ToolSource & { stableKey?: string }

export function stripForAuditSnapshot(ref: ToolRef): SourceSnapshot {
  const stableKey = ref.identity.stableKey
  // The audit snapshot IS the public source — a structural clone keeps it
  // decoupled from the live ref object.
  switch (ref.source.kind) {
    case "system":
      return { kind: "system", registryKey: ref.source.registryKey, stableKey }
    case "plugin":
      return {
        kind: "plugin",
        installationId: ref.source.installationId,
        upstreamToolName: ref.source.upstreamToolName,
        ...(ref.source.publisherSlug !== undefined
          ? { publisherSlug: ref.source.publisherSlug }
          : {}),
        ...(ref.source.itemSlug !== undefined
          ? { itemSlug: ref.source.itemSlug }
          : {}),
        stableKey,
      }
    case "runtime":
      return {
        kind: "runtime",
        runtimeToolId: ref.source.runtimeToolId,
        exposureStableKey: ref.source.exposureStableKey,
        ...(ref.source.deviceName !== undefined
          ? { deviceName: ref.source.deviceName }
          : {}),
        ...(ref.source.visibleToolName !== undefined
          ? { visibleToolName: ref.source.visibleToolName }
          : {}),
        stableKey,
      }
  }
}

// ---------------------------------------------------------------------------
// Public result-origin projection. The public origin of a tool result IS the
// shared `ToolResultOrigin` (types/index.ts): the routed families PLUS
// provider_native (SDK server tools) and model_response (media ingest), which
// never carry a ToolRef. `toPublicOrigin` covers only the routed three; the
// non-ToolRef kinds are produced directly at their ingest boundaries. There is
// no separate "PublicToolOrigin" vocabulary — that was a structural duplicate
// of ToolResultOrigin and has been collapsed to the single canonical type.
// ---------------------------------------------------------------------------

/** Project a routed ToolRef onto its public result origin (no binding). */
export function toPublicOrigin(ref: ToolRef): ToolResultOrigin {
  switch (ref.source.kind) {
    case "system":
      return { kind: "system", registryKey: ref.source.registryKey }
    case "plugin":
      return {
        kind: "plugin",
        installationId: ref.source.installationId,
        upstreamToolName: ref.source.upstreamToolName,
        ...(ref.source.publisherSlug !== undefined
          ? { publisherSlug: ref.source.publisherSlug }
          : {}),
        ...(ref.source.itemSlug !== undefined
          ? { itemSlug: ref.source.itemSlug }
          : {}),
      }
    case "runtime":
      return {
        kind: "runtime",
        runtimeToolId: ref.source.runtimeToolId,
        exposureStableKey: ref.source.exposureStableKey,
        ...(ref.source.deviceName !== undefined
          ? { deviceName: ref.source.deviceName }
          : {}),
        ...(ref.source.visibleToolName !== undefined
          ? { visibleToolName: ref.source.visibleToolName }
          : {}),
      }
  }
}

export function originKindToSourceKind(
  kind: ToolResultOriginKind
): ToolSourceKind | null {
  return kind === "system" || kind === "plugin" || kind === "runtime"
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
