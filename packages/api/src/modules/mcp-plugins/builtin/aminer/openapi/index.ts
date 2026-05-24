import { textBlocks } from "@synapse/shared"
import type {
  BuiltinPluginExecuteResult,
  BuiltinPluginHandler,
} from "../../index.js"
import { aminerToolDefinitions, executeAminerTool } from "./tool-specs.js"

export const aminerOpenapiHandler: BuiltinPluginHandler = {
  getTools() {
    return aminerToolDefinitions
  },

  async execute(toolName, input, config): Promise<BuiltinPluginExecuteResult> {
    return textBlocks(await executeAminerTool(toolName, input, config))
  },
}
