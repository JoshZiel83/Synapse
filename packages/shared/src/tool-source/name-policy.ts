// Tool provenance & routing — Layer B (Tool Surface) name policy.
//
// `computeWireNames` is the SINGLE owner of canonical→wire naming. It is
// ephemeral: rebuilt per (principal, surface, turn) from the projected ToolRefs.
//
// Rules (plan §1, findings #2/#4/#6):
//   - PRIMARY KEY is `toolId`, NOT the name — so two tools that share a leaf
//     name (e.g. plugin "read" + device "read") never overwrite each other.
//   - A leaf name that is globally unique across the whole batch → bare name.
//   - A leaf-name COLLISION → BOTH sides get a source-derived qualifier prefix
//     (no implicit priority; symmetric & predictable).
//   - If a qualified name still collides → append a short deterministic hash.
//   - NamePolicy is PROVIDER-SAFE itself (charset [A-Za-z0-9_-], length cap):
//     the AI SDK forwards tool.name verbatim, providers do not sanitize.
//   - `reservedNames` (e.g. provider_native web_search/web_fetch) participate
//     in collision detection but are never emitted into the registry.

import type { ToolRef } from "./ref.js"

export interface NameRegistry {
  byToolId: Map<string, { wireName: string; ref: ToolRef }>
  byWireName: Map<string, string> // wireName -> toolId
}

export interface NamePolicyItem {
  ref: ToolRef
  /** The unqualified, source-native leaf name (e.g. "read", "create_issue"). */
  leafName: string
}

// Provider tool-name charset/length. Anthropic historically capped at 64;
// OpenAI/others are at least as permissive. Use the strictest practical bound.
const MAX_WIRE_NAME_LEN = 64
const SAFE_CHARSET = /[^a-zA-Z0-9_-]/g

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(SAFE_CHARSET, "_").replace(/_+/g, "_")
  const trimmed = cleaned.replace(/^_+|_+$/g, "")
  return trimmed.length > 0 ? trimmed : "tool"
}

/** Deterministic 8-hex hash of a string (FNV-1a 32-bit, doubled). */
function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const lo = (h >>> 0).toString(16).padStart(8, "0")
  return lo.slice(0, 8)
}

/** Source-derived qualifier segment for a collided tool. */
function qualifierFor(ref: ToolRef): string {
  switch (ref.source.kind) {
    case "system":
      return "system"
    case "plugin":
      // installationId is a UUID; the upstream name is already the leaf, so the
      // installation prefix is what disambiguates two installs' same-named tool.
      return `plugin_${ref.source.installationId.slice(0, 8)}`
    case "runtime":
      return ref.source.runtimeName
        ? sanitizeSegment(ref.source.runtimeName)
        : `device_${ref.source.runtimeToolId.slice(0, 8)}`
  }
}

function clampLen(name: string): string {
  if (name.length <= MAX_WIRE_NAME_LEN) return name
  // Preserve a stable suffix hash so clamping never silently collides.
  const h = shortHash(name)
  return `${name.slice(0, MAX_WIRE_NAME_LEN - 9)}_${h}`
}

/**
 * Compute wire names for a batch of projected tools.
 *
 * @param items projected tools (system/plugin/device), keyed internally by toolId
 * @param reservedNames names that must not be produced (e.g. provider_native);
 *        they still occupy the collision space so a colliding tool gets qualified.
 */
export function computeWireNames(
  items: NamePolicyItem[],
  reservedNames: readonly string[] = []
): NameRegistry {
  const byToolId = new Map<string, { wireName: string; ref: ToolRef }>()
  const byWireName = new Map<string, string>()

  // Pass 1: tally leaf-name occurrences (sanitized), seeded with reserved names.
  const leafCounts = new Map<string, number>()
  for (const reserved of reservedNames) {
    const s = sanitizeSegment(reserved)
    leafCounts.set(s, (leafCounts.get(s) ?? 0) + 1)
  }
  const sanitizedLeaf = new Map<string, string>() // toolId -> sanitized leaf
  for (const item of items) {
    const leaf = sanitizeSegment(item.leafName)
    sanitizedLeaf.set(item.ref.toolId, leaf)
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1)
  }

  // Pass 2: assign. Unique leaf → bare; collided → qualified; clamp + final
  // de-dup against already-assigned wire names (handles qualifier collisions).
  const assign = (toolId: string, candidate: string, ref: ToolRef) => {
    let wire = clampLen(candidate)
    if (byWireName.has(wire)) {
      wire = clampLen(`${candidate}_${shortHash(toolId)}`)
      // Extremely defensive: if even that collides, spin a counter.
      let n = 1
      while (byWireName.has(wire)) {
        wire = clampLen(`${candidate}_${shortHash(`${toolId}:${n}`)}`)
        n++
      }
    }
    byWireName.set(wire, toolId)
    byToolId.set(toolId, { wireName: wire, ref })
  }

  for (const item of items) {
    const leaf = sanitizedLeaf.get(item.ref.toolId)!
    const collided = (leafCounts.get(leaf) ?? 0) > 1
    const candidate = collided ? `${qualifierFor(item.ref)}__${leaf}` : leaf
    assign(item.ref.toolId, candidate, item.ref)
  }

  return { byToolId, byWireName }
}
