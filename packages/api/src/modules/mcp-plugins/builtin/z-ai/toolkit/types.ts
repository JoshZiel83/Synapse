import type { ToolDefinition } from "@synapse/shared"
import type { BuiltinPluginExecuteResult } from "../../index.js"

export interface SubFeature {
  featureKey: string
  getTools(): ToolDefinition[]
  execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult>
}
