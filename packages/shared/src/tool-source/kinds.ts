// Tool provenance & routing — Layer 0 vocabulary.
//
// `TOOL_SOURCE_KINDS` is the single ROUTED-family axis (system | plugin | device).
//
// See docs/tool-provenance-and-routing.md and the plan
// (/root/.claude/plans/soft-munching-walrus.md §1).

export const TOOL_SOURCE_KINDS = ["system", "plugin", "device"] as const
export type ToolSourceKind = (typeof TOOL_SOURCE_KINDS)[number]
