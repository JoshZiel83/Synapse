import type { ToolDefinition, ToolCall, ToolResult } from '@synapse/shared';

/**
 * Callable Tool Registry
 *
 * "Callable tools" are tools whose results must be returned to the model
 * for further reasoning (e.g. MCP tools, search, code execution).
 * This is in contrast to "action tools" (respond, delegate, etc.) which
 * are terminal actions executed by the orchestrator.
 *
 * Currently registers 0 tools. MCP integration will call registerCallableTool().
 */

interface CallableToolHandler {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

const registry = new Map<string, CallableToolHandler>();

export function registerCallableTool(
  definition: ToolDefinition,
  execute: (input: Record<string, unknown>) => Promise<string>,
): void {
  registry.set(definition.name, { definition, execute });
}

export function unregisterCallableTool(name: string): void {
  registry.delete(name);
}

export function isCallableTool(name: string): boolean {
  return registry.has(name);
}

export function getCallableToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((h) => h.definition);
}

export async function executeCallableTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const tc of toolCalls) {
    const handler = registry.get(tc.name);
    if (!handler) {
      results.push({
        toolCallId: tc.id,
        toolName: tc.name,
        content: `Error: unknown callable tool "${tc.name}"`,
        isError: true,
      });
      continue;
    }
    try {
      const content = await handler.execute(tc.input);
      results.push({ toolCallId: tc.id, toolName: tc.name, content });
    } catch (err: any) {
      results.push({
        toolCallId: tc.id,
        toolName: tc.name,
        content: `Error executing tool "${tc.name}": ${err.message}`,
        isError: true,
      });
    }
  }
  return results;
}
