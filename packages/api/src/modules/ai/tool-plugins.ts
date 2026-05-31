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
import { isBuiltinToolAllowedInCollaborationMode } from "./session-plan-mode.js"

/**
 * Unified Built-in Tool Plugin Registry
 *
 * Replaces the old callable-tools.ts + action tools pattern.
 * Every built-in tool is a ToolPlugin with:
 *   - kind: 'action' (terminal, dispatched by orchestrator) or 'callable' (returns result to model)
 *   - resolve(ctx): optional — determines if the tool is active and returns its (possibly dynamic) definition
 *   - execute(input): optional — for callable tools, the handler that produces the result
 */

const registry = new Map<string, ToolPlugin>()

export function registerToolPlugin(plugin: ToolPlugin): void {
  registry.set(plugin.name, plugin)
}

/**
 * Resolve active built-in tools for the given context.
 * Calls each plugin's resolve() if present; plugins without resolve are always active.
 */
export async function resolveBuiltinTools(
  ctx: ToolResolveContext
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  for (const plugin of registry.values()) {
    if (
      !isBuiltinToolAllowedInCollaborationMode(
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
 * Execute callable tool calls. Only dispatches to tools with kind='callable' and an execute handler.
 */
export async function executeCallableTools(
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const tc of toolCalls) {
    const plugin = registry.get(tc.toolName)
    if (!plugin || plugin.kind !== "callable" || !plugin.execute) {
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
  const plugin = registry.get(name)
  return !!plugin && plugin.kind === "callable"
}

export function isActionTool(name: string): boolean {
  const plugin = registry.get(name)
  return !!plugin && plugin.kind === "action"
}

export function isBuiltinTool(name: string): boolean {
  return registry.has(name)
}
