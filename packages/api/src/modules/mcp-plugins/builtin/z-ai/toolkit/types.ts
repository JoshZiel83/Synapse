import { ToolDefinition } from '@synapse/shared';

export interface SubFeature {
  featureKey: string;
  getTools(): ToolDefinition[];
  execute(toolName: string, input: Record<string, unknown>, config: Record<string, unknown>): Promise<string | unknown[]>;
}
