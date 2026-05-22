import type {
  BuiltinPluginExecuteResult,
  BuiltinPluginHandler,
} from "../../index.js"
import { FEISHU_FEATURES } from "../../../feishu/features.js"
import {
  executeFeishuTool,
  getFeishuToolDefinitions,
} from "../../../feishu/tools.js"

const allFeatureKeys = FEISHU_FEATURES.map((feature) => feature.key)

export const feishuAppHandler: BuiltinPluginHandler = {
  getTools() {
    return getFeishuToolDefinitions({
      features: allFeatureKeys,
    })
  },

  getToolsFiltered(config) {
    return getFeishuToolDefinitions(config)
  },

  async execute(toolName, input, config): Promise<BuiltinPluginExecuteResult> {
    return (await executeFeishuTool(
      toolName,
      input,
      config
    )) as BuiltinPluginExecuteResult
  },
}
