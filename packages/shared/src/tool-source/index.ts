// Tool provenance & routing — public barrel.
// See docs/design-archive/tool-provenance-and-routing.md (archived design).

export { TOOL_SOURCE_KINDS, type ToolSourceKind } from "./kinds.js"

export {
  type ToolSource,
  type ToolBinding,
  type ToolRef,
  type SourceSnapshot,
  systemToolId,
  pluginToolId,
  deviceToolId,
  stripForAuditSnapshot,
  toPublicOrigin,
  originKindToSourceKind,
  stripForProvider,
} from "./ref.js"

export {
  type NameRegistry,
  type NamePolicyItem,
  computeWireNames,
} from "./name-policy.js"

export { type ProjectedToolDefinition } from "./projected.js"
