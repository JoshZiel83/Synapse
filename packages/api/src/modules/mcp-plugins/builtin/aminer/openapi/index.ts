import type { BuiltinPluginHandler } from "../../index.js";
import {
  aminerToolDefinitions,
  executeAminerTool,
} from "./tool-specs.js";

export const aminerOpenapiHandler: BuiltinPluginHandler = {
  getTools() {
    return aminerToolDefinitions;
  },

  async execute(toolName, input, config) {
    return executeAminerTool(toolName, input, config);
  },
};
