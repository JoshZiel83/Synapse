import type {
  CallableToolResult,
  CanonicalContentBlock,
  ToolDefinition,
} from "@synapse/shared"

/**
 * Allowed return shapes for built-in plugin handlers (and sub-features).
 * The downstream normalizeMcpToolResult understands both:
 *  - `CanonicalContentBlock[]` → array form, passed through the ingest funnel
 *  - `CallableToolResult` envelope `{content, isError?, structuredContent?, metadata?}` →
 *    full MCP-like result, structuredContent + isError preserved
 *
 * Plain strings are NOT permitted at the type level — authors must wrap text
 * with `textBlocks(...)` or `textResult(...)` from `@synapse/shared`. The
 * runtime normalizer still accepts strings defensively for malformed third-
 * party returns, but the typed surface forces canonical content blocks at
 * the handler boundary.
 *
 * Was `Promise<unknown>` before Phase 7c, which let handlers leak typed
 * bugs through to runtime normalization.
 */
export type BuiltinPluginExecuteResult =
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
  // aminer/openapi, amap/openapi, and mijia/smarthome are now remote MCP
  // plugins (transport sse/http proxying official servers / the mijia-mcp
  // sidecar) — no in-process handler.

  // The Mijia plugin proxies a multi-tenant sidecar over http: its stored
  // secretPayload is the internal MijiaAuthState, but the sidecar expects the
  // upstream mijiaAPI canonical dict. Register a serializer for the
  // mijia_qr_login driver so ${auth_b64:mijiaAccount} encodes the right shape.
  const { registerAuthSecretSerializer } =
    await import("../transports/auth-serializers.js")
  const { serializeMijiaAuthForMiot } = await import("../mijia/auth.js")
  registerAuthSecretSerializer("mijia_qr_login", serializeMijiaAuthForMiot)
}
