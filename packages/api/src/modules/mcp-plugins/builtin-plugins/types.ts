import type { McpValidationRule, McpSetupStep } from '@synapse/shared';

export interface BuiltinPluginSeed {
  slug: string;
  displayName: string;
  description: string;
  longDescription?: string;
  transport: string;
  entryPoint: string;
  lifecycleScope: string;
  tags: string[];
  toolsManifest: unknown[];
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
}

export interface BuiltinOrgSeed {
  slug: string;
  displayName: string;
  description: string;
  plugins: BuiltinPluginSeed[];
}
