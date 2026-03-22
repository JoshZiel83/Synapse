import type {
  AccessGrantScope,
} from '@synapse/shared/types';
import type {
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginInstallFlow,
  ReuseScope,
  LocalizedText,
  McpSetupStep,
  McpValidationRule,
} from '@synapse/shared';

export interface BuiltinPluginSeed {
  slug: string;
  displayName: string;
  displayNameI18n?: LocalizedText;
  description: string;
  descriptionI18n?: LocalizedText;
  longDescription?: string;
  longDescriptionI18n?: LocalizedText;
  summaryI18n?: LocalizedText;
  defaultLocale?: string;
  transport: string;
  entryPoint: string;
  defaultInstanceScope: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  defaultReuseScope: ReuseScope;
  requiresHandshake?: boolean;
  tags: string[];
  categorySlugs?: string[];
  iconAssetPath?: string;
  toolsManifest: unknown[];
  configSchema?: Record<string, unknown>;
  configFields?: PluginConfigFieldDefinition[];
  defaultConfig?: Record<string, unknown>;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  installFlow?: PluginInstallFlow;
  authBindings?: PluginAuthBindingDefinition[];
  authorization?: {
    requiredPermissions?: string[];
    defaultGrantScope?: AccessGrantScope;
    reason?: string;
  };
}

export interface BuiltinOrgSeed {
  slug: string;
  displayName: string;
  description: string;
  plugins: BuiltinPluginSeed[];
}
