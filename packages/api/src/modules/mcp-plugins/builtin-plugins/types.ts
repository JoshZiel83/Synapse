import type {
  CapabilityAuthProviderDefinition,
  CapabilityConfigFieldDefinition,
  CapabilityGrantScope,
  CapabilityInstallFlow,
  CapabilityReuseScope,
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
  defaultBindingScope: 'workspace' | 'conversation' | 'actor_global' | 'actor_conversation' | 'user';
  defaultReuseScope: CapabilityReuseScope;
  requiresHandshake?: boolean;
  tags: string[];
  categorySlugs?: string[];
  iconAssetPath?: string;
  toolsManifest: unknown[];
  configSchema?: Record<string, unknown>;
  configFields?: CapabilityConfigFieldDefinition[];
  defaultConfig?: Record<string, unknown>;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  installFlow?: CapabilityInstallFlow;
  authProviders?: CapabilityAuthProviderDefinition[];
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
