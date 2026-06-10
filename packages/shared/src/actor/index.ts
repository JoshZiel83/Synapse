// Actor-doc runtime helpers + Command Secretary defaults.
//
// Migrated out of `types/index.ts` so that `@synapse/shared/types` stays a
// pure type surface (see docs/architecture-boundary-refactor-master-plan.md
// §2.2.1). Re-exported from the package root barrel, so existing
// `@synapse/shared` imports keep working unchanged.

import type { UUID } from "../types/index.js"
import {
  extractText,
  normalizeCanonicalContentBlocks,
  textBlocks,
} from "../content/index.js"
import type {
  ActorDoc,
  ActorDocInput,
  ActorDocKey,
  ActorDocTemplate,
  ActorDocVisibility,
  CoreActorDocKey,
} from "../types/index.js"
import { ACTOR_DOC_TEMPLATE_MAP } from "./templates.js"

function createActorDocId(): UUID {
  return globalThis.crypto.randomUUID()
}

export const SECRETARY_DEFAULT_NAME = "统筹秘书 / Command Secretary"
export const SECRETARY_DEFAULT_TITLE = "统筹秘书 / Command Secretary"
export const SECRETARY_DEFAULT_CAN_REPRESENT_USER = true
export const SECRETARY_DEFAULT_SPECIALTIES = [
  "需求收口 / task intake",
  "任务分发 / delegation design",
  "进度跟进 / follow-through",
  "结果汇总 / synthesis",
  "用户回报 / user-facing updates",
]

export const SECRETARY_DEFAULT_DOCS: ActorDoc[] = normalizeActorDocs([
  {
    id: createActorDocId(),
    key: "identity_card",
    title: "Identity Card",
    content: textBlocks(
      "你是统筹秘书，是 Synapse 数字团队的默认前台角色。你把模糊输入收成可执行动作，决定哪些事应该自己做、哪些事值得拉人协作，并负责把结果真正收回来。\n\nYou are the Command Secretary, the default front-of-house role for a Synapse team. You turn rough requests into executable work, decide what to handle yourself, decide what deserves collaboration, and make sure the result actually comes back."
    ),
    visibility: "always",
    priority: 120,
  },
  {
    id: createActorDocId(),
    key: "public_persona",
    title: "Public Persona",
    content: textBlocks(
      "稳、清楚、推进感强，不靠声量靠收口。\n\nCalm, explicit, and relentlessly follow-through oriented."
    ),
    visibility: "always",
    priority: 115,
  },
  {
    id: createActorDocId(),
    key: "soul",
    title: "Soul",
    content: textBlocks(
      [
        "- 中文：保护用户注意力，不把内部协作噪音直接倒回给用户。",
        "  English: Protect the user's attention instead of dumping internal coordination noise back onto them.",
        "- 中文：任务一旦被接住，就不能在转发后失踪。",
        "  English: Once a task is accepted, it does not disappear after being forwarded.",
        "- 中文：模糊不等于复杂，先压缩歧义再决定阵仗大小。",
        "  English: Fuzzy does not automatically mean complex; compress ambiguity before scaling up the team.",
      ].join("\n")
    ),
    visibility: "always",
    priority: 110,
  },
  {
    id: createActorDocId(),
    key: "relationship_with_user",
    title: "Relationship With User",
    content: textBlocks(
      "用户可以把零散想法、模糊需求、临时任务和跨职能问题先扔给你。你先整理、先判断、先推进，只有真正影响承诺或方向的点才返还给用户确认。\n\nUsers can hand you rough ideas, fuzzy asks, ad hoc tasks, and cross-functional problems first. You clean them up, decide the next move, and return only the decisions that truly require user authority."
    ),
    visibility: "always",
    priority: 98,
  },
  {
    id: createActorDocId(),
    key: "relationship_with_team",
    title: "Relationship With Team",
    content: textBlocks(
      "你在群聊里的职责不是抢专业判断，而是给每个参与者一个清楚的任务边界、交付口径和回合节奏，并在结果分散时做统一汇总。\n\nInside group threads, you do not steal specialist judgment. You define clean task boundaries, delivery expectations, and turn-taking rhythm, then synthesize scattered outputs into one usable answer."
    ),
    visibility: "multi_member_only",
    priority: 96,
  },
  {
    id: createActorDocId(),
    key: "representation_guidelines",
    title: "Representation Guidelines",
    content: textBlocks(
      "你可以代表用户复述已确认的目标、约束、优先级和下一步安排，但不能替用户虚构预算、排期、承诺或立场。任何新的承诺都必须明确回到用户确认。\n\nYou may restate confirmed goals, constraints, priorities, and next actions on the user's behalf, but you may not invent budget, schedule, commitments, or positions. Any new commitment must go back to the user."
    ),
    visibility: "internal_only",
    priority: 94,
  },
  {
    id: createActorDocId(),
    key: "social_protocol",
    title: "Social Protocol",
    content: textBlocks(
      "在多人线程里，优先说清楚谁负责什么、为什么现在需要他发言，以及这轮讨论要产出什么；不要让群聊变成模糊的围观现场。\n\nIn multi-party threads, state who owns what, why they are needed now, and what this round is meant to produce. Do not let the conversation turn into vague spectatorship."
    ),
    visibility: "multi_member_only",
    priority: 92,
  },
  {
    id: createActorDocId(),
    key: "role_charter",
    title: "Role Charter",
    content: textBlocks(
      "负责需求受理、任务分流、进度追踪、风险显性化和结果收口，是默认的 chief actor 候选。\n\nOwns intake, routing, progress tracking, visible risk surfacing, and final synthesis, and serves as the default chief-actor candidate."
    ),
    visibility: "always",
    priority: 90,
  },
  {
    id: createActorDocId(),
    key: "mission",
    title: "Mission",
    content: textBlocks(
      "让用户只面对一个稳定入口，也能驱动一整个数字团队有效完成工作。\n\nGive the user one stable point of contact while still unlocking an effective digital team behind the scenes."
    ),
    visibility: "always",
    priority: 88,
  },
  {
    id: createActorDocId(),
    key: "work_doctrine",
    title: "Work Doctrine",
    content: textBlocks(
      [
        "- 中文：先把任务说清楚，再决定是直接处理还是组织协作。",
        "  English: Clarify the ask before deciding whether to solve it directly or coordinate others.",
        "- 中文：只有当专业分工能明显提高质量、速度或风险控制时，才发起委派。",
        "  English: Delegate only when specialization clearly improves quality, speed, or risk control.",
        "- 中文：每次委派都要带上目标、上下文、完成标准和下一次回报码点。",
        "  English: Every handoff needs a goal, context, done condition, and explicit return point.",
        "- 中文：对用户汇报时先给结论、当前状态、主要风险和下一步。",
        "  English: Report to the user with conclusion, current state, main risk, and next step in that order.",
      ].join("\n\n")
    ),
    visibility: "always",
    priority: 86,
  },
  {
    id: createActorDocId(),
    key: "limitations_and_escalation",
    title: "Limitations And Escalation",
    content: textBlocks(
      "你不是最终的领域权威。遇到深度实现、专业判断、创作定稿或高风险决定时，要把任务交给更合适的角色，并在必要时把决定权交还给用户。\n\nYou are not the ultimate domain authority. When the work needs deep implementation, specialist judgment, final creative approval, or high-risk decisions, route it to the right actor and return authority to the user when needed."
    ),
    visibility: "always",
    priority: 84,
  },
  {
    id: createActorDocId(),
    key: "routines",
    title: "Routines",
    content: textBlocks(
      [
        "- 中文：收件时默认检查四件事：目标是否清楚、是否缺上下文、是否需要分工、何时回报。",
        "  English: On intake, default to four checks: goal clarity, missing context, delegation need, and expected return time.",
        "- 中文：每轮协作结束前，都刷新一次“谁在做、做到哪、下一步是什么”的状态摘要。",
        "  English: Before ending a collaboration round, refresh a compact status view of owner, progress, and next step.",
      ].join("\n")
    ),
    visibility: "internal_only",
    priority: 80,
  },
  {
    id: createActorDocId(),
    key: "conversation_examples",
    title: "Conversation Examples",
    content: textBlocks(
      "先把任务交给我。我会先判断哪些部分我能直接完成，哪些部分值得拉人协作，然后给你一个清楚的推进口径。\n\nHand the task to me first. I will decide what I should handle directly, what deserves additional participants, and then give you a clear path forward."
    ),
    visibility: "internal_only",
    priority: 78,
  },
])

export function getActorDocTemplate(
  key: ActorDocKey
): ActorDocTemplate | undefined {
  if (key === "custom") return undefined
  return ACTOR_DOC_TEMPLATE_MAP[key as CoreActorDocKey]
}

function isNonEmptyActorDoc(doc: ActorDoc): boolean {
  return doc.content.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0
    return true
  })
}

export function normalizeActorDocVisibility(
  value: unknown
): ActorDocVisibility {
  if (
    value === "always" ||
    value === "direct_only" ||
    value === "multi_member_only" ||
    value === "internal_only"
  ) {
    return value
  }
  return "always"
}

export function normalizeActorDocs(docs: ActorDocInput[]): ActorDoc[] {
  const standardDocs = new Map<CoreActorDocKey, ActorDoc>()
  const customDocs = new Map<UUID, ActorDoc>()

  for (const doc of docs || []) {
    if (
      !doc ||
      typeof doc !== "object" ||
      !doc.key ||
      !Array.isArray(doc.content)
    )
      continue
    if (doc.key !== "custom" && !(doc.key in ACTOR_DOC_TEMPLATE_MAP)) continue
    const template = getActorDocTemplate(doc.key)
    const normalizedDoc: ActorDoc = {
      id:
        typeof doc.id === "string" && doc.id.trim().length > 0
          ? doc.id
          : createActorDocId(),
      key: doc.key,
      title:
        doc.title?.trim() ||
        template?.title ||
        (doc.key === "custom" ? "Custom section" : doc.key),
      content: normalizeCanonicalContentBlocks(doc.content),
      visibility: normalizeActorDocVisibility(
        doc.visibility || template?.defaultVisibility || "always"
      ),
      priority: Number.isFinite(doc.priority)
        ? doc.priority
        : template?.defaultPriority || 0,
    }

    if (!isNonEmptyActorDoc(normalizedDoc)) continue
    if (normalizedDoc.key === "custom") {
      customDocs.set(normalizedDoc.id, normalizedDoc)
    } else {
      standardDocs.set(normalizedDoc.key as CoreActorDocKey, normalizedDoc)
    }
  }

  return [...standardDocs.values(), ...customDocs.values()].sort(
    (left, right) => {
      if (right.priority !== left.priority)
        return right.priority - left.priority
      return left.title.localeCompare(right.title)
    }
  )
}

export function summarizeActorDoc(doc: ActorDoc, maxLength = 200): string {
  const text = extractText(doc.content).replace(/\s+/g, " ").trim()
  if (text.length > 0) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
  }

  const fileBlock = doc.content.find(
    (
      block
    ): block is Extract<ActorDoc["content"][number], { type: "file_ref" }> =>
      block.type === "file_ref"
  )
  return fileBlock ? `Attached file: ${fileBlock.name}` : ""
}

export function pickActorDocSummary(
  docs: ActorDoc[],
  keys: ActorDocKey[],
  maxLength = 500,
  fallback = ""
): string {
  const fragments = keys
    .map((key) => docs.find((doc) => doc.key === key))
    .filter((doc): doc is ActorDoc => Boolean(doc))
    .map((doc) => summarizeActorDoc(doc, maxLength))
    .filter(Boolean)

  if (fragments.length > 0) {
    return fragments.join("\n\n")
  }

  return fallback
}

export function summarizeActorForRole(
  docs: ActorDoc[],
  fallbackTitle = ""
): string {
  return pickActorDocSummary(
    docs,
    ["role_charter", "mission", "limitations_and_escalation"],
    500,
    fallbackTitle || "No role summary provided."
  )
}

export function summarizeActorForPrompt(docs: ActorDoc[]): string {
  return pickActorDocSummary(
    docs,
    [
      "soul",
      "self_narrative",
      "work_doctrine",
      "social_protocol",
      "representation_guidelines",
      "quirks_and_signatures",
    ],
    700
  )
}
