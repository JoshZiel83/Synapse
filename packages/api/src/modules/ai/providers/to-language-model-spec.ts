/**
 * Map a resolved model config → LanguageModelSpec for the provider factory.
 *
 * PHASE A SHIM: the current ResolvedModelConfig still carries the legacy
 * `providerType` + `engineKind`. This derives `providerKind` / `vendor` /
 * `apiStyle` from them so the new factory works before the data model changes.
 * In Phase C, ResolvedModelConfig carries providerKind/vendor/apiStyle natively
 * and this mapping collapses to a near-passthrough.
 */
import type { ResolvedModelConfig } from "@synapse/shared"
import type { LanguageModelSpec } from "./get-language-model.js"
import type { ApiStyle, ProviderKind } from "./registry.js"

function deriveKindAndStyle(resolved: ResolvedModelConfig): {
  providerKind: ProviderKind
  vendor: string
  apiStyle: ApiStyle
} {
  const providerType = resolved.providerType
  const engineKind = resolved.engineKind || ""

  // anthropic.* → anthropic
  if (providerType === "anthropic" || engineKind.startsWith("anthropic.")) {
    return { providerKind: "anthropic", vendor: "anthropic", apiStyle: "chat" }
  }
  // openai.responses → openai + responses; openai.chat_completions → openai + chat
  if (providerType === "openai") {
    const apiStyle: ApiStyle =
      engineKind === "openai.responses" ? "responses" : "chat"
    return { providerKind: "openai", vendor: "openai", apiStyle }
  }
  // bigmodel / zhipu / anything else OpenAI-compatible (incl. gateway DeepSeek)
  return {
    providerKind: "openai_compatible",
    vendor: providerType || "openai_compatible",
    apiStyle: "chat",
  }
}

export function toLanguageModelSpec(
  resolved: ResolvedModelConfig
): LanguageModelSpec {
  const { providerKind, vendor, apiStyle } = deriveKindAndStyle(resolved)
  return {
    providerKind,
    vendor,
    apiStyle,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    modelName: resolved.modelName,
  }
}
