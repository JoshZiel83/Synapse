// Tool provenance & routing — internal projected tool definition.
//
// `ProjectedToolDefinition` is the in-process shape carried from projection
// through dispatch: a ToolDefinition with a MANDATORY `ref` (Layer A identity).
// It is stripped to a plain `ToolDefinition` at the provider boundary via
// `stripForProvider` so no binding/source ever crosses to the model/audit.

import type { ToolDefinition } from "../types/index.js"
import type { ToolRef } from "./ref.js"

export interface ProjectedToolDefinition extends ToolDefinition {
  ref: ToolRef
}
