import type { AIProvider, AIProviderConfig } from "./types.js"
import { getModelProviderAdapter } from "@synapse/shared"
import { AnthropicProvider } from "./anthropic.js"
import { BigModelChatCompletionsProvider } from "./bigmodel.js"
import { OpenAIChatCompletionsProvider } from "./openai.js"
import { OpenAIResponsesProvider } from "./openai-responses.js"

export type { AIProvider, AIProviderConfig }

export function createAIProvider(
  providerName: string,
  providerConfig: AIProviderConfig
): AIProvider {
  switch (getModelProviderAdapter(providerConfig.engineKind)) {
    case "anthropic.messages":
      return new AnthropicProvider(providerConfig)
    case "openai.chat_completions":
      return new OpenAIChatCompletionsProvider(providerConfig)
    case "openai.responses":
      return new OpenAIResponsesProvider(providerConfig)
    case "bigmodel.chat_completions":
      return new BigModelChatCompletionsProvider(providerConfig)
    default:
      throw new Error(
        `Unknown AI engine kind: ${providerConfig.engineKind}. Provider=${providerName}. Supported adapters: anthropic.messages, openai.chat_completions, openai.responses, bigmodel.chat_completions`
      )
  }
}
