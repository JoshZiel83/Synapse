// Display-time presentation resolver.
//
// Given a persisted tool_calls row's (source_kind, source_snapshot), resolve the
// CURRENT presentation descriptor by following the source — never by parsing the
// wire name. Dispatch key = source_snapshot.stableKey (frozen at creation, K1).
//
// Cascade by source_kind:
//   system  → in-process registry (getToolPlugin) by registryKey
//   device  → builtin leaf (BUILTIN_PRESENTATION) by stableKey  [builtins]
//   plugin  → live catalog tool_manifest.synapse.presentation by installation
//   (anything not found) → genericDescriptor(stableKey)
//
// Returns a descriptor (never throws); a missing/soft-deleted source degrades to
// the generic descriptor so historical rows render stably.

import type { ToolPresentationDescriptor } from "@synapse/device-protocol/tool-presentation"
import { parseToolPresentation } from "@synapse/device-protocol/tool-presentation/schema"
import { BUILTIN_PRESENTATION } from "@synapse/device-runtime/builtin-presentation"
import { parseJsonObjectOrUndefined } from "@synapse/shared"
import { getToolPlugin } from "../../ai/tool-plugins.js"
import { selectPluginToolManifest } from "./repo.js"
import { genericDescriptor } from "./render.js"

const asRecord = parseJsonObjectOrUndefined

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/**
 * Reconstruct the dispatch stableKey. Prefer the frozen snapshot value (K1);
 * fall back to deriving it from the discriminated source fields for older rows
 * written before stableKey was persisted.
 */
export function stableKeyFromSnapshot(
  sourceKind: unknown,
  snapshot: unknown
): string | undefined {
  const snap = asRecord(snapshot) ?? {}
  const frozen = str(snap.stableKey)
  if (frozen) return frozen
  if (sourceKind === "system") return str(snap.registryKey)
  if (sourceKind === "device") {
    const exposure = str(snap.exposureStableKey)
    const visible = str(snap.visibleToolName)
    return exposure && visible ? `${exposure}/${visible}` : undefined
  }
  if (sourceKind === "plugin") {
    const pub = str(snap.publisherSlug)
    const item = str(snap.itemSlug)
    const upstream = str(snap.upstreamToolName)
    return pub && item && upstream
      ? `plugin/${pub}/${item}/${upstream}`
      : undefined
  }
  return undefined
}

// Resolve a plugin tool's descriptor from the CURRENT catalog manifest, via the
// live (soft-delete-aware) installation → catalog version → tool manifest. Only
// an explicit `synapse.presentation` on the matching manifest entry is honored.
async function resolvePluginPresentation(
  installationId: string | null,
  snapshot: Record<string, unknown>
): Promise<ToolPresentationDescriptor | null> {
  if (!installationId) return null
  const upstream = str(snapshot.upstreamToolName)
  if (!upstream) return null
  const toolManifest = await selectPluginToolManifest(installationId)
  if (toolManifest === null) return null
  const manifest = Array.isArray(toolManifest) ? toolManifest : []
  for (const entry of manifest) {
    const rec = asRecord(entry)
    if (!rec) continue
    if (str(rec.name) !== upstream && str(rec.toolName) !== upstream) continue
    const synapse = asRecord(rec.synapse)
    const presentation = synapse?.presentation ?? rec.presentation
    return parseToolPresentation(presentation)
  }
  return null
}

export interface ResolvePresentationInput {
  sourceKind: unknown
  sourceSnapshot: unknown
  pluginInstallationId?: string | null
}

/**
 * Resolve the descriptor for one tool_calls row. Never throws — always returns a
 * usable descriptor (generic fallback when no co-located/manifest descriptor is
 * found, e.g. unknown MCP tool or soft-deleted source).
 */
export async function resolveToolPresentation(
  input: ResolvePresentationInput
): Promise<ToolPresentationDescriptor> {
  const snap = asRecord(input.sourceSnapshot) ?? {}
  const stableKey =
    stableKeyFromSnapshot(input.sourceKind, input.sourceSnapshot) ?? "unknown"

  if (input.sourceKind === "system") {
    const plugin = getToolPlugin(stableKey)
    if (plugin?.presentation) return plugin.presentation
    return genericDescriptor(stableKey)
  }

  if (input.sourceKind === "device") {
    return BUILTIN_PRESENTATION[stableKey] ?? genericDescriptor(stableKey)
  }

  if (input.sourceKind === "plugin") {
    const fromManifest = await resolvePluginPresentation(
      input.pluginInstallationId ?? null,
      snap
    )
    return fromManifest ?? genericDescriptor(stableKey)
  }

  return genericDescriptor(stableKey)
}
