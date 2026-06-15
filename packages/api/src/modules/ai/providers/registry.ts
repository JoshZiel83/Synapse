/**
 * Provider-kind facts for the AI-SDK provider layer.
 *
 * ProviderKind + PROVIDER_KINDS + isProviderKind live in @synapse/shared
 * (constants/model-providers). This module adds the per-kind runtime facts the
 * factory needs (default API style, server-tool support) and the ApiStyle type.
 */
import {
  MODEL_API_STYLE,
  isProviderKind,
  PROVIDER_KINDS,
  type ModelApiStyle,
  type ProviderKind,
} from "@synapse/shared"

export { isProviderKind, PROVIDER_KINDS }
export type { ProviderKind }

/** OpenAI API surface selector. Only meaningful for kind === "openai". */
export type ApiStyle = ModelApiStyle

export interface ProviderKindFacts {
  /** Whether this kind can carry Anthropic-style server tools. */
  supportsServerTools: boolean
  /** Default API style when none is configured (OpenAI only). */
  defaultApiStyle: ApiStyle
}

export const PROVIDER_KIND_FACTS: Record<ProviderKind, ProviderKindFacts> = {
  anthropic: {
    supportsServerTools: true,
    defaultApiStyle: MODEL_API_STYLE.CHAT,
  },
  openai: { supportsServerTools: false, defaultApiStyle: MODEL_API_STYLE.CHAT },
  openai_compatible: {
    supportsServerTools: false,
    defaultApiStyle: MODEL_API_STYLE.CHAT,
  },
}

export function providerKindFacts(kind: ProviderKind): ProviderKindFacts {
  return PROVIDER_KIND_FACTS[kind]
}
