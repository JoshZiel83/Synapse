/**
 * Barrel for the AI-SDK provider layer.
 *
 * The provider layer is now the Vercel AI SDK. Synapse owns only:
 *  - getLanguageModel: build a LanguageModel from a resolved binding
 *  - toModelMessages: compile canonical ConversationMessage[] → neutral ModelMessage[]
 *  - reconcileToolPairing: guarantee tool-call/result pairing before send
 *  - buildAiTools: ToolDefinition[] → execute-less ToolSet
 *  - fromGenerateText: adapt the SDK result back to the loop's expected shape
 */
export { getLanguageModel, bigModelChatBase } from "./get-language-model.js"
export type { LanguageModelSpec } from "./get-language-model.js"
export { toLanguageModelSpec } from "./to-language-model-spec.js"
export { toModelMessages } from "./to-model-messages.js"
export { reconcileToolPairing } from "./reconcile-tool-pairing.js"
export { buildAiTools } from "./build-tools.js"
export { fromGenerateText, normalizeUsage } from "./from-generate-text.js"
export {
  PROVIDER_KINDS,
  PROVIDER_KIND_FACTS,
  isProviderKind,
  providerKindFacts,
} from "./registry.js"
export type { ProviderKind, ApiStyle } from "./registry.js"
