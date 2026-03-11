import type { ToolDefinition, ToolCall, ToolResult, ToolPlugin, ToolResolveContext } from '@synapse/shared';

/**
 * Unified Built-in Tool Plugin Registry
 *
 * Replaces the old callable-tools.ts + action tools pattern.
 * Every built-in tool is a ToolPlugin with:
 *   - kind: 'action' (terminal, dispatched by orchestrator) or 'callable' (returns result to model)
 *   - resolve(ctx): optional — determines if the tool is active and returns its (possibly dynamic) definition
 *   - execute(input): optional — for callable tools, the handler that produces the result
 */

const registry = new Map<string, ToolPlugin>();

export function registerToolPlugin(plugin: ToolPlugin): void {
  registry.set(plugin.name, plugin);
}

/**
 * Resolve active built-in tools for the given context.
 * Calls each plugin's resolve() if present; plugins without resolve are always active.
 */
export function resolveBuiltinTools(ctx: ToolResolveContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const plugin of registry.values()) {
    if (plugin.resolve) {
      const result = plugin.resolve(ctx);
      if (result.active) {
        tools.push(result.definition);
      }
    } else {
      tools.push(plugin.definition);
    }
  }
  return tools;
}

/**
 * Execute callable tool calls. Only dispatches to tools with kind='callable' and an execute handler.
 */
export async function executeCallableTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    const plugin = registry.get(tc.toolName);
    if (!plugin || plugin.kind !== 'callable' || !plugin.execute) {
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content: `Error: unknown callable tool "${tc.toolName}"`,
        isError: true,
      });
      continue;
    }
    try {
      const content = await plugin.execute(tc.input);
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content,
      });
    } catch (err: any) {
      results.push({
        toolCallId: tc.callId,
        providerCallId: tc.providerCallId,
        toolName: tc.toolName,
        content: `Error executing tool "${tc.toolName}": ${err.message}`,
        isError: true,
      });
    }
  }
  return results;
}

export function isCallableTool(name: string): boolean {
  const plugin = registry.get(name);
  return !!plugin && plugin.kind === 'callable';
}

export function isActionTool(name: string): boolean {
  const plugin = registry.get(name);
  return !!plugin && plugin.kind === 'action';
}

export function isBuiltinTool(name: string): boolean {
  return registry.has(name);
}
