// Vendor catalog: UI dropdowns + per-model max-output-token limits + the
// provider-kind mapping. After the AI-SDK migration, the engineKind 3-axis
// fan-out (providerAdapter × branchStateMode × supportsBuiltinTools) is gone —
// the SDK owns wire dispatch. A vendor maps to ONE providerKind
// (anthropic|openai|openai_compatible); DeepSeek/BigModel are openai_compatible.

export type ProviderKind = "anthropic" | "openai" | "openai_compatible"

export interface ModelVendorKnownModelDefinition {
  modelName: string
  label: string
  maxOutputTokens?: number
}

export interface ModelVendorDefinition {
  /** Stable vendor id (used as the binding's `vendor` + UI key). */
  vendor: string
  label: string
  /** Which SDK factory serves this vendor. */
  providerKind: ProviderKind
  defaultBaseUrl: string
  defaultModelName: string
  /** Whether Anthropic-style server tools (web_search/web_fetch) are available. */
  supportsServerTools: boolean
  /** Fallback per-vendor max output cap when a model isn't in knownModels. */
  maxOutputTokens?: number
  knownModels?: ModelVendorKnownModelDefinition[]
}

export interface ModelProviderConfigValidationIssue {
  field: "maxOutputTokens"
  code: "max_tokens_exceeded"
  message: string
  maximum?: number
}

const BIGMODEL_CHAT_MODELS: ModelVendorKnownModelDefinition[] = [
  { modelName: "glm-5.1", label: "GLM-5.1", maxOutputTokens: 131072 },
  { modelName: "glm-5-turbo", label: "GLM-5-Turbo", maxOutputTokens: 131072 },
  { modelName: "glm-5", label: "GLM-5", maxOutputTokens: 131072 },
  { modelName: "glm-4.7", label: "GLM-4.7", maxOutputTokens: 131072 },
  {
    modelName: "glm-4.7-flash",
    label: "GLM-4.7-Flash",
    maxOutputTokens: 131072,
  },
  {
    modelName: "glm-4.7-flashx",
    label: "GLM-4.7-FlashX",
    maxOutputTokens: 131072,
  },
  { modelName: "glm-4.6", label: "GLM-4.6", maxOutputTokens: 131072 },
  { modelName: "glm-4.5-air", label: "GLM-4.5-Air", maxOutputTokens: 98304 },
  { modelName: "glm-4.5-airx", label: "GLM-4.5-AirX", maxOutputTokens: 98304 },
  {
    modelName: "glm-4.5-flash",
    label: "GLM-4.5-Flash",
    maxOutputTokens: 98304,
  },
  {
    modelName: "glm-4-flash-250414",
    label: "GLM-4-Flash-250414",
    maxOutputTokens: 131072,
  },
  {
    modelName: "glm-4-flashx-250414",
    label: "GLM-4-FlashX-250414",
    maxOutputTokens: 131072,
  },
  { modelName: "glm-4.6v", label: "GLM-4.6V", maxOutputTokens: 32768 },
  { modelName: "autoglm-phone", label: "AutoGLM-Phone", maxOutputTokens: 4096 },
  {
    modelName: "glm-4.6v-flash",
    label: "GLM-4.6V-Flash",
    maxOutputTokens: 32768,
  },
  {
    modelName: "glm-4.6v-flashx",
    label: "GLM-4.6V-FlashX",
    maxOutputTokens: 32768,
  },
  { modelName: "glm-4v-flash", label: "GLM-4V-Flash", maxOutputTokens: 32768 },
  {
    modelName: "glm-4.1v-thinking-flashx",
    label: "GLM-4.1V-Thinking-FlashX",
    maxOutputTokens: 16384,
  },
  {
    modelName: "glm-4.1v-thinking-flash",
    label: "GLM-4.1V-Thinking-Flash",
    maxOutputTokens: 16384,
  },
  { modelName: "glm-4-voice", label: "GLM-4-Voice", maxOutputTokens: 4096 },
  { modelName: "charglm-4", label: "CharGLM-4", maxOutputTokens: 4096 },
  { modelName: "emohaa", label: "Emohaa", maxOutputTokens: 4096 },
]

export const MODEL_VENDOR_CATALOG: Record<string, ModelVendorDefinition> = {
  anthropic: {
    vendor: "anthropic",
    label: "Anthropic",
    providerKind: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModelName: "claude-sonnet-4-20250514",
    supportsServerTools: true,
  },
  openai: {
    vendor: "openai",
    label: "OpenAI",
    providerKind: "openai",
    defaultBaseUrl: "https://api.openai.com",
    defaultModelName: "gpt-4.1",
    supportsServerTools: false,
  },
  deepseek: {
    vendor: "deepseek",
    label: "DeepSeek",
    providerKind: "openai_compatible",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModelName: "deepseek-chat",
    supportsServerTools: false,
  },
  bigmodel: {
    vendor: "bigmodel",
    label: "BigModel",
    providerKind: "openai_compatible",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModelName: "glm-5.1",
    supportsServerTools: false,
    maxOutputTokens: 131072,
    knownModels: BIGMODEL_CHAT_MODELS,
  },
}

export const PROVIDER_KINDS = [
  "anthropic",
  "openai",
  "openai_compatible",
] as const

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value)
}

export function listModelVendorDefinitions(): ModelVendorDefinition[] {
  return Object.values(MODEL_VENDOR_CATALOG)
}

export function getModelVendorDefinition(
  vendor?: string | null
): ModelVendorDefinition | undefined {
  if (!vendor) return undefined
  return MODEL_VENDOR_CATALOG[vendor]
}

export function isKnownModelVendor(value: string): boolean {
  return !!getModelVendorDefinition(value)
}

export function getDefaultModelBaseUrl(vendor: string): string {
  return getModelVendorDefinition(vendor)?.defaultBaseUrl || ""
}

export function getDefaultModelName(vendor: string): string {
  return getModelVendorDefinition(vendor)?.defaultModelName || ""
}

export function getProviderKindForVendor(vendor: string): ProviderKind {
  return getModelVendorDefinition(vendor)?.providerKind || "openai_compatible"
}

export function vendorSupportsServerTools(vendor: string): boolean {
  return getModelVendorDefinition(vendor)?.supportsServerTools === true
}

export function getKnownModelDefinitions(
  vendor?: string | null
): ModelVendorKnownModelDefinition[] {
  return getModelVendorDefinition(vendor || "")?.knownModels || []
}

export function getKnownModelDefinition(
  vendor: string,
  modelName: string
): ModelVendorKnownModelDefinition | undefined {
  const normalized = modelName.trim()
  if (!normalized) return undefined
  return getKnownModelDefinitions(vendor).find(
    (candidate) => candidate.modelName === normalized
  )
}

export function getModelMaxTokensLimit(
  vendor: string,
  modelName?: string
): number | undefined {
  const byModel = modelName
    ? getKnownModelDefinition(vendor, modelName)?.maxOutputTokens
    : undefined
  if (typeof byModel === "number") return byModel
  return getModelVendorDefinition(vendor)?.maxOutputTokens
}

export function validateModelProviderConfig(input: {
  vendor: string
  modelName: string
  maxOutputTokens?: number
}): ModelProviderConfigValidationIssue[] {
  const issues: ModelProviderConfigValidationIssue[] = []
  const modelName = input.modelName.trim()

  if (
    typeof input.maxOutputTokens === "number" &&
    Number.isFinite(input.maxOutputTokens)
  ) {
    const maximum = getModelMaxTokensLimit(input.vendor, modelName)
    if (typeof maximum === "number" && input.maxOutputTokens > maximum) {
      issues.push({
        field: "maxOutputTokens",
        code: "max_tokens_exceeded",
        maximum,
        message: `${input.vendor} model "${modelName}" supports at most ${maximum} max output tokens.`,
      })
    }
  }

  return issues
}
