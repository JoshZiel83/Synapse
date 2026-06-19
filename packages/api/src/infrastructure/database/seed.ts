import crypto from "node:crypto"
import fs from "node:fs/promises"
import { hashPassword } from "better-auth/crypto"
import { basename, dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "url"
import { SUBJECT_KIND, textBlocks } from "@synapse/shared"
import { upsertAccessSubject } from "../../modules/access/subject-registry.js"
import { createGeneratedUserAvatarFile } from "../../modules/avatar/service.js"
import { seedBuiltinMcpPlugins } from "../../modules/mcp-plugins/service.js"
import { ensureSeedPlatformAdminForUser } from "../../modules/platform/admin-service.js"
import { importSeededClawhubMarketplaceSkill } from "../../modules/skills/service.js"
import { ensureStorageDir } from "../storage/index.js"
import { sql } from "kysely"
import type { CatalogVersionFilesFileRole } from "./generated/db.js"
import { db } from "./kysely.js"
import { parseSeedSkillMetadataJson } from "./seed-metadata-codec.js"
import { ensurePublisher } from "./seed-utils.js"
import {
  seedOfficialActorCatalog,
  seedOfficialRuntimeActors,
} from "./seeds/actors/seed-official-actors.js"

/**
 * Idempotently seed a Better-Auth credential user: the `users` row + a
 * `credential` `account` row (account_id = user id) carrying the BA scrypt
 * password hash + a generated avatar. We write directly (not via signUpEmail)
 * to stay idempotent and avoid minting a throwaway seed session; that means the
 * BA user.create.after avatar hook does NOT fire, so we generate the avatar here.
 */
async function seedCredentialUser(input: {
  email: string
  name: string
  password: string
  emailVerified?: boolean
}): Promise<{ id: string }> {
  const passwordHash = await hashPassword(input.password)
  const userRow = await sql<{ id: string }>`
    INSERT INTO users (email, name, email_verified)
    VALUES (${input.email}, ${input.name}, ${input.emailVerified ?? true})
    ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET
      name = EXCLUDED.name,
      email_verified = EXCLUDED.email_verified
    RETURNING id`.execute(db)
  const userId = userRow.rows[0]!.id

  await sql`
    INSERT INTO account (account_id, provider_id, user_id, password)
    VALUES (${userId}, 'credential', ${userId}, ${passwordHash})
    ON CONFLICT (provider_id, account_id) WHERE deleted_at IS NULL DO UPDATE SET
      password = EXCLUDED.password`.execute(db)

  const avatar = await createGeneratedUserAvatarFile(db, {
    userId,
    name: input.name,
    email: input.email,
  })
  await sql`
    UPDATE users
    SET avatar_file_id = ${avatar.fileId}
    WHERE id = ${userId} AND avatar_file_id IS NULL`.execute(db)

  return { id: userId }
}

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
  const result = await sql<{ id: string }>`
    INSERT INTO workspaces (name, slug, description, owner_id, is_trusted)
    VALUES ('Yihang', 'yihang', 'Refactored workspace seed', ${userId}, TRUE)
    ON CONFLICT (slug) WHERE deleted_at IS NULL DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_trusted = EXCLUDED.is_trusted
    RETURNING id`.execute(db)
  const workspaceId = result.rows[0]!.id

  const memberResult = await sql<{ id: string }>`
    INSERT INTO workspace_members (workspace_id, user_id, trust_level)
    VALUES (${workspaceId}, ${userId}, 'admin')
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET trust_level = 'admin'
    RETURNING id`.execute(db)
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
    await sql`
      INSERT INTO workspace_relationship_profiles (
        workspace_id,
        subject_id,
        identity_search_enabled,
        approval_mode,
        qr_token,
        created_by_workspace_member_id
      )
      VALUES (
        ${params.workspaceId},
        ${subjectId},
        TRUE,
        'auto',
        ${crypto.randomUUID()},
        ${params.workspaceMemberId}
      )
      ON CONFLICT (workspace_id, subject_id)
      DO UPDATE SET
        identity_search_enabled = EXCLUDED.identity_search_enabled,
        approval_mode = EXCLUDED.approval_mode`.execute(db)
  }

  if (params.actorIds.length === 0) {
    return
  }

  await sql`
    UPDATE actors
    SET is_public_shared = TRUE
    WHERE EXISTS (
      SELECT 1
      FROM workspace_resources resource
      WHERE resource.id = actors.id
        AND resource.workspace_id = ${params.workspaceId}
        AND resource.deleted_at IS NULL
    )
      AND id = ANY(${params.actorIds}::uuid[])`.execute(db)
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

  const metadata = parseSeedSkillMetadataJson(
    await fs.readFile(metadataPath, "utf8"),
    `seed skill metadata in ${metadataPath}`
  )

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
  const result = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM catalog_items
    WHERE item_kind = ${itemKind}
      AND workspace_id IS NULL
      AND is_active = TRUE`.execute(db)
  return Number(result.rows[0]?.count || 0)
}

export async function seedDatabase() {
  console.log("Seeding refactored database...")
  await ensureStorageDir()

  const { id: userId } = await seedCredentialUser({
    email: "demo@synapse.dev",
    name: "Demo User",
    password: "demo1234",
    emailVerified: true,
  })

  // Seed/bootstrap is the ONLY path that grants platform super_admin (see the
  // removed startup config-email auto-grant in index.ts).
  await ensureSeedPlatformAdminForUser({
    id: userId,
    email: "demo@synapse.dev",
  })

  const { id: ordinaryUserId } = await seedCredentialUser({
    email: "yihang@synapse.dev",
    name: "Yihang",
    password: "demo1234",
    emailVerified: true,
  })

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
  await sql`
    INSERT INTO workspace_member_preferences
      (workspace_member_id, chief_actor_id, created_at, updated_at)
    VALUES (${workspaceMemberId}, ${runtimeRefs.chiefActorId}, NOW(), NOW())
    ON CONFLICT (workspace_member_id)
    DO UPDATE SET
      chief_actor_id = EXCLUDED.chief_actor_id`.execute(db)
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
