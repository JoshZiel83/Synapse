import type {
  CallableToolResult,
  CanonicalContentBlock,
  ToolDefinition,
} from "@synapse/shared"

/**
 * Allowed return shapes for built-in plugin handlers (and sub-features).
 * The downstream normalizeMcpToolResult understands all three:
 *  - `string` → wrapped as a single text block
 *  - `CanonicalContentBlock[]` → array form, passed through the ingest funnel
 *  - `CallableToolResult` envelope `{content, isError?, structuredContent?, metadata?}` →
 *    full MCP-like result, structuredContent + isError preserved
 *
 * Was `Promise<unknown>` before Phase 7c, which let handlers leak typed
 * bugs through to runtime normalization.
 */
export type BuiltinPluginExecuteResult =
  | string
  | CanonicalContentBlock[]
  | CallableToolResult

export interface BuiltinPluginHandler {
  getTools(): ToolDefinition[]
  getToolsFiltered?(config: Record<string, unknown>): ToolDefinition[]
  execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult>
}

const registry = new Map<string, BuiltinPluginHandler>()

export function registerBuiltinHandler(
  pluginSlug: string,
  handler: BuiltinPluginHandler
): void {
  registry.set(pluginSlug, handler)
}

export function getBuiltinHandler(
  pluginSlug: string
): BuiltinPluginHandler | undefined {
  return registry.get(pluginSlug)
}

export function hasBuiltinHandler(pluginSlug: string): boolean {
  return registry.has(pluginSlug)
}

export async function initBuiltinRegistry(): Promise<void> {
  const mod = await import("./z-ai/toolkit/index.js")
  registerBuiltinHandler("z_ai/toolkit", mod.zAiToolkitHandler)
  const feishuMod = await import("./feishu/app/index.js")
  registerBuiltinHandler("feishu/app", feishuMod.feishuAppHandler)
  const aminerMod = await import("./aminer/openapi/index.js")
  registerBuiltinHandler("aminer/openapi", aminerMod.aminerOpenapiHandler)
  const amapMod = await import("./amap/openapi/index.js")
  registerBuiltinHandler("amap/openapi", amapMod.amapOpenapiHandler)
  const mijiaMod = await import("./mijia/smarthome/index.js")
  registerBuiltinHandler("mijia/smarthome", mijiaMod.mijiaSmarthomeHandler)
}
