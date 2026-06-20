// Tool provenance & routing — Layer 0 vocabulary.
//
// `TOOL_SOURCE_KINDS` is the single ROUTED-family axis (system | plugin | device).
//
// See docs/design-archive/tool-provenance-and-routing.md (archived design;
// current truth: docs/tool-source-classification-audit-2026-06-20.md).

export const TOOL_SOURCE_KINDS = ["system", "plugin", "device"] as const
export type ToolSourceKind = (typeof TOOL_SOURCE_KINDS)[number]
