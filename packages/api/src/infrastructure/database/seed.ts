import crypto from "node:crypto"
import fs from "node:fs/promises"
import bcryptjs from "bcryptjs"
import { basename, dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "url"
import { SUBJECT_KIND, textBlocks } from "@synapse/shared"
import { upsertAccessSubject } from "../../modules/access/subject-registry.js"
import { createGeneratedUserAvatarFile } from "../../modules/avatar/service.js"
import { seedBuiltinMcpPlugins } from "../../modules/mcp-plugins/service.js"
import { seedPlatformDefaultGroup } from "../../modules/model-groups/service.js"
import { ensureSeedPlatformAdminForUser } from "../../modules/platform/admin-service.js"
import { importSeededClawhubMarketplaceSkill } from "../../modules/skills/service.js"
import { ensureStorageDir } from "../storage/index.js"
import { transaction } from "./index.js"
import type { CatalogVersionFilesFileRole } from "./generated/db.js"
import { db } from "./kysely.js"
import { executeSql, executeSqlOn } from "./kysely.js"
import { ensurePublisher } from "./seed-utils.js"
import {
  seedOfficialActorCatalog,
  seedOfficialRuntimeActors,
} from "./seeds/actors/seed-official-actors.js"

const { hash } = bcryptjs
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CLAWHUB_SKILLS_DIR = resolve(
  __dirname,
  "../../../../../.setup/skills/clawhub/skills"
)

const CLAWHUB_PUBLISHER_SLUG = "clawhub-official"

type CatalogFileRole = CatalogVersionFilesFileRole

type ImportedSkillFile = {
  path: string
  fileRole: CatalogFileRole
  mediaType: string
  textContent: string
  contentBlocks: ReturnType<typeof textBlocks>
  sha256: string
  sizeBytes: number
}

type ImportedSkillPackage = {
  slug: string
  version: string
  name: string
  description: string
  tags: string[]
  ownerId?: string
  publishedAt?: number
  files: ImportedSkillFile[]
}

async function seedDemoWorkspace(userId: string) {
  const result = await executeSql<{ id: string }>(
    `INSERT INTO workspaces (name, slug, description, owner_id, is_trusted)
     VALUES ('Yihang', 'yihang', 'Refactored workspace seed', $1, TRUE)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       is_trusted = EXCLUDED.is_trusted,
       updated_at = NOW()
     RETURNING id`,
    [userId]
  )
  const workspaceId = result.rows[0]!.id

  const memberResult = await executeSql<{ id: string }>(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET trust_level = 'admin'
     RETURNING id`,
    [workspaceId, userId]
  )
  const workspaceMemberId = memberResult.rows[0]!.id

  return { workspaceId, workspaceMemberId }
}

async function seedDefaultActorDiscoveryProfiles(params: {
  workspaceId: string
  workspaceMemberId: string
  actorIds: string[]
}) {
  for (const actorId of params.actorIds) {
    const subjectId = await upsertAccessSubject(db, {
      kind: SUBJECT_KIND.ACTOR,
      actorId,
    })
    await executeSql(
      `INSERT INTO workspace_relationship_profiles (
         workspace_id,
         subject_id,
         identity_search_enabled,
         approval_mode,
         qr_token,
         created_by_workspace_member_id
       )
       VALUES ($1, $2, TRUE, 'auto', $3, $4)
       ON CONFLICT (workspace_id, subject_id)
       DO UPDATE SET
         identity_search_enabled = EXCLUDED.identity_search_enabled,
         approval_mode = EXCLUDED.approval_mode,
         updated_at = NOW()`,
      [
        params.workspaceId,
        subjectId,
        crypto.randomUUID(),
        params.workspaceMemberId,
      ]
    )
  }

  if (params.actorIds.length === 0) {
    return
  }

  await executeSql(
    `UPDATE actors
     SET is_public_shared = TRUE,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = ANY($2::uuid[])`,
    [params.workspaceId, params.actorIds]
  )
}

function sha256Hex(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function normalizeForComparison(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

function humanizeSlug(slug: string) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (value) => value.toUpperCase())
}

function trimWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseSimpleFrontmatter(markdown: string) {
  if (!markdown.startsWith("---\n")) {
    return {
      attributes: {} as Record<string, string>,
      body: markdown,
    }
  }

  const endIndex = markdown.indexOf("\n---\n", 4)
  if (endIndex === -1) {
    return {
      attributes: {} as Record<string, string>,
      body: markdown,
    }
  }

  const rawFrontmatter = markdown.slice(4, endIndex)
  const body = markdown.slice(endIndex + 5)
  const attributes: Record<string, string> = {}

  for (const line of rawFrontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":")
    if (separatorIndex <= 0) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = trimWrappingQuotes(line.slice(separatorIndex + 1).trim())
    if (key && value) {
      attributes[key] = value
    }
  }

  return { attributes, body }
}

function extractHeading(markdownBody: string) {
  for (const line of markdownBody.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^#\s+(.+)$/)
    if (!match) continue
    return match[1]!.replace(/\s+skill$/i, "").trim()
  }
  return ""
}

function extractSummaryParagraph(markdownBody: string) {
  const lines = markdownBody.split("\n")
  let inCodeFence = false
  let currentParagraph: string[] = []

  const flushParagraph = () => {
    if (currentParagraph.length === 0) {
      return ""
    }
    const paragraph = currentParagraph.join(" ").trim()
    currentParagraph = []
    return paragraph
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence
      const paragraph = flushParagraph()
      if (paragraph) return paragraph
      continue
    }
    if (inCodeFence) {
      continue
    }
    if (!line) {
      const paragraph = flushParagraph()
      if (paragraph) return paragraph
      continue
    }
    if (
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      /^\d+\.\s/.test(line)
    ) {
      const paragraph = flushParagraph()
      if (paragraph) return paragraph
      continue
    }
    currentParagraph.push(line)
  }

  return flushParagraph()
}

function deriveSkillName(
  slug: string,
  frontmatterName: string | undefined,
  heading: string
) {
  const cleanedFrontmatterName = (frontmatterName || "").trim()
  if (
    heading &&
    normalizeForComparison(heading) !== normalizeForComparison(slug)
  ) {
    return heading
  }
  if (
    cleanedFrontmatterName &&
    normalizeForComparison(cleanedFrontmatterName) !==
      normalizeForComparison(slug)
  ) {
    return cleanedFrontmatterName
  }
  if (heading) {
    return normalizeForComparison(heading) === normalizeForComparison(slug)
      ? humanizeSlug(slug)
      : heading
  }
  if (cleanedFrontmatterName) {
    return normalizeForComparison(cleanedFrontmatterName) ===
      normalizeForComparison(slug)
      ? humanizeSlug(slug)
      : cleanedFrontmatterName
  }
  return humanizeSlug(slug)
}

function deriveSkillDescription(
  name: string,
  frontmatterDescription: string | undefined,
  markdownBody: string
) {
  const description = (frontmatterDescription || "").trim()
  if (description) {
    return description
  }

  const paragraph = extractSummaryParagraph(markdownBody)
  if (paragraph) {
    return paragraph
  }

  return `Official skill package for ${name}.`
}

function deriveSkillTags(slug: string) {
  return Array.from(
    new Set(
      slug
        .split(/[-_]+/g)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

async function walkFiles(baseDir: string, currentDir = ""): Promise<string[]> {
  const directory = currentDir ? resolve(baseDir, currentDir) : baseDir
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const result: string[] = []

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (entry.name.startsWith(".")) {
      continue
    }

    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      result.push(...(await walkFiles(baseDir, relativePath)))
      continue
    }

    if (!entry.isFile() || entry.name === "_meta.json") {
      continue
    }

    result.push(relativePath.replace(/\\/g, "/"))
  }

  return result
}

function inferCatalogFileRole(relativePath: string): CatalogFileRole {
  const normalized = relativePath.replace(/\\/g, "/")
  const fileName = basename(normalized).toLowerCase()
  const extension = extname(normalized).toLowerCase()

  if (fileName === "skill.md" || fileName === "readme.md") {
    return "document"
  }
  if (extension === ".json") {
    return "json"
  }
  if (
    [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".sh",
      ".bash",
      ".mjs",
      ".cjs",
    ].includes(extension)
  ) {
    return "script"
  }
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
    return "image"
  }
  if (
    [".md", ".txt", ".yml", ".yaml", ".css", ".html", ".xml"].includes(
      extension
    )
  ) {
    return "reference"
  }
  return "binary"
}

function inferMediaType(relativePath: string) {
  const extension = extname(relativePath).toLowerCase()
  switch (extension) {
    case ".md":
      return "text/markdown"
    case ".txt":
      return "text/plain"
    case ".csv":
      return "text/csv"
    case ".json":
      return "application/json"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript"
    case ".ts":
      return "text/typescript"
    case ".tsx":
      return "text/tsx"
    case ".jsx":
      return "text/jsx"
    case ".py":
      return "text/x-python"
    case ".sh":
    case ".bash":
      return "text/x-shellscript"
    case ".css":
      return "text/css"
    case ".html":
      return "text/html"
    case ".xml":
      return "application/xml"
    case ".yaml":
    case ".yml":
      return "application/yaml"
    case ".svg":
      return "image/svg+xml"
    default:
      return "text/plain"
  }
}

function isTextImportableFile(relativePath: string) {
  const extension = extname(relativePath).toLowerCase()
  return [
    ".md",
    ".txt",
    ".csv",
    ".json",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".sh",
    ".bash",
    ".mjs",
    ".cjs",
    ".css",
    ".html",
    ".xml",
    ".yaml",
    ".yml",
    ".svg",
  ].includes(extension)
}

async function readImportedSkillPackage(
  skillDirName: string
): Promise<ImportedSkillPackage> {
  const skillDir = resolve(CLAWHUB_SKILLS_DIR, skillDirName)
  const metadataPath = resolve(skillDir, "_meta.json")
  const skillMarkdownPath = resolve(skillDir, "SKILL.md")

  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
    ownerId?: string
    slug?: string
    version?: string
    publishedAt?: number
  }

  const markdown = await fs.readFile(skillMarkdownPath, "utf8")
  const { attributes, body } = parseSimpleFrontmatter(markdown)
  const heading = extractHeading(body)
  const slug = (metadata.slug || skillDirName).trim()
  const name = deriveSkillName(slug, attributes.name, heading)
  const description = deriveSkillDescription(name, attributes.description, body)

  const filePaths = await walkFiles(skillDir)
  const files: ImportedSkillFile[] = []

  for (const relativePath of filePaths) {
    if (!isTextImportableFile(relativePath)) {
      console.warn(
        `[db.seed] Skipping unsupported binary skill asset ${slug}/${relativePath}`
      )
      continue
    }

    const absolutePath = resolve(skillDir, relativePath)
    const buffer = await fs.readFile(absolutePath)
    const textContent = buffer.toString("utf8")

    files.push({
      path: relativePath,
      fileRole: inferCatalogFileRole(relativePath),
      mediaType: inferMediaType(relativePath),
      textContent,
      contentBlocks: textBlocks(textContent),
      sha256: sha256Hex(buffer),
      sizeBytes: buffer.length,
    })
  }

  return {
    slug,
    version: (metadata.version || "1.0.0").trim(),
    name,
    description,
    tags: deriveSkillTags(slug),
    ownerId: metadata.ownerId,
    publishedAt: metadata.publishedAt,
    files,
  }
}

async function loadClawHubSkillPackages() {
  const entries = await fs.readdir(CLAWHUB_SKILLS_DIR, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  const skills: ImportedSkillPackage[] = []
  for (const directory of directories) {
    skills.push(await readImportedSkillPackage(directory))
  }
  return skills
}

async function seedOfficialSkills(userId: string) {
  const entries = await fs.readdir(CLAWHUB_SKILLS_DIR, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => resolve(CLAWHUB_SKILLS_DIR, entry.name))
    .sort((left, right) => left.localeCompare(right))

  for (const skillDir of directories) {
    await importSeededClawhubMarketplaceSkill({
      skillDir,
      authorUserId: userId,
    })
  }

  return directories.length
}

async function countCatalogItems(
  itemKind: "actor_template" | "skill_package" | "plugin_package"
) {
  const result = await executeSql<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM catalog_items
     WHERE item_kind = $1
       AND workspace_id IS NULL
       AND is_active = TRUE`,
    [itemKind]
  )
  return Number(result.rows[0]?.count || 0)
}

export async function seedDatabase() {
  console.log("Seeding refactored database...")
  await ensureStorageDir()

  const passwordHash = await hash("demo1234", 10)
  const userResult = await executeSql<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('demo@synapse.dev', 'Demo User', $1)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()
     RETURNING id`,
    [passwordHash]
  )
  const userId = userResult.rows[0]!.id

  const demoUserAvatar = await createGeneratedUserAvatarFile(
    { query: executeSql },
    {
      userId,
      name: "Demo User",
      email: "demo@synapse.dev",
    }
  )
  await executeSql(
    `UPDATE users
     SET avatar_file_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [userId, demoUserAvatar.fileId]
  )

  await ensureSeedPlatformAdminForUser({
    id: userId,
    email: "demo@synapse.dev",
  })

  const ordinaryUserResult = await executeSql<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('yihang@synapse.dev', 'Yihang', $1)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()
     RETURNING id`,
    [passwordHash]
  )
  const ordinaryUserId = ordinaryUserResult.rows[0]!.id

  const ordinaryUserAvatar = await createGeneratedUserAvatarFile(
    { query: executeSql },
    {
      userId: ordinaryUserId,
      name: "Yihang",
      email: "yihang@synapse.dev",
    }
  )
  await executeSql(
    `UPDATE users
     SET avatar_file_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [ordinaryUserId, ordinaryUserAvatar.fileId]
  )

  await seedPlatformDefaultGroup()

  const { workspaceId, workspaceMemberId } = await seedDemoWorkspace(userId)
  const actorCatalog = await seedOfficialActorCatalog(userId)
  const importedSkillCount = await seedOfficialSkills(userId)
  await seedBuiltinMcpPlugins()
  const runtimeRefs = await seedOfficialRuntimeActors(
    workspaceId,
    workspaceMemberId,
    actorCatalog.actorRefs
  )
  await seedDefaultActorDiscoveryProfiles({
    workspaceId,
    workspaceMemberId,
    actorIds: runtimeRefs.actorIds,
  })
  await executeSql(
    `INSERT INTO workspace_member_preferences
       (workspace_member_id, chief_actor_id, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (workspace_member_id)
     DO UPDATE SET
       chief_actor_id = EXCLUDED.chief_actor_id,
       updated_at = NOW()`,
    [workspaceMemberId, runtimeRefs.chiefActorId]
  )
  const [actorMarketplaceCount, skillMarketplaceCount, pluginMarketplaceCount] =
    await Promise.all([
      countCatalogItems("actor_template"),
      countCatalogItems("skill_package"),
      countCatalogItems("plugin_package"),
    ])

  console.log("Seed completed", {
    userId,
    workspaceId,
    actorCount: runtimeRefs.actorIds.length,
    chiefActorId: runtimeRefs.chiefActorId,
    actorMarketplaceCount,
    importedSkillCount,
    skillMarketplaceCount,
    pluginMarketplaceCount,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  seedDatabase()
    .then(() => {
      process.exit(0)
    })
    .catch((err) => {
      console.error("Seed failed:", err)
      process.exit(1)
    })
}
