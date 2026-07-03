// Curated model-group fixtures with REAL mainstream + Chinese models (Claude /
// GPT / GLM / DeepSeek), realistic priority/weight/routing, across the 3
// ownership scopes — replacing the random faker output (lorem names, negative
// priority/weight). Drives the redesigned Groups workbench.
import type {
  ModelGroupDetailView,
  ModelGroupItemView,
  ModelGroupGrantView,
  ModelGroupOwnerType,
  ProviderKind,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId, designWorkspaceMemberId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const WS = designWorkspaceId

let itemSeq = 0
function item(o: {
  displayName: string
  vendor: string
  modelName: string
  providerKind: ProviderKind
  baseUrl: string
  priority?: number
  weight?: number
  isEnabled?: boolean
  maxOutputTokens?: number
  capabilityTags?: string[]
  features?: ModelGroupItemView["features"]
}): ModelGroupItemView {
  itemSeq += 1
  const id = `mi-${itemSeq}`
  return {
    id,
    groupId: null,
    bindingId: `bind-${itemSeq}`,
    currentVersionId: `ver-${itemSeq}`,
    displayName: o.displayName,
    priority: o.priority ?? 0,
    weight: o.weight ?? 100,
    isEnabled: o.isEnabled ?? true,
    version: 1,
    providerKind: o.providerKind,
    vendor: o.vendor,
    baseUrl: o.baseUrl,
    modelName: o.modelName,
    maxOutputTokens: o.maxOutputTokens ?? 8192,
    capabilityTags: o.capabilityTags ?? [],
    features: o.features ?? {},
    providerOptions: {},
    requestTimeoutMs: null,
    maxRetries: null,
    createdAt: ts("2026-06-12T08:00:00Z"),
    updatedAt: ts("2026-06-26T08:00:00Z"),
  }
}

let grantSeq = 0
function grant(
  o: Partial<ModelGroupGrantView> &
    Pick<ModelGroupGrantView, "groupId" | "grantScope">
): ModelGroupGrantView {
  grantSeq += 1
  return {
    id: `mg-${grantSeq}`,
    workspaceId: null,
    workspaceMemberId: null,
    actorId: null,
    status: "active",
    createdByWorkspaceMemberId: designWorkspaceMemberId,
    reason: null,
    createdAt: ts("2026-06-14T08:00:00Z"),
    revokedAt: null,
    ...o,
  }
}

function group(o: {
  id: string
  scope: ModelGroupOwnerType
  name: string
  description: string
  routingStrategy: ModelGroupDetailView["routingStrategy"]
  isDefault?: boolean
  isActive?: boolean
  items: ModelGroupItemView[]
  grants?: ModelGroupGrantView[]
}): ModelGroupDetailView {
  return {
    id: o.id,
    ownerType: o.scope,
    scope: o.scope,
    ownerWorkspaceId: o.scope === "workspace" ? WS : null,
    ownerWorkspaceMemberId:
      o.scope === "workspace_member" ? designWorkspaceMemberId : null,
    workspaceId: o.scope === "platform" ? null : WS,
    name: o.name,
    description: o.description,
    routingStrategy: o.routingStrategy,
    attemptPolicy: {},
    isDefault: o.isDefault ?? false,
    isActive: o.isActive ?? true,
    createdByWorkspaceMemberId: designWorkspaceMemberId,
    createdAt: ts("2026-06-10T08:00:00Z"),
    updatedAt: ts("2026-06-28T08:00:00Z"),
    items: o.items.map((it, i) => ({
      ...it,
      groupId: o.id,
      priority: it.priority || i,
    })),
    grants: o.grants ?? [],
  }
}

const ANTHROPIC = "https://api.anthropic.com"
const OPENAI = "https://api.openai.com/v1"
const BIGMODEL = "https://open.bigmodel.cn/api/paas/v4"
const DEEPSEEK = "https://api.deepseek.com"

export const designModelGroupsByScope: Record<
  ModelGroupOwnerType,
  ModelGroupDetailView[]
> = {
  workspace: [
    group({
      id: "grp-prod",
      scope: "workspace",
      name: "生产主力",
      description: "线上默认：Claude 主用，故障时依次回退到 GPT-4o、GLM。",
      routingStrategy: "priority_failover",
      isDefault: true,
      items: [
        item({
          displayName: "Claude Sonnet 4",
          vendor: "anthropic",
          modelName: "claude-sonnet-4-20250514",
          providerKind: "anthropic",
          baseUrl: ANTHROPIC,
          priority: 0,
          maxOutputTokens: 64000,
          capabilityTags: ["主力", "长上下文"],
          features: {
            serverTools: ["web_search"],
            multimodal: { supported: true, types: ["image"] },
          },
        }),
        item({
          displayName: "GPT-4o",
          vendor: "openai",
          modelName: "gpt-4o",
          providerKind: "openai",
          baseUrl: OPENAI,
          priority: 1,
          maxOutputTokens: 16384,
          capabilityTags: ["备用"],
        }),
        item({
          displayName: "GLM-4.6（兜底）",
          vendor: "bigmodel",
          modelName: "glm-4.6",
          providerKind: "openai_compatible",
          baseUrl: BIGMODEL,
          priority: 2,
          maxOutputTokens: 131072,
          capabilityTags: ["国内", "兜底"],
        }),
      ],
      grants: [],
    }),
    group({
      id: "grp-balance",
      scope: "workspace",
      name: "均衡分流",
      description: "按权重在 Claude 与 DeepSeek 之间分流，控制成本。",
      routingStrategy: "weighted_random",
      items: [
        item({
          displayName: "Claude Sonnet 4",
          vendor: "anthropic",
          modelName: "claude-sonnet-4-20250514",
          providerKind: "anthropic",
          baseUrl: ANTHROPIC,
          weight: 600,
        }),
        item({
          displayName: "DeepSeek V3",
          vendor: "deepseek",
          modelName: "deepseek-chat",
          providerKind: "openai_compatible",
          baseUrl: DEEPSEEK,
          weight: 400,
          capabilityTags: ["低成本"],
        }),
      ],
      grants: [
        grant({
          groupId: "grp-balance",
          grantScope: "actor",
          actorId: "act-nova",
          reason: "数据 Nova 专用分流",
        }),
      ],
    }),
    group({
      id: "grp-vision",
      scope: "workspace",
      name: "多模态实验",
      description: "带视觉能力的实验组，暂时停用。",
      routingStrategy: "priority_failover",
      isActive: false,
      items: [
        item({
          displayName: "GPT-4o",
          vendor: "openai",
          modelName: "gpt-4o",
          providerKind: "openai",
          baseUrl: OPENAI,
          features: {
            multimodal: { supported: true, types: ["image", "video"] },
          },
        }),
      ],
    }),
  ],
  platform: [
    group({
      id: "grp-platform-default",
      scope: "platform",
      name: "平台默认",
      description: "跨租户默认组，影响所有工作区。谨慎修改。",
      routingStrategy: "priority_failover",
      isDefault: true,
      items: [
        item({
          displayName: "GPT-4o mini",
          vendor: "openai",
          modelName: "gpt-4o-mini",
          providerKind: "openai",
          baseUrl: OPENAI,
          priority: 0,
        }),
        item({
          displayName: "Claude Haiku",
          vendor: "anthropic",
          modelName: "claude-haiku-4-5-20251001",
          providerKind: "anthropic",
          baseUrl: ANTHROPIC,
          priority: 1,
        }),
      ],
      grants: [
        grant({ groupId: "grp-platform-default", grantScope: "platform" }),
      ],
    }),
  ],
  workspace_member: [
    group({
      id: "grp-my-lab",
      scope: "workspace_member",
      name: "我的实验组",
      description: "个人调试用，只有我可见。",
      routingStrategy: "priority_failover",
      items: [
        item({
          displayName: "Claude Opus 4.8",
          vendor: "anthropic",
          modelName: "claude-opus-4-8",
          providerKind: "anthropic",
          baseUrl: ANTHROPIC,
          maxOutputTokens: 64000,
          capabilityTags: ["最强"],
        }),
      ],
    }),
  ],
}

export const designModelGroupList = (
  scope: ModelGroupOwnerType
): ModelGroupDetailView[] => designModelGroupsByScope[scope] ?? []

export function findModelGroup(id: string): ModelGroupDetailView | undefined {
  for (const list of Object.values(designModelGroupsByScope)) {
    const g = list.find((x) => x.id === id)
    if (g) return g
  }
  return undefined
}
