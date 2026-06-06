// Tool provenance & routing — public barrel.
// See docs/tool-provenance-and-routing.md and the plan §1.

export {
  TOOL_SOURCE_KINDS,
  type ToolSourceKind,
} from "./kinds.js"

export {
  type ToolSource,
  type ToolBinding,
  type ToolRef,
  type SourceSnapshot,
  type PublicToolOrigin,
  type PublicToolOriginKind,
  PUBLIC_TOOL_ORIGIN_KINDS,
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
