export type ModelProviderAdapterKey =
  | 'anthropic.messages'
  | 'openai.chat_completions'
  | 'openai.responses'
  | 'bigmodel.chat_completions';

export type ModelBranchStateMode =
  | 'anthropic.messages'
  | 'openai.chat_completions'
  | 'openai.responses';

export interface ModelProviderKnownModelDefinition {
  modelName: string;
  label: string;
  maxOutputTokens?: number;
}

export interface ModelProviderEngineDefinition {
  engineKind: string;
  label: string;
  defaultModelName: string;
  providerAdapter: ModelProviderAdapterKey;
  branchStateMode: ModelBranchStateMode;
  maxOutputTokens?: number;
  knownModels?: ModelProviderKnownModelDefinition[];
}

export interface ModelProviderDefinition {
  providerType: string;
  label: string;
  defaultBaseUrl: string;
  defaultEngineKind: string;
  envApiKeyAliases: string[];
  supportsBuiltinTools: boolean;
  engines: ModelProviderEngineDefinition[];
}

export interface ModelProviderConfigValidationIssue {
  field: 'maxTokens';
  code: 'max_tokens_exceeded';
  message: string;
  maximum?: number;
}

const BIGMODEL_CHAT_MODELS: ModelProviderKnownModelDefinition[] = [
  { modelName: 'glm-5.1', label: 'GLM-5.1', maxOutputTokens: 131072 },
  { modelName: 'glm-5-turbo', label: 'GLM-5-Turbo', maxOutputTokens: 131072 },
  { modelName: 'glm-5', label: 'GLM-5', maxOutputTokens: 131072 },
  { modelName: 'glm-4.7', label: 'GLM-4.7', maxOutputTokens: 131072 },
  { modelName: 'glm-4.7-flash', label: 'GLM-4.7-Flash', maxOutputTokens: 131072 },
  { modelName: 'glm-4.7-flashx', label: 'GLM-4.7-FlashX', maxOutputTokens: 131072 },
  { modelName: 'glm-4.6', label: 'GLM-4.6', maxOutputTokens: 131072 },
  { modelName: 'glm-4.5-air', label: 'GLM-4.5-Air', maxOutputTokens: 98304 },
  { modelName: 'glm-4.5-airx', label: 'GLM-4.5-AirX', maxOutputTokens: 98304 },
  { modelName: 'glm-4.5-flash', label: 'GLM-4.5-Flash', maxOutputTokens: 98304 },
  { modelName: 'glm-4-flash-250414', label: 'GLM-4-Flash-250414', maxOutputTokens: 131072 },
  { modelName: 'glm-4-flashx-250414', label: 'GLM-4-FlashX-250414', maxOutputTokens: 131072 },
  { modelName: 'glm-4.6v', label: 'GLM-4.6V', maxOutputTokens: 32768 },
  { modelName: 'autoglm-phone', label: 'AutoGLM-Phone', maxOutputTokens: 4096 },
  { modelName: 'glm-4.6v-flash', label: 'GLM-4.6V-Flash', maxOutputTokens: 32768 },
  { modelName: 'glm-4.6v-flashx', label: 'GLM-4.6V-FlashX', maxOutputTokens: 32768 },
  { modelName: 'glm-4v-flash', label: 'GLM-4V-Flash', maxOutputTokens: 32768 },
  { modelName: 'glm-4.1v-thinking-flashx', label: 'GLM-4.1V-Thinking-FlashX', maxOutputTokens: 16384 },
  { modelName: 'glm-4.1v-thinking-flash', label: 'GLM-4.1V-Thinking-Flash', maxOutputTokens: 16384 },
  { modelName: 'glm-4-voice', label: 'GLM-4-Voice', maxOutputTokens: 4096 },
  { modelName: 'charglm-4', label: 'CharGLM-4', maxOutputTokens: 4096 },
  { modelName: 'emohaa', label: 'Emohaa', maxOutputTokens: 4096 },
];

export const MODEL_PROVIDER_CATALOG: Record<string, ModelProviderDefinition> = {
  anthropic: {
    providerType: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultEngineKind: 'anthropic.messages',
    envApiKeyAliases: ['ANTHROPIC_API_KEY'],
    supportsBuiltinTools: true,
    engines: [
      {
        engineKind: 'anthropic.messages',
        label: 'Messages API',
        defaultModelName: 'claude-sonnet-4-20250514',
        providerAdapter: 'anthropic.messages',
        branchStateMode: 'anthropic.messages',
      },
    ],
  },
  openai: {
    providerType: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    defaultEngineKind: 'openai.chat_completions',
    envApiKeyAliases: ['OPENAI_API_KEY'],
    supportsBuiltinTools: false,
    engines: [
      {
        engineKind: 'openai.chat_completions',
        label: 'Chat Completions',
        defaultModelName: 'gpt-4.1',
        providerAdapter: 'openai.chat_completions',
        branchStateMode: 'openai.chat_completions',
      },
      {
        engineKind: 'openai.responses',
        label: 'Responses API',
        defaultModelName: 'gpt-5',
        providerAdapter: 'openai.responses',
        branchStateMode: 'openai.responses',
      },
    ],
  },
  bigmodel: {
    providerType: 'bigmodel',
    label: 'BigModel',
    defaultBaseUrl: 'https://open.bigmodel.cn/api',
    defaultEngineKind: 'bigmodel.chat_completions',
    envApiKeyAliases: ['BIGMODEL_API_KEY', 'ZHIPUAI_API_KEY'],
    supportsBuiltinTools: false,
    engines: [
      {
        engineKind: 'bigmodel.chat_completions',
        label: 'Chat Completions',
        defaultModelName: 'glm-5-turbo',
        providerAdapter: 'bigmodel.chat_completions',
        branchStateMode: 'openai.chat_completions',
        maxOutputTokens: 131072,
        knownModels: BIGMODEL_CHAT_MODELS,
      },
    ],
  },
};

export function listModelProviderDefinitions(): ModelProviderDefinition[] {
  return Object.values(MODEL_PROVIDER_CATALOG);
}

export function getModelProviderDefinition(providerType?: string | null): ModelProviderDefinition | undefined {
  if (!providerType) return undefined;
  return MODEL_PROVIDER_CATALOG[providerType];
}

export function getModelProviderEngineDefinition(engineKind?: string | null): ModelProviderEngineDefinition | undefined {
  if (!engineKind) return undefined;
  for (const provider of Object.values(MODEL_PROVIDER_CATALOG)) {
    const engine = provider.engines.find((candidate) => candidate.engineKind === engineKind);
    if (engine) return engine;
  }
  return undefined;
}

export function getModelProviderEngineDefinitions(providerType?: string | null): ModelProviderEngineDefinition[] {
  return getModelProviderDefinition(providerType)?.engines || [];
}

export function isKnownModelProviderType(value: string): boolean {
  return !!getModelProviderDefinition(value);
}

export function isKnownModelEngineKind(value: string): boolean {
  return !!getModelProviderEngineDefinition(value);
}

export function getDefaultModelEngineKind(providerType: string): string {
  return getModelProviderDefinition(providerType)?.defaultEngineKind || 'anthropic.messages';
}

export function getDefaultModelBaseUrl(providerType: string): string {
  return getModelProviderDefinition(providerType)?.defaultBaseUrl || '';
}

export function getDefaultModelName(providerType: string, engineKind?: string): string {
  const provider = getModelProviderDefinition(providerType);
  if (!provider) return '';
  const resolvedEngineKind = engineKind || provider.defaultEngineKind;
  const engine = provider.engines.find((candidate) => candidate.engineKind === resolvedEngineKind);
  return engine?.defaultModelName || provider.engines[0]?.defaultModelName || '';
}

export function resolveModelEngineKind(
  providerType: string,
  extraConfig?: Record<string, unknown> | null,
): string {
  const raw = typeof extraConfig?.engine_kind === 'string'
    ? extraConfig.engine_kind
    : typeof extraConfig?.api_style === 'string'
      ? extraConfig.api_style
      : undefined;

  if (raw === 'responses' && providerType === 'openai') {
    return 'openai.responses';
  }

  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }

  return getDefaultModelEngineKind(providerType);
}

export function getModelProviderAdapter(engineKind: string): ModelProviderAdapterKey {
  return getModelProviderEngineDefinition(engineKind)?.providerAdapter || 'anthropic.messages';
}

export function getModelBranchStateMode(engineKind: string): ModelBranchStateMode {
  return getModelProviderEngineDefinition(engineKind)?.branchStateMode || 'anthropic.messages';
}

export function providerSupportsBuiltinTools(providerType: string): boolean {
  return getModelProviderDefinition(providerType)?.supportsBuiltinTools === true;
}

export function getKnownModelDefinitions(
  providerType?: string | null,
  engineKind?: string | null,
): ModelProviderKnownModelDefinition[] {
  const resolvedEngineKind = engineKind || getModelProviderDefinition(providerType || '')?.defaultEngineKind;
  return getModelProviderEngineDefinition(resolvedEngineKind)?.knownModels || [];
}

export function getKnownModelDefinition(
  providerType: string,
  engineKind: string | undefined,
  modelName: string,
): ModelProviderKnownModelDefinition | undefined {
  const normalized = modelName.trim();
  if (!normalized) return undefined;
  return getKnownModelDefinitions(providerType, engineKind)
    .find((candidate) => candidate.modelName === normalized);
}

export function getModelMaxTokensLimit(
  providerType: string,
  engineKind: string | undefined,
  modelName?: string,
): number | undefined {
  const byModel = modelName
    ? getKnownModelDefinition(providerType, engineKind, modelName)?.maxOutputTokens
    : undefined;
  if (typeof byModel === 'number') return byModel;
  const resolvedEngineKind = engineKind || getModelProviderDefinition(providerType)?.defaultEngineKind;
  return getModelProviderEngineDefinition(resolvedEngineKind)?.maxOutputTokens;
}

export function validateModelProviderConfig(input: {
  providerType: string;
  engineKind?: string;
  modelName: string;
  maxTokens?: number;
}): ModelProviderConfigValidationIssue[] {
  const issues: ModelProviderConfigValidationIssue[] = [];
  const modelName = input.modelName.trim();

  if (typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens)) {
    const maximum = getModelMaxTokensLimit(input.providerType, input.engineKind, modelName);
    if (typeof maximum === 'number' && input.maxTokens > maximum) {
      issues.push({
        field: 'maxTokens',
        code: 'max_tokens_exceeded',
        maximum,
        message: `${input.providerType} model "${modelName}" supports at most ${maximum} max tokens.`,
      });
    }
  }

  return issues;
}
