import { ToolDefinition } from '@synapse/shared';

export interface BuiltinPluginHandler {
  getTools(): ToolDefinition[];
  execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string>;
}

const registry = new Map<string, BuiltinPluginHandler>();

export function registerBuiltinHandler(pluginSlug: string, handler: BuiltinPluginHandler): void {
  registry.set(pluginSlug, handler);
}

export function getBuiltinHandler(pluginSlug: string): BuiltinPluginHandler | undefined {
  return registry.get(pluginSlug);
}

export function hasBuiltinHandler(pluginSlug: string): boolean {
  return registry.has(pluginSlug);
}

export function initBuiltinRegistry(): void {
  // Import and register all builtin handlers
  // Vision is imported dynamically to avoid circular deps
  import('./vision.js').then(mod => {
    registerBuiltinHandler('vision', mod.visionHandler);
  });
}
