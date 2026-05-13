import type { BuiltinPluginHandler } from "../../index.js"
import { amapToolDefinitions, executeAmapTool } from "./tool-specs.js"

export const amapOpenapiHandler: BuiltinPluginHandler = {
  getTools() {
    return amapToolDefinitions
  },

  async execute(toolName, input, config) {
    return executeAmapTool(toolName, input, config)
  },
}
