/**
 * Map a resolved model config → LanguageModelSpec for the provider factory.
 *
 * Post Phase C: ResolvedModelConfig already carries providerKind/vendor/apiStyle
 * natively, so this is a near-passthrough (kept as the single seam between the
 * resolver's shape and the factory's input).
 */
import type { ResolvedModelConfig } from "@synapse/shared"
import type { LanguageModelSpec } from "./get-language-model.js"

export function toLanguageModelSpec(
  resolved: ResolvedModelConfig
): LanguageModelSpec {
  return {
    providerKind: resolved.providerKind,
    vendor: resolved.vendor,
    apiStyle: resolved.apiStyle,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    modelName: resolved.modelName,
  }
}
