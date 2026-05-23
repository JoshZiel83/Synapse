import { textBlocks } from "@synapse/shared"
import type {
  BuiltinPluginExecuteResult,
  BuiltinPluginHandler,
} from "../../index.js"
import { amapToolDefinitions, executeAmapTool } from "./tool-specs.js"

export const amapOpenapiHandler: BuiltinPluginHandler = {
  getTools() {
    return amapToolDefinitions
  },

  async execute(toolName, input, config): Promise<BuiltinPluginExecuteResult> {
    return textBlocks(await executeAmapTool(toolName, input, config))
  },
}
