import {
  maskAllowsConversationType,
  textBlocks,
  type CallableToolResult,
  type CanonicalContentBlock,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type ToolPlugin,
  type ToolResolveContext,
} from "@synapse/shared"
import { getToolErrorMessage, getToolErrorMetadata } from "./tool-errors.js"
import { isLocalCallableToolAllowedInCollaborationMode } from "./session-plan-mode.js"
import { SYSTEM_TOOL_PRESENTATION } from "./system-tools.presentation.js"

/**
 * Local Callable Tool Registry
 *
 * Registers Synapse-owned tools that execute in-process and return a result to
 * the model. Actor business actions still exist below these tools, but they are
 * no longer a separate model tool kind.
 *
 * Every local callable tool is a ToolPlugin with:
 *   - resolve(ctx): optional — determines if the tool is active and returns its definition
 *   - execute(input): the handler that produces the result
 */

const registry = new Map<string, ToolPlugin>()

export function registerToolPlugin(plugin: ToolPlugin): void {
  // System tool names are the reserved bare-name set the NameRegistry protects;
  // a duplicate registration would silently shadow one at module load. Fail loud
  // so the collision is caught in dev, not masked at runtime.
  if (registry.has(plugin.name)) {
    throw new Error(
      `Duplicate system tool plugin registration for "${plugin.name}"`
    )
  }
  // Auto-attach the co-located presentation descriptor (single source of truth
  // in system-tools.presentation.ts) unless the plugin already declared one.
  const presentation =
    plugin.presentation ?? SYSTEM_TOOL_PRESENTATION[plugin.name]
  registry.set(plugin.name, presentation ? { ...plugin, presentation } : plugin)
}

/**
 * Look up a registered system/callable tool plugin by its registry name (which
 * is also its system stableKey). Used by the presentation display resolver to
 * fetch the tool's co-located presentation descriptor.
 */
export function getToolPlugin(name: string): ToolPlugin | undefined {
  return registry.get(name)
}

/**
 * Resolve active local callable tools for the given context.
 * Calls each plugin's resolve() if present; plugins without resolve are always active.
 */
export async function resolveLocalCallableTools(
  ctx: ToolResolveContext
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  for (const plugin of registry.values()) {
    if (
      !isLocalCallableToolAllowedInCollaborationMode(
        plugin.name,
        ctx.collaborationMode,
        ctx.conversationKind
      )
    ) {
      continue
    }
    if (
      plugin.conversationTypeMask !== undefined &&
      !maskAllowsConversationType(
        plugin.conversationTypeMask,
        ctx.conversationKind,
        ctx.isImConversation ?? false
      )
    ) {
      continue
    }
    if (plugin.resolve) {
      const result = await plugin.resolve(ctx)
      if (result.active) {
        tools.push(result.definition)
      }
    } else {
      tools.push(plugin.definition)
    }
  }
  return tools
}

// Coerce the plugin's loosely-typed return into the canonical CallableToolResult.
function coerceCallableReturn(
  ret: CallableToolResult | CanonicalContentBlock[]
): CallableToolResult {
  if (Array.isArray(ret)) {
    return { content: ret }
  }
  return ret
}

/**
 * Execute local callable tool calls. Unknown/stale model-requested names are
 * returned as model-actionable tool errors so the model can recover in-round.
 */
export async function executeCallableTools(
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const tc of toolCalls) {
    const plugin = registry.get(tc.toolName)
    if (!plugin) {
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content: textBlocks(`Error: unknown callable tool "${tc.toolName}"`),
        isError: true,
        metadata: {
          toolError: {
            kind: "model_actionable",
            code: "unknown_tool",
            retryable: true,
          },
        },
      })
      continue
    }
    try {
      const raw = await plugin.execute(tc.input)
      const result = coerceCallableReturn(raw)
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content: result.content,
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      })
    } catch (err: any) {
      const errorMessage = getToolErrorMessage(err)
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content: textBlocks(
          `Error executing tool "${tc.toolName}": ${errorMessage}`
        ),
        isError: true,
        metadata: getToolErrorMetadata(err),
      })
    }
  }
  return results
}

export function isCallableTool(name: string): boolean {
  return registry.has(name)
}
