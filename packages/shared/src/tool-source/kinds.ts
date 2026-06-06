// Tool provenance & routing — Layer 0 vocabulary.
//
// `TOOL_SOURCE_KINDS` is the single ROUTED-family axis (system | plugin | device).
// It is distinct from, and maps onto, the existing DB execution-kind enum
// (`tool_calls_tool_kind` = callable | mcp_plugin | mcp_device | provider_builtin)
// via `execKindForSource`. Routing/provenance code keys on the source kind;
// the DB keeps its execution-kind column unchanged (derived, not duplicated).
//
// See docs/tool-provenance-and-routing.md and the plan
// (/root/.claude/plans/soft-munching-walrus.md §1).

export const TOOL_SOURCE_KINDS = ["system", "plugin", "device"] as const
export type ToolSourceKind = (typeof TOOL_SOURCE_KINDS)[number]

// Execution kind as persisted on tool_calls.tool_kind / tool_execution_attempts.
// `provider_builtin` is reserved for SDK provider-executed server tools
// (web_search/web_fetch); those never become Synapse tool_calls today, so the
// three routed families only ever map to the first three.
export type ExecutableModelToolKind =
  | "callable"
  | "mcp_plugin"
  | "mcp_device"
  | "provider_builtin"

/**
 * Pure mapping from a routed source kind to the DB execution-kind value.
 * system  → callable   (executed in-process by the callable/ToolPlugin dispatcher)
 * plugin  → mcp_plugin  (routed through the MCP executor)
 * device  → mcp_device  (device-capability tool routed through the MCP executor)
 */
export function execKindForSource(
  kind: ToolSourceKind
): Exclude<ExecutableModelToolKind, "provider_builtin"> {
  switch (kind) {
    case "system":
      return "callable"
    case "plugin":
      return "mcp_plugin"
    case "device":
      return "mcp_device"
  }
}
