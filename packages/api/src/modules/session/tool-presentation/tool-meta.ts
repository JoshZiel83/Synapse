// Phase 2 — result-data contract: normalize each tool family's structured
// result into a single `tool_results.metadata.toolMeta` namespace that the
// presentation renderer reads via ResultRef `meta.*`.
//
// Why a namespace: today MCP `_meta` is dropped, device `_meta` is forwarded
// flat, and callable `res.metadata` is spread at the top level of
// tool_results.metadata. The renderer needs ONE predictable place to read
// structured result fields without colliding with existing top-level keys
// (origin / structuredContent / isError / synapse_error / toolCallId / ...).
//
// This helper is the single producer of that namespace. It MUST be additive:
// callers keep writing their existing top-level metadata fields unchanged.

import { parseJsonObjectOrUndefined } from "@synapse/shared"

/** Reserved top-level metadata keys that are NOT tool result data. */
const RESERVED_TOP_LEVEL = new Set([
  "origin",
  "structuredContent",
  "isError",
  "toolCallId",
  "toolName",
  "providerCallId",
  "synapse_error",
  "toolMeta",
])

// Business JSON decode → shared parseJsonObjectOrUndefined (object-only,
// array-reject, undefined fallback). r6 P1-8: replaces a local copy.
const asRecord = parseJsonObjectOrUndefined

/**
 * Build the `toolMeta` object from a tool family's structured outputs.
 *
 * - device / MCP: the forwarded `_meta` (NormalizedMcpToolResult.metadata) and,
 *   when present, the MCP-standard `structuredContent` are merged (structured
 *   content wins on key collision — it's the more official structured result).
 * - callable: pass the plugin's `res.metadata` as `meta`; its non-reserved keys
 *   become toolMeta.
 *
 * Returns undefined when there is nothing structured to expose (so callers can
 * omit the key entirely rather than write an empty object).
 */
export function buildToolMeta(input: {
  meta?: unknown
  structuredContent?: unknown
}): Record<string, unknown> | undefined {
  const meta = asRecord(input.meta)
  const structured = asRecord(input.structuredContent)
  const out: Record<string, unknown> = {}
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (!RESERVED_TOP_LEVEL.has(k)) out[k] = v
    }
  }
  if (structured) {
    for (const [k, v] of Object.entries(structured)) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
