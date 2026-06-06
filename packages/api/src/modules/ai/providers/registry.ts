/**
 * Provider-kind facts for the AI-SDK provider layer.
 *
 * ProviderKind + PROVIDER_KINDS + isProviderKind live in @synapse/shared
 * (constants/model-providers). This module adds the per-kind runtime facts the
 * factory needs (default API style, server-tool support) and the ApiStyle type.
 */
import {
  isProviderKind,
  PROVIDER_KINDS,
  type ProviderKind,
} from "@synapse/shared"

export { isProviderKind, PROVIDER_KINDS }
export type { ProviderKind }

/** OpenAI API surface selector. Only meaningful for kind === "openai". */
export type ApiStyle = "chat" | "responses"

export interface ProviderKindFacts {
  /** Whether this kind can carry Anthropic-style server tools. */
  supportsServerTools: boolean
  /** Default API style when none is configured (OpenAI only). */
  defaultApiStyle: ApiStyle
}

export const PROVIDER_KIND_FACTS: Record<ProviderKind, ProviderKindFacts> = {
  anthropic: { supportsServerTools: true, defaultApiStyle: "chat" },
  openai: { supportsServerTools: false, defaultApiStyle: "chat" },
  openai_compatible: { supportsServerTools: false, defaultApiStyle: "chat" },
}

export function providerKindFacts(kind: ProviderKind): ProviderKindFacts {
  return PROVIDER_KIND_FACTS[kind]
}
