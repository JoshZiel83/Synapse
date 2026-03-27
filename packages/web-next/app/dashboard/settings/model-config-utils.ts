import {
  getKnownModelDefinitions,
  getModelMaxTokensLimit,
  validateModelProviderConfig,
} from '@synapse/shared';
import { ApiError } from '@/lib/api';

export function getModelConfigValidationMessage(input: {
  providerType: string;
  engineKind: string;
  modelName: string;
  maxTokens: string;
}): string {
  const parsedMaxTokens = Number.parseInt(input.maxTokens, 10);

  if (input.maxTokens.trim() && (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens <= 0)) {
    return 'Max tokens must be a positive integer.';
  }

  const issues = validateModelProviderConfig({
    providerType: input.providerType,
    engineKind: input.engineKind,
    modelName: input.modelName,
    maxTokens: Number.isFinite(parsedMaxTokens) ? parsedMaxTokens : undefined,
  });

  return issues[0]?.message || '';
}

export function getKnownModelOptions(providerType: string, engineKind: string) {
  return getKnownModelDefinitions(providerType, engineKind);
}

export function getEffectiveMaxTokensLimit(
  providerType: string,
  engineKind: string,
  modelName: string,
): number | undefined {
  return getModelMaxTokensLimit(providerType, engineKind, modelName.trim() || undefined);
}

export function getSaveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
