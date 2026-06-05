/**
 * Static provider-facts registry for the AI-SDK provider layer.
 *
 * This replaces the runtime role of getModelProviderAdapter / getModelBranchStateMode
 * (the engineKind 3-axis fan-out): the only thing the provider layer needs to know
 * at call time is the provider KIND (which AI-SDK factory to use) and a couple of
 * provider facts. `vendor` (deepseek/bigmodel/...) is a display/catalog concern and
 * does NOT widen this switch — DeepSeek and BigModel both resolve to the
 * `openai_compatible` kind.
 */

/** The three SDK factories the provider layer dispatches on. */
export type ProviderKind = "anthropic" | "openai" | "openai_compatible"

/** OpenAI API surface selector. Only meaningful for kind === "openai". */
export type ApiStyle = "chat" | "responses"

export interface ProviderKindFacts {
  /** Whether this kind can carry Anthropic-style server tools (web_search/web_fetch). */
  supportsServerTools: boolean
  /** Default API style when none is configured (OpenAI only). */
  defaultApiStyle: ApiStyle
}

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "openai_compatible",
] as const

export const PROVIDER_KIND_FACTS: Record<ProviderKind, ProviderKindFacts> = {
  anthropic: { supportsServerTools: true, defaultApiStyle: "chat" },
  openai: { supportsServerTools: false, defaultApiStyle: "chat" },
  openai_compatible: { supportsServerTools: false, defaultApiStyle: "chat" },
}

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value)
}

export function providerKindFacts(kind: ProviderKind): ProviderKindFacts {
  return PROVIDER_KIND_FACTS[kind]
}
