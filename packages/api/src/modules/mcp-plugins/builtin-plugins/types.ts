import type { McpValidationRule, McpSetupStep } from '@synapse/shared';
import type { CapabilityGrantScope } from '@synapse/shared';

export interface BuiltinPluginSeed {
  slug: string;
  displayName: string;
  description: string;
  longDescription?: string;
  transport: string;
  entryPoint: string;
  defaultBindingScope: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation';
  defaultReuseScope: 'turn' | 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation';
  requiresHandshake?: boolean;
  tags: string[];
  toolsManifest: unknown[];
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  authorization?: {
    requiredPermissions?: string[];
    defaultGrantScope?: CapabilityGrantScope;
    reason?: string;
  };
}

export interface BuiltinOrgSeed {
  slug: string;
  displayName: string;
  description: string;
  plugins: BuiltinPluginSeed[];
}
