import {
  normalizeActorDocs,
  textBlocks,
  type ActorDocInput,
  type ActorRole,
} from "@synapse/shared"

export const OFFICIAL_ACTOR_TEMPLATE_VERSION = "1.0.0"
export const OFFICIAL_ACTOR_TEMPLATE_FAMILY = "official-role-library"
export const OFFICIAL_ACTOR_LAUNCH_COLLECTION = "official-roles-v1"

export type SeedActorProfile = {
  displayName: string
  role: ActorRole
  title: string
  avatarFileId?: string
  avatarEmoji?: string
  canRepresentUser: boolean
  docs: ReturnType<typeof normalizeActorDocs>
  specialties: string[]
  config: Record<string, unknown>
}

export type ActorCatalogRefs = {
  slug: string
  actorItemId: string
  actorVersionId: string
  actor: SeedActorProfile
}

export type RuntimeRefs = {
  actorIds: string[]
  chiefActorId: string
}

export type OfficialActorCatalogSeedResult = {
  actorRefs: ActorCatalogRefs[]
  defaultActorRefs: ActorCatalogRefs
}

type BuildActorDocsInput = {
  slug: string
  identity: string
  publicPersona?: string
  soul?: string[]
  selfNarrative?: string
  originStory?: string
  relationship: string
  relationshipWithTeam?: string
  representationGuidelines?: string
  socialProtocol?: string
  mission: string
  roleCharter: string
  workDoctrine: string[]
  limitations?: string
  routines?: string[]
  conversationExample?: string
  extraDocs?: ActorDocInput[]
}

export type OfficialActorTemplateSeed = {
  slug: string
  displayName: string
  summary: string
  longDescription: string
  tags: string[]
  actor: SeedActorProfile
  itemMetadata: Record<string, unknown>
  versionMetadata: Record<string, unknown>
  actorMetadata: Record<string, unknown>
  setupGuide: ReturnType<typeof textBlocks>
  releaseNotes: ReturnType<typeof textBlocks>
}

type CreateOfficialActorTemplateInput = {
  lane: string
  tone: string
  featured?: boolean
  fictionalizedArchetype?: boolean
  slug: string
  displayName: string
  summary: string
  longDescription: string
  tags: string[]
  templateRevision?: string
  actor: {
    displayName: string
    role: ActorRole
    title: string
    avatarEmoji?: string
    canRepresentUser: boolean
    specialties: string[]
    config?: Record<string, unknown>
  }
  docs: Omit<BuildActorDocsInput, "slug">
  setupGuide: string
  releaseNotes?: string
}

export type BuiltInRoleTemplateInput = {
  slug: string
  displayName: string
  summary: string
  longDescription: string
  tags: string[]
  lane: string
  tone: string
  featured?: boolean
  templateRevision?: string
  actor: {
    displayName: string
    role: ActorRole
    title: string
    avatarEmoji?: string
    canRepresentUser?: boolean
    specialties: string[]
    config?: Record<string, unknown>
  }
  vibe: string
  identity: string
  relationship: string
  collaboration: string
  mission: string
  roleCharter: string
  workDoctrine: string[]
  principles?: string[]
  socialProtocol?: string
  representationGuidelines?: string
  limitations?: string
  routines?: string[]
  conversationExample?: string
  setupGuide: string
  releaseNotes?: string
}

export type ImportedBuiltInRoleTemplateInput = {
  slug: string
  displayName: string
  lane: string
  tone: string
  featured?: boolean
  templateRevision?: string
  tags: string[]
  actor: {
    displayName: string
    role: ActorRole
    title?: string
    canRepresentUser?: boolean
    specialties: string[]
  }
  source: {
    description: string
    vibe?: string
    emoji?: string
    color?: string
    userQuery?: string
    authoritativeRoleMarkdown: string
  }
}

export type BilingualCopy = {
  zh: string
  en: string
}

export type CollaborationRoleTemplateInput = {
  slug: string
  displayName: string
  summary: BilingualCopy
  longDescription: BilingualCopy
  tags: string[]
  lane: string
  tone: BilingualCopy
  featured?: boolean
  templateRevision?: string
  actor: {
    displayName: string
    role: ActorRole
    title: string
    avatarEmoji?: string
    canRepresentUser?: boolean
    specialties: string[]
    config?: Record<string, unknown>
  }
  vibe: BilingualCopy
  identity: BilingualCopy
  relationship: BilingualCopy
  collaboration: BilingualCopy
  mission: BilingualCopy
  roleCharter: BilingualCopy
  workDoctrine: BilingualCopy[]
  principles?: BilingualCopy[]
  representationGuidelines?: BilingualCopy
  socialProtocol?: BilingualCopy
  limitations?: BilingualCopy
  routines?: BilingualCopy[]
  conversationExample?: BilingualCopy
  setupGuide: BilingualCopy
  releaseNotes?: BilingualCopy
}

function compact<T>(values: Array<T | null | undefined | false>) {
  return values.filter((value): value is T => Boolean(value))
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  )
}

function bulletList(lines: string[]) {
  return lines.map((line) => `- ${line}`).join("\n")
}

function markdownSection(title: string, body?: string | null) {
  const trimmed = body?.trim()
  if (!trimmed) {
    return ""
  }
  return `## ${title}\n${trimmed}`
}

export function bilingualInline(input: BilingualCopy) {
  return `${input.zh.trim()} / ${input.en.trim()}`
}

export function bilingualBlock(input: BilingualCopy) {
  return `${input.zh.trim()}\n\n${input.en.trim()}`
}

export function bilingualBullet(input: BilingualCopy) {
  return `中文：${input.zh.trim()}\n  English: ${input.en.trim()}`
}

export function bilingualBulletList(items: BilingualCopy[]) {
  return items.map((item) => bilingualBullet(item))
}

function defaultRepresentationGuidelines(title: string) {
  return [
    `当你以${title}身份代用户表达立场、承诺、预算、排期或对外确认时，先基于已知事实起草，再在关键承诺处请求用户确认。`,
    "不要替用户做超出明确授权范围的决定。",
  ].join("\n\n")
}

export function buildActorDocs(input: BuildActorDocsInput) {
  const soulContent = input.soul?.length
    ? markdownSection("核心原则", bulletList(input.soul))
    : ""

  return normalizeActorDocs(
    compact<ActorDocInput>([
      {
        id: `${input.slug}:identity-card`,
        key: "identity_card",
        title: "Identity Card",
        content: textBlocks(input.identity),
        visibility: "always",
        priority: 120,
      },
      input.publicPersona
        ? {
            id: `${input.slug}:public-persona`,
            key: "public_persona",
            title: "Public Persona",
            content: textBlocks(input.publicPersona),
            visibility: "always",
            priority: 115,
          }
        : undefined,
      soulContent
        ? {
            id: `${input.slug}:soul`,
            key: "soul",
            title: "Soul",
            content: textBlocks(soulContent),
            visibility: "always",
            priority: 110,
          }
        : undefined,
      input.selfNarrative
        ? {
            id: `${input.slug}:self-narrative`,
            key: "self_narrative",
            title: "Self Narrative",
            content: textBlocks(input.selfNarrative),
            visibility: "always",
            priority: 105,
          }
        : undefined,
      input.originStory
        ? {
            id: `${input.slug}:origin-story`,
            key: "origin_story",
            title: "Origin Story",
            content: textBlocks(input.originStory),
            visibility: "internal_only",
            priority: 100,
          }
        : undefined,
      {
        id: `${input.slug}:relationship-with-user`,
        key: "relationship_with_user",
        title: "Relationship With User",
        content: textBlocks(input.relationship),
        visibility: "always",
        priority: 98,
      },
      input.relationshipWithTeam
        ? {
            id: `${input.slug}:relationship-with-team`,
            key: "relationship_with_team",
            title: "Relationship With Team",
            content: textBlocks(input.relationshipWithTeam),
            visibility: "multi_member_only",
            priority: 96,
          }
        : undefined,
      input.representationGuidelines
        ? {
            id: `${input.slug}:representation-guidelines`,
            key: "representation_guidelines",
            title: "Representation Guidelines",
            content: textBlocks(input.representationGuidelines),
            visibility: "internal_only",
            priority: 94,
          }
        : undefined,
      input.socialProtocol
        ? {
            id: `${input.slug}:social-protocol`,
            key: "social_protocol",
            title: "Social Protocol",
            content: textBlocks(input.socialProtocol),
            visibility: "multi_member_only",
            priority: 92,
          }
        : undefined,
      {
        id: `${input.slug}:role-charter`,
        key: "role_charter",
        title: "Role Charter",
        content: textBlocks(input.roleCharter),
        visibility: "always",
        priority: 90,
      },
      {
        id: `${input.slug}:mission`,
        key: "mission",
        title: "Mission",
        content: textBlocks(input.mission),
        visibility: "always",
        priority: 88,
      },
      {
        id: `${input.slug}:work-doctrine`,
        key: "work_doctrine",
        title: "Work Doctrine",
        content: textBlocks(bulletList(input.workDoctrine)),
        visibility: "always",
        priority: 86,
      },
      input.limitations
        ? {
            id: `${input.slug}:limitations-and-escalation`,
            key: "limitations_and_escalation",
            title: "Limitations And Escalation",
            content: textBlocks(input.limitations),
            visibility: "always",
            priority: 84,
          }
        : undefined,
      input.routines?.length
        ? {
            id: `${input.slug}:routines`,
            key: "routines",
            title: "Routines",
            content: textBlocks(bulletList(input.routines)),
            visibility: "internal_only",
            priority: 80,
          }
        : undefined,
      input.conversationExample
        ? {
            id: `${input.slug}:conversation-examples`,
            key: "conversation_examples",
            title: "Conversation Examples",
            content: textBlocks(input.conversationExample),
            visibility: "internal_only",
            priority: 78,
          }
        : undefined,
      ...(input.extraDocs || []),
    ])
  )
}

export function createOfficialActorTemplateSeed(
  input: CreateOfficialActorTemplateInput
): OfficialActorTemplateSeed {
  const templateRevision = input.templateRevision || "v1"
  const sharedMetadata = {
    lane: input.lane,
    tone: input.tone,
    featured: input.featured === true,
    fictionalizedArchetype: input.fictionalizedArchetype === true,
    launchCollection: OFFICIAL_ACTOR_LAUNCH_COLLECTION,
    templateFamily: OFFICIAL_ACTOR_TEMPLATE_FAMILY,
    templateRevision,
  }

  return {
    slug: input.slug,
    displayName: input.displayName,
    summary: input.summary,
    longDescription: input.longDescription,
    tags: uniqueStrings(input.tags),
    actor: {
      displayName: input.actor.displayName,
      role: input.actor.role,
      title: input.actor.title,
      avatarEmoji: input.actor.avatarEmoji,
      canRepresentUser: input.actor.canRepresentUser,
      docs: buildActorDocs({
        slug: input.slug,
        ...input.docs,
      }),
      specialties: uniqueStrings(input.actor.specialties),
      config: input.actor.config || {},
    },
    itemMetadata: sharedMetadata,
    versionMetadata: sharedMetadata,
    actorMetadata: sharedMetadata,
    setupGuide: textBlocks(input.setupGuide),
    releaseNotes: textBlocks(
      input.releaseNotes || "官方内置角色模板首发版本。"
    ),
  }
}

export function createBuiltInRoleTemplateSeed(input: BuiltInRoleTemplateInput) {
  return createOfficialActorTemplateSeed({
    lane: input.lane,
    tone: input.tone,
    featured: input.featured,
    slug: input.slug,
    displayName: input.displayName,
    summary: input.summary,
    longDescription: input.longDescription,
    tags: input.tags,
    templateRevision: input.templateRevision,
    actor: {
      displayName: input.actor.displayName,
      role: input.actor.role,
      title: input.actor.title,
      avatarEmoji: input.actor.avatarEmoji,
      canRepresentUser: input.actor.canRepresentUser === true,
      specialties: input.actor.specialties,
      config: input.actor.config || {},
    },
    docs: {
      identity: input.identity,
      publicPersona: input.vibe,
      soul: input.principles,
      selfNarrative: input.identity,
      relationship: input.relationship,
      relationshipWithTeam: input.collaboration,
      representationGuidelines:
        input.representationGuidelines ||
        (input.actor.canRepresentUser
          ? defaultRepresentationGuidelines(input.actor.title)
          : undefined),
      socialProtocol: input.socialProtocol,
      mission: input.mission,
      roleCharter: input.roleCharter,
      workDoctrine: input.workDoctrine,
      limitations: input.limitations,
      routines: input.routines,
      conversationExample: input.conversationExample,
    },
    setupGuide: input.setupGuide,
    releaseNotes: input.releaseNotes,
  })
}

export function createImportedBuiltInRoleTemplateSeed(
  input: ImportedBuiltInRoleTemplateInput
) {
  const title = input.actor.title || input.displayName

  return createOfficialActorTemplateSeed({
    lane: input.lane,
    tone: input.tone,
    featured: input.featured,
    slug: input.slug,
    displayName: input.displayName,
    summary: input.source.description,
    longDescription: input.source.description,
    tags: input.tags,
    templateRevision: input.templateRevision,
    actor: {
      displayName: input.actor.displayName,
      role: input.actor.role,
      title,
      canRepresentUser: input.actor.canRepresentUser === true,
      specialties: input.actor.specialties,
      config: {
        accent_color: input.source.color,
      },
    },
    docs: {
      identity: `你是${input.displayName}。${input.source.description}`,
      publicPersona: input.source.vibe,
      selfNarrative:
        "当前角色文档完整定义了你的专业边界、方法论、质量标准和表达重心，不要把它弱化成普通岗位简介。",
      relationship: input.source.userQuery
        ? `用户通常会在以下场景下召唤你：${input.source.userQuery}`
        : `当用户需要${input.displayName}的专业能力时，会直接向你求助。`,
      representationGuidelines:
        input.actor.canRepresentUser === true
          ? defaultRepresentationGuidelines(title)
          : undefined,
      mission: `以${input.displayName}身份，忠实执行当前角色文档中的职责、方法与质量标准。`,
      roleCharter:
        "以当前角色文档为主，不得擅自删减关键规则、方法论、成功标准或专业边界。",
      workDoctrine: [
        "先读取并遵循当前角色说明文档。",
        "尽量保留当前角色设定中的工作流、禁忌、成功标准和沟通方式。",
        "如果角色说明与系统全局规则冲突，以系统规则为上限，其余部分保持一致。",
      ],
      conversationExample: input.source.userQuery,
      extraDocs: compact<ActorDocInput>([
        {
          id: `${input.slug}:authoritative-role-prompt`,
          key: "custom",
          title: "Role Manual",
          content: textBlocks(input.source.authoritativeRoleMarkdown),
          visibility: "always",
          priority: 112,
        },
        input.source.userQuery
          ? {
              id: `${input.slug}:source-user-query`,
              key: "custom",
              title: "Source User Query",
              content: textBlocks(input.source.userQuery),
              visibility: "internal_only",
              priority: 77,
            }
          : undefined,
      ]),
    },
    setupGuide: `安装后会使用 ${input.displayName} 的完整角色说明。`,
    releaseNotes: "更新为完整角色说明版本。",
  })
}

const DEFAULT_COLLABORATION_ROLE_RELEASE_NOTES: BilingualCopy = {
  zh: "重写为面向 Synapse 群聊协作的官方双语岗位模板，移除了旧的外部长提示词搬运结构。",
  en: "Rewritten as an official bilingual role template for Synapse-style group collaboration, replacing the old imported long-prompt structure.",
}

export function createCollaborationRoleTemplateSeed(
  input: CollaborationRoleTemplateInput
) {
  return createBuiltInRoleTemplateSeed({
    slug: input.slug,
    displayName: input.displayName,
    summary: bilingualInline(input.summary),
    longDescription: bilingualBlock(input.longDescription),
    tags: uniqueStrings(input.tags),
    lane: input.lane,
    tone: bilingualInline(input.tone),
    featured: input.featured,
    templateRevision: input.templateRevision || "collaboration-v2",
    actor: {
      displayName: input.actor.displayName,
      role: input.actor.role,
      title: input.actor.title,
      avatarEmoji: input.actor.avatarEmoji,
      canRepresentUser: input.actor.canRepresentUser === true,
      specialties: uniqueStrings(input.actor.specialties),
      config: input.actor.config || {},
    },
    vibe: bilingualBlock(input.vibe),
    identity: bilingualBlock(input.identity),
    relationship: bilingualBlock(input.relationship),
    collaboration: bilingualBlock(input.collaboration),
    mission: bilingualBlock(input.mission),
    roleCharter: bilingualBlock(input.roleCharter),
    workDoctrine: bilingualBulletList(input.workDoctrine),
    principles: input.principles
      ? bilingualBulletList(input.principles)
      : undefined,
    representationGuidelines: input.representationGuidelines
      ? bilingualBlock(input.representationGuidelines)
      : undefined,
    socialProtocol: input.socialProtocol
      ? bilingualBlock(input.socialProtocol)
      : undefined,
    limitations: input.limitations
      ? bilingualBlock(input.limitations)
      : undefined,
    routines: input.routines ? bilingualBulletList(input.routines) : undefined,
    conversationExample: input.conversationExample
      ? bilingualBlock(input.conversationExample)
      : undefined,
    setupGuide: bilingualBlock(input.setupGuide),
    releaseNotes: bilingualBlock(
      input.releaseNotes || DEFAULT_COLLABORATION_ROLE_RELEASE_NOTES
    ),
  })
}
