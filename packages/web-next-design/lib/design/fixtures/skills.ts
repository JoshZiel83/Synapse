// Curated Skills fixtures — a realistic set of installable AI-agent skill modules
// (Chinese, real use-cases) for the card-based Skills page, replacing the random
// faker output (lorem names, "Unknown" dates, English) in the old table.
import type {
  InstalledSkillView,
  SkillMarketplaceEntryView,
} from "@synapse/shared"
import { dateToIsoInstant } from "@synapse/shared/datetime"
import { designWorkspaceId, designWorkspaceMemberId } from "./identity"

const ts = (iso: string) => dateToIsoInstant(new Date(iso))
const WS = designWorkspaceId

type Block = InstalledSkillView["description"]
const descBlock = (text: string): Block =>
  ({ type: "text", text }) as unknown as Block

type Subject = InstalledSkillView["accessTarget"]["subject"]
const SUBJECTS: Record<string, Subject> = {
  workspace: { kind: "workspace", workspaceId: WS } as Subject,
  member: {
    kind: "workspace_member",
    workspaceMemberId: designWorkspaceMemberId,
  } as Subject,
  actor: { kind: "actor", actorId: "act-aria" } as unknown as Subject,
}

function mirror(
  sourceType: "github" | "clawhub",
  status: "synced" | "error" | "pending",
  locator: string
) {
  return {
    id: `mir-${locator}`,
    sourceType,
    locatorKey: locator,
    locator: { repo: locator },
    refreshMode: "manual" as const,
    lastSyncStatus: status,
    sourceWarnings: [] as string[],
    lastError: status === "error" ? "拉取失败：仓库返回 404" : undefined,
    lastSyncedAt: status === "synced" ? ts("2026-07-03T09:00:00Z") : undefined,
    createdAt: ts("2026-06-10T08:00:00Z"),
    updatedAt: ts("2026-07-03T09:00:00Z"),
  }
}

let seq = 0
function installed(o: {
  slug: string
  name: string
  desc: string
  effort?: "low" | "medium" | "high" | "max"
  tags?: string[]
  scope?: keyof typeof SUBJECTS
  enabled?: boolean
  manual?: boolean
  tools?: string[]
  mirrorKind?: "github" | "clawhub"
  syncStatus?: "synced" | "error" | "pending"
  upgrade?: boolean
  fromMarket?: boolean
  customized?: boolean
}): InstalledSkillView {
  seq += 1
  const m = o.mirrorKind
    ? mirror(o.mirrorKind, o.syncStatus ?? "synced", o.slug)
    : undefined
  return {
    id: `sk-${o.slug}`,
    workspaceId: WS,
    displayName: o.name,
    frontmatter: {
      name: o.name,
      description: o.desc,
      disableModelInvocation: o.manual ?? false,
      userInvocable: true,
      allowedTools: o.tools ?? [],
      effort: o.effort,
    },
    bodyBlocks: [descBlock(o.desc)],
    entryPath: `skills/${o.slug}/SKILL.md`,
    contentHash: `hash-${o.slug}`,
    sourceWarnings: [],
    description: descBlock(o.desc),
    tags: o.tags ?? [],
    accessTarget: { subject: SUBJECTS[o.scope ?? "workspace"] },
    isEnabled: o.enabled ?? true,
    workspaceConversationTypeMask: 15,
    effectiveConversationTypeMask: 15,
    isCustomized: o.customized ?? false,
    createdAt: ts("2026-06-15T08:00:00Z"),
    updatedAt: ts("2026-07-02T08:00:00Z"),
    sourceSkillId: o.fromMarket ? `mk-${o.slug}` : undefined,
    sourcePackageSlug: o.fromMarket ? o.slug : undefined,
    sourceVersion: m || o.fromMarket ? "v1.0.0" : undefined,
    upgradeAvailable: o.upgrade ?? false,
    latestSourceVersion: o.upgrade ? "v1.2.0" : undefined,
    mirrorSource: m,
  }
}

export const designInstalledSkills: InstalledSkillView[] = [
  installed({
    slug: "code-review",
    name: "代码评审",
    desc: "自动审查 PR 的正确性、边界情况与风格问题。当有人请求 review 或提交代码时使用。",
    effort: "high",
    tags: ["工程", "评审"],
    tools: ["read", "grep"],
    scope: "workspace",
  }),
  installed({
    slug: "pdf-extract",
    name: "PDF 提取",
    desc: "从 PDF 中提取结构化文本与表格。当收到 PDF 附件需要读取内容时使用。",
    effort: "medium",
    tags: ["文档"],
    scope: "actor",
  }),
  installed({
    slug: "web-scrape",
    name: "网页抓取",
    desc: "抓取网页并转成干净的 Markdown。需要引用外部网页内容时使用。",
    tags: ["数据", "网络"],
    mirrorKind: "github",
    syncStatus: "synced",
    scope: "workspace",
  }),
  installed({
    slug: "translate",
    name: "翻译润色",
    desc: "中英互译并润色为地道表达。需要翻译或润色文案时使用。",
    effort: "low",
    tags: ["写作"],
    enabled: false,
    scope: "member",
    manual: true,
  }),
  installed({
    slug: "chart",
    name: "数据可视化",
    desc: "把数据表转成图表。需要生成图表时使用。",
    tags: ["数据"],
    mirrorKind: "github",
    syncStatus: "error",
    upgrade: true,
    scope: "workspace",
    customized: true,
  }),
]

function market(o: {
  slug: string
  name: string
  desc: string
  tags?: string[]
  author?: string
  installed?: boolean
  installedCount?: number
  mirrorKind?: "github" | "clawhub"
}): SkillMarketplaceEntryView {
  return {
    id: `mk-${o.slug}`,
    slug: o.slug,
    name: o.name,
    frontmatter: {
      name: o.name,
      description: o.desc,
      disableModelInvocation: false,
      userInvocable: true,
      allowedTools: [],
    },
    bodyBlocks: [descBlock(o.desc)],
    description: descBlock(o.desc),
    tags: o.tags ?? [],
    authorName: o.author ?? "Synapse 官方",
    isActive: true,
    createdAt: ts("2026-05-01T08:00:00Z"),
    updatedAt: ts("2026-06-28T08:00:00Z"),
    latestVersion: undefined,
    mirrorSource: o.mirrorKind
      ? mirror(o.mirrorKind, "synced", o.slug)
      : undefined,
    workspaceInstallation: {
      installed: o.installed ?? false,
      installedSkillId: o.installed ? `sk-${o.slug}` : undefined,
      installedCount: o.installedCount ?? 0,
    },
  }
}

export const designMarketplaceSkills: SkillMarketplaceEntryView[] = [
  market({
    slug: "sql-assistant",
    name: "SQL 助手",
    desc: "把自然语言问题翻译成 SQL 并解释结果。需要查询数据库时使用。",
    tags: ["数据", "工程"],
    installedCount: 128,
  }),
  market({
    slug: "meeting-notes",
    name: "会议纪要",
    desc: "把会议录音/转写整理成结构化纪要与行动项。",
    tags: ["写作", "效率"],
    installed: true,
    installedCount: 342,
  }),
  market({
    slug: "competitor-research",
    name: "竞品调研",
    desc: "抓取并对比竞品的功能、定价与定位，产出调研表。",
    tags: ["调研", "网络"],
    author: "研究工作区",
    mirrorKind: "github",
    installedCount: 76,
  }),
  market({
    slug: "contract-review",
    name: "合同审查",
    desc: "标注合同风险条款并给出修改建议。需要审查合同时使用。",
    tags: ["法务"],
    author: "ClawHub 社区",
    mirrorKind: "clawhub",
    installedCount: 54,
  }),
  market({
    slug: "excel-analyze",
    name: "Excel 分析",
    desc: "对上传的表格做透视、清洗与统计分析。",
    tags: ["数据"],
    installedCount: 210,
  }),
  market({
    slug: "image-gen",
    name: "图片生成",
    desc: "根据描述生成配图或示意图。需要插图时使用。",
    tags: ["创意"],
    installedCount: 189,
  }),
]

export const findInstalledSkill = (id: string) =>
  designInstalledSkills.find(
    (s) => s.id === id || s.id === `sk-${id}` || s.sourcePackageSlug === id
  )
export const findMarketSkill = (id: string) =>
  designMarketplaceSkills.find((s) => s.id === id || s.slug === id)
