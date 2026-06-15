/**
 * Provider factory: build an AI-SDK LanguageModel from a resolved binding.
 *
 * The ONLY place that dispatches on provider kind. `vendor` (deepseek/bigmodel)
 * is NOT a switch axis — DeepSeek and BigModel are both `openai_compatible`.
 *
 * Provider OBJECTS are memoized by a stable hash of every instance-distinguishing
 * field (kind/apiStyle/baseURL/apiKey/headers/queryParams/vendor) — NOT modelName,
 * since one provider object serves all its models (picked per call). This keeps
 * connection pools warm without ever reusing the wrong instance.
 */
import { createHash } from "node:crypto"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { wrapLanguageModel, type LanguageModel } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { MODEL_API_STYLE } from "@synapse/shared"
import { proxyFetch } from "./proxy-fetch.js"
import { defaultMiddleware } from "./middleware.js"
import {
  providerKindFacts,
  type ApiStyle,
  type ProviderKind,
} from "./registry.js"

/** The normalized input the factory needs. Phase A maps the legacy
 *  ResolvedModelConfig into this; Phase C makes ResolvedModelConfig carry it
 *  natively. */
export interface LanguageModelSpec {
  providerKind: ProviderKind
  vendor: string
  apiStyle?: ApiStyle
  baseUrl: string
  apiKey: string
  modelName: string
  headers?: Record<string, string>
  queryParams?: Record<string, string>
}

function stableHash(spec: LanguageModelSpec): string {
  const key = {
    k: spec.providerKind,
    a: spec.apiStyle ?? "",
    b: spec.baseUrl.replace(/\/+$/, ""),
    // hash the api key, never store/log it raw
    key: createHash("sha256").update(spec.apiKey).digest("hex").slice(0, 16),
    h: spec.headers ?? null,
    q: spec.queryParams ?? null,
    v: spec.vendor,
  }
  return createHash("sha256").update(JSON.stringify(key)).digest("hex")
}

// Memoize the PROVIDER object (not the LanguageModel). Bounded by the number of
// distinct (kind, baseURL, key, ...) tuples, which is small (one per binding
// endpoint). A factory closure is stored so the per-call modelName is applied
// without re-creating the provider.
type ProviderFactory = (modelName: string) => LanguageModelV3
const providerCache = new Map<string, ProviderFactory>()

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "")
}

/**
 * Anthropic Messages base. The SDK appends `/v1/messages`, so the configured
 * base must be the host root WITHOUT a trailing /v1 (else it doubles up). If the
 * config already includes /v1, strip it; the SDK re-adds it.
 */
function anthropicBaseUrl(raw: string): string {
  const n = normalizeBaseUrl(raw)
  return n.endsWith("/v1") ? `${n}` : `${n}/v1`
}

/**
 * OpenAI base. The SDK appends `/chat/completions` (or `/responses`) to the
 * configured baseURL and does NOT add `/v1` — its default baseURL already ends
 * in `/v1`. Synapse stores the host root (e.g. the gateway origin without /v1),
 * matching the old adapter which posted to `${base}/v1/chat/completions`. So we
 * append `/v1` unless it's already present.
 */
function openAiBaseUrl(raw: string): string {
  const n = normalizeBaseUrl(raw)
  return n.endsWith("/v1") ? n : `${n}/v1`
}

/**
 * BigModel / Zhipu chat base. The openai-compatible provider appends
 * `/chat/completions`, so the base must end at `/paas/v4`. Accept the bare host,
 * the `/paas/v4` form, and the full `/paas/v4/chat/completions` form.
 * (Port of the old bigmodel.ts buildBigModelChatEndpoint shim.)
 */
export function bigModelChatBase(raw: string): string {
  const n = normalizeBaseUrl(raw)
  if (n.endsWith("/paas/v4/chat/completions"))
    return n.replace(/\/chat\/completions$/, "")
  if (n.endsWith("/paas/v4")) return n
  return `${n}/paas/v4`
}

function buildProviderFactory(spec: LanguageModelSpec): ProviderFactory {
  switch (spec.providerKind) {
    case "anthropic": {
      const provider = createAnthropic({
        baseURL: anthropicBaseUrl(spec.baseUrl),
        apiKey: spec.apiKey,
        headers: spec.headers,
        fetch: proxyFetch,
      })
      return (modelName) => provider.languageModel(modelName)
    }
    case "openai": {
      const provider = createOpenAI({
        baseURL: openAiBaseUrl(spec.baseUrl),
        apiKey: spec.apiKey,
        headers: spec.headers,
        fetch: proxyFetch,
      })
      const style = spec.apiStyle ?? providerKindFacts("openai").defaultApiStyle
      // EXPLICIT .chat()/.responses(): openai(modelId) defaults to Responses in
      // v6, which gateway-served chat models do not speak.
      return (modelName) =>
        style === MODEL_API_STYLE.RESPONSES
          ? provider.responses(modelName)
          : provider.chat(modelName)
    }
    case "openai_compatible": {
      // BigModel (Zhipu) needs the /paas/v4 base shim. Other OpenAI-compatible
      // gateways follow the OpenAI convention (`/v1/chat/completions`), so the
      // base gets `/v1` appended like the openai kind.
      const baseUrl = /\/paas\/v4/.test(spec.baseUrl)
        ? bigModelChatBase(spec.baseUrl)
        : openAiBaseUrl(spec.baseUrl)
      const provider = createOpenAICompatible({
        name: spec.vendor || "openai_compatible",
        baseURL: baseUrl,
        apiKey: spec.apiKey,
        headers: spec.headers,
        queryParams: spec.queryParams,
        fetch: proxyFetch,
      })
      // Always chat protocol — never Responses — for compatible gateways.
      return (modelName) => provider.chatModel(modelName)
    }
    default: {
      const exhaustive: never = spec.providerKind
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`)
    }
  }
}

export function getLanguageModel(spec: LanguageModelSpec): LanguageModel {
  const cacheKey = stableHash(spec)
  let factory = providerCache.get(cacheKey)
  if (!factory) {
    factory = buildProviderFactory(spec)
    providerCache.set(cacheKey, factory)
  }
  const base = factory(spec.modelName)
  return wrapLanguageModel({ model: base, middleware: defaultMiddleware })
}
