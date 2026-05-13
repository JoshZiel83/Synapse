import crypto from "node:crypto"
import { extname } from "node:path"
import yaml from "js-yaml"
import {
  normalizeCanonicalContentBlocks,
  textBlocks,
  textBlock,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  type SkillFrontmatter,
  type SkillFrontmatterContext,
  type SkillFrontmatterEffort,
} from "@synapse/shared"

export const SKILL_ENTRY_PATH = "SKILL.md"
const LEGACY_SKILL_ENTRY_PATH = "Skill.md"
const VALID_SKILL_CONTEXTS: SkillFrontmatterContext[] = ["fork"]
const VALID_SKILL_EFFORTS: SkillFrontmatterEffort[] = [
  "low",
  "medium",
  "high",
  "max",
]

export type SkillFileInput = {
  path: string
  contentBlocks: CanonicalContentBlockInput[]
  mediaType?: string
}

export type NormalizedSkillFile = {
  path: string
  contentBlocks: CanonicalContentBlock[]
  mediaType?: string
}

export type ParsedSkillManifest = {
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  sourceWarnings: string[]
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

function firstSummaryParagraph(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  let inFence = false
  let paragraph: string[] = []

  const flush = () => {
    const value = paragraph.join(" ").trim()
    paragraph = []
    return value
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith("```")) {
      inFence = !inFence
      const value = flush()
      if (value) return value
      continue
    }
    if (inFence) continue
    if (!line) {
      const value = flush()
      if (value) return value
      continue
    }
    if (
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      /^\d+\.\s/.test(line)
    ) {
      const value = flush()
      if (value) return value
      continue
    }
    paragraph.push(line)
  }

  return flush()
}

export function normalizeSkillCommandName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

export function normalizeSkillFilePath(input: string) {
  const value = input.replace(/\\/g, "/").trim()
  const lowered = value.toLowerCase()
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`Invalid skill file path: ${input}`)
  }

  const segments = value.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid skill file path: ${input}`)
  }

  const normalized = segments.join("/")
  if (lowered === SKILL_ENTRY_PATH.toLowerCase()) {
    return SKILL_ENTRY_PATH
  }
  if (lowered === LEGACY_SKILL_ENTRY_PATH.toLowerCase()) {
    return SKILL_ENTRY_PATH
  }
  return normalized
}

export function inferSkillMediaType(path: string) {
  switch (extname(path).toLowerCase()) {
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
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    default:
      return "application/octet-stream"
  }
}

export function normalizeSkillFiles(files?: SkillFileInput[]) {
  const normalized = (files || []).map((file) => ({
    path: normalizeSkillFilePath(file.path),
    mediaType: file.mediaType || inferSkillMediaType(file.path),
    contentBlocks: normalizeCanonicalContentBlocks(
      Array.isArray(file.contentBlocks) ? file.contentBlocks : []
    ),
  }))

  const seen = new Set<string>()
  for (const file of normalized) {
    if (seen.has(file.path)) {
      throw new Error(`Duplicate skill file path: ${file.path}`)
    }
    seen.add(file.path)
  }

  return normalized
}

function parseStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => trimWrappingQuotes(item.trim()))
      .filter(Boolean)
  }
  return [] as string[]
}

function parseFrontmatterSection(markdown: string) {
  if (!markdown.startsWith("---\n")) {
    return {
      attributes: {} as Record<string, unknown>,
      body: markdown,
    }
  }

  const endIndex = markdown.indexOf("\n---\n", 4)
  if (endIndex === -1) {
    return {
      attributes: {} as Record<string, unknown>,
      body: markdown,
    }
  }

  const rawFrontmatter = markdown.slice(4, endIndex)
  const body = markdown.slice(endIndex + 5)

  try {
    const loaded = yaml.load(rawFrontmatter)
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      return {
        attributes: loaded as Record<string, unknown>,
        body,
      }
    }
  } catch {
    // Fall through to an empty frontmatter map and let the caller emit warnings.
  }

  return {
    attributes: {} as Record<string, unknown>,
    body,
  }
}

function normalizeHooks(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function buildResolvedFrontmatter(params: {
  attributes: Record<string, unknown>
  fallbackName: string
  fallbackDescription: string
}) {
  const { attributes } = params
  const warnings: string[] = []
  const knownKeys = new Set([
    "name",
    "description",
    "argument-hint",
    "disable-model-invocation",
    "user-invocable",
    "allowed-tools",
    "model",
    "effort",
    "context",
    "agent",
    "hooks",
  ])

  for (const key of Object.keys(attributes)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Dropped unsupported frontmatter field "${key}"`)
    }
  }

  const rawName = typeof attributes.name === "string" ? attributes.name : ""
  const normalizedName = normalizeSkillCommandName(
    rawName || params.fallbackName
  )
  if (!normalizedName) {
    throw new Error("Skill frontmatter must resolve to a non-empty name")
  }
  if (rawName && normalizedName !== rawName.trim()) {
    warnings.push(
      `Normalized frontmatter name "${rawName}" to "${normalizedName}"`
    )
  }

  const rawDescription =
    typeof attributes.description === "string"
      ? trimWrappingQuotes(attributes.description.trim())
      : ""
  const description = rawDescription || params.fallbackDescription
  if (!description) {
    throw new Error("Skill frontmatter must resolve to a non-empty description")
  }
  if (!rawDescription) {
    warnings.push("Filled missing frontmatter description from skill body")
  }

  const argumentHint =
    typeof attributes["argument-hint"] === "string"
      ? trimWrappingQuotes(attributes["argument-hint"].trim())
      : undefined

  const disableModelInvocation =
    typeof attributes["disable-model-invocation"] === "boolean"
      ? attributes["disable-model-invocation"]
      : false
  if (
    attributes["disable-model-invocation"] !== undefined &&
    typeof attributes["disable-model-invocation"] !== "boolean"
  ) {
    warnings.push('Dropped invalid "disable-model-invocation" value')
  }

  const userInvocable =
    typeof attributes["user-invocable"] === "boolean"
      ? attributes["user-invocable"]
      : true
  if (
    attributes["user-invocable"] !== undefined &&
    typeof attributes["user-invocable"] !== "boolean"
  ) {
    warnings.push('Dropped invalid "user-invocable" value')
  }

  const allowedTools = parseStringList(attributes["allowed-tools"])

  const model =
    typeof attributes.model === "string" && attributes.model.trim().length > 0
      ? trimWrappingQuotes(attributes.model.trim())
      : undefined

  const effort =
    typeof attributes.effort === "string" &&
    VALID_SKILL_EFFORTS.includes(attributes.effort as SkillFrontmatterEffort)
      ? (attributes.effort as SkillFrontmatterEffort)
      : undefined
  if (attributes.effort !== undefined && !effort) {
    warnings.push('Dropped invalid "effort" value')
  }

  const context =
    typeof attributes.context === "string" &&
    VALID_SKILL_CONTEXTS.includes(attributes.context as SkillFrontmatterContext)
      ? (attributes.context as SkillFrontmatterContext)
      : undefined
  if (attributes.context !== undefined && !context) {
    warnings.push('Dropped invalid "context" value')
  }

  const agent =
    typeof attributes.agent === "string" && attributes.agent.trim().length > 0
      ? trimWrappingQuotes(attributes.agent.trim())
      : undefined
  if (agent && context !== "fork") {
    warnings.push('Dropped "agent" because context is not "fork"')
  }

  const hooks = normalizeHooks(attributes.hooks)
  if (attributes.hooks !== undefined && !hooks) {
    warnings.push('Dropped invalid "hooks" value')
  }

  return {
    frontmatter: {
      name: normalizedName,
      description,
      argumentHint,
      disableModelInvocation,
      userInvocable,
      allowedTools,
      model,
      effort,
      context,
      agent: context === "fork" ? agent : undefined,
      hooks,
    } satisfies SkillFrontmatter,
    warnings,
  }
}

export function parseSkillMarkdown(markdown: string, fallbackName: string) {
  const warnings: string[] = []
  let parsed: { attributes: Record<string, unknown>; body: string }
  try {
    parsed = parseFrontmatterSection(markdown)
  } catch {
    warnings.push("Failed to parse SKILL.md frontmatter; used defaults")
    parsed = { attributes: {}, body: markdown }
  }

  const body = parsed.body.replace(/^\n+/, "")
  const bodyBlocks = textBlocks(body)
  const fallbackDescription =
    firstSummaryParagraph(body) || `Skill package for ${fallbackName}.`
  const resolved = buildResolvedFrontmatter({
    attributes: parsed.attributes,
    fallbackName,
    fallbackDescription,
  })

  return {
    frontmatter: resolved.frontmatter,
    bodyBlocks,
    sourceWarnings: [...warnings, ...resolved.warnings],
  } satisfies ParsedSkillManifest
}

export function renderCanonicalBlocksToText(blocks: CanonicalContentBlock[]) {
  return blocks
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "mention"
          ? `@${block.mention.name || "Unknown"}`
          : `[File: ${block.originalName} | ${block.mimeType} | ${block.url}]`
    )
    .join("\n")
}

export function buildSkillMarkdown(
  frontmatter: SkillFrontmatter,
  bodyBlocks: CanonicalContentBlock[]
) {
  const yamlObject: Record<string, unknown> = {
    name: frontmatter.name,
    description: frontmatter.description,
  }

  if (frontmatter.argumentHint) {
    yamlObject["argument-hint"] = frontmatter.argumentHint
  }
  if (frontmatter.disableModelInvocation) {
    yamlObject["disable-model-invocation"] = true
  }
  if (!frontmatter.userInvocable) {
    yamlObject["user-invocable"] = false
  }
  if (frontmatter.allowedTools.length > 0) {
    yamlObject["allowed-tools"] = frontmatter.allowedTools.join(", ")
  }
  if (frontmatter.model) {
    yamlObject.model = frontmatter.model
  }
  if (frontmatter.effort) {
    yamlObject.effort = frontmatter.effort
  }
  if (frontmatter.context) {
    yamlObject.context = frontmatter.context
  }
  if (frontmatter.agent) {
    yamlObject.agent = frontmatter.agent
  }
  if (frontmatter.hooks && Object.keys(frontmatter.hooks).length > 0) {
    yamlObject.hooks = frontmatter.hooks
  }

  const frontmatterSection = yaml
    .dump(yamlObject, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    })
    .trimEnd()
  const body = renderCanonicalBlocksToText(bodyBlocks)

  return `---\n${frontmatterSection}\n---\n\n${body}`.trimEnd() + "\n"
}

export function sha256Hex(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function buildSkillContentHash(params: {
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  files: Array<{
    path: string
    mediaType?: string
    contentBlocks: CanonicalContentBlock[]
  }>
}) {
  return sha256Hex(
    JSON.stringify({
      frontmatter: params.frontmatter,
      bodyBlocks: params.bodyBlocks,
      files: [...params.files].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
    })
  )
}

export function buildSyntheticEntryFile(params: {
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
}) {
  return {
    path: SKILL_ENTRY_PATH,
    mediaType: "text/markdown",
    contentBlocks: [
      textBlock(buildSkillMarkdown(params.frontmatter, params.bodyBlocks)),
    ],
  }
}
