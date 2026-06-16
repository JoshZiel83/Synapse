import fs from "node:fs/promises"
import { basename, resolve } from "node:path"
import * as unzipper from "unzipper"
import { z } from "zod"
import {
  FILE_ORIGIN_SYSTEMS,
  textBlocks,
  type CanonicalContentBlock,
  type CanonicalContentBlockInput,
  type SkillFrontmatter,
  type SkillSourceType,
} from "@synapse/shared"
import { config } from "../../config/index.js"
import {
  buildPackageImportOrigin,
  storeFile,
  toCanonicalFileRefBlock,
} from "../files/service.js"
import {
  SKILL_ENTRY_PATH,
  buildSkillContentHash,
  buildSkillMarkdown,
  inferSkillMediaType,
  normalizeSkillCommandName,
  normalizeSkillFiles,
  parseSkillMarkdown,
  renderCanonicalBlocksToText,
  type NormalizedSkillFile,
  type SkillFileInput,
} from "./manifest.js"

type JsonObject = Record<string, unknown>

export type PreparedSkillSnapshot = {
  frontmatter: SkillFrontmatter
  bodyBlocks: CanonicalContentBlock[]
  files: NormalizedSkillFile[]
  contentHash: string
  sourceWarnings: string[]
}

export type ImportedMirrorSkillPackage = PreparedSkillSnapshot & {
  catalogSlug: string
  version: string
  tags: string[]
  changelog: string
  mirrorSource: {
    sourceType: SkillSourceType
    locatorKey: string
    locator: JsonObject
    requestedRef?: string
    resolvedRevision?: string
    sourceWarnings: string[]
    metadata: JsonObject
  }
  itemMetadata: JsonObject
}

type PreparedSkillSnapshotOptions = {
  files: SkillFileInput[]
  fallbackName: string
  frontmatterOverrides?: {
    name?: string
    description?: string
  }
}

const TEXT_EXTENSIONS = new Set([
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
])

const GITHUB_RAW_FETCH_TIMEOUT_MS = 12_000
const CLAWHUB_DOWNLOAD_TIMEOUT_MS = 30_000

const ClawhubMirrorMetaSchema = z
  .object({
    ownerId: z.string().optional(),
    owner: z.string().optional(),
    slug: z.string().optional(),
    displayName: z.string().optional(),
    version: z.string().optional(),
    publishedAt: z.number().optional(),
    latest: z
      .object({
        version: z.string().optional(),
        publishedAt: z.number().optional(),
        commit: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

type ClawhubMirrorMeta = z.infer<typeof ClawhubMirrorMetaSchema>

export function parseClawhubMirrorMetaJson(
  metaText: string,
  sourceLabel = "Clawhub _meta.json"
): ClawhubMirrorMeta {
  let value: unknown
  try {
    value = JSON.parse(metaText)
  } catch (error) {
    throw new Error(
      `${sourceLabel} is invalid JSON: ${(error as Error).message}`
    )
  }

  const parsed = ClawhubMirrorMetaSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${sourceLabel} has invalid shape`)
  }
  return parsed.data
}

export function parseGitHubApiJsonObjectText(
  jsonText: string,
  sourceLabel = "GitHub API response"
): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(
      `${sourceLabel} is invalid JSON: ${(error as Error).message}`
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be a JSON object`)
  }
  return value as JsonObject
}

const CLAWHUB_OFFICIAL_DOWNLOAD_ORIGIN = "https://skills.volces.com"

function extname(path: string) {
  const index = path.lastIndexOf(".")
  return index >= 0 ? path.slice(index).toLowerCase() : ""
}

function normalizeSourceSlug(value: string) {
  return normalizeSkillCommandName(value)
}

function deriveTags(...values: Array<string | undefined>) {
  const tags = new Set<string>()
  for (const value of values) {
    for (const part of (value || "")
      .split(/[-_/]+/g)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)) {
      tags.add(part)
    }
  }
  return Array.from(tags)
}

function isTextImportablePath(path: string) {
  return TEXT_EXTENSIONS.has(extname(path))
}

function isIgnoredClawhubPath(path: string) {
  return path === "_meta.json" || path.startsWith(".clawhub/")
}

function shortenRevision(value: string) {
  return value.trim().slice(0, 12)
}

function buildGitHubLocatorKey(repoUrl: string, path: string) {
  return `${repoUrl.replace(/\/+$/, "")}#${path || "."}`
}

function buildClawhubLocatorKey(ownerKey: string | undefined, slug: string) {
  const normalizedOwnerKey = ownerKey?.trim()
  return normalizedOwnerKey
    ? `${normalizedOwnerKey}:${slug}`
    : `clawhub:${slug}`
}

async function fetchJson<T extends JsonObject>(
  url: string,
  headers?: Record<string, string>
) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "synapse-skill-importer",
      ...(headers || {}),
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return parseGitHubApiJsonObjectText(
    await response.text(),
    `GitHub API response from ${url}`
  ) as T
}

async function fetchBuffer(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 30_000
) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "synapse-skill-importer",
      ...(headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function parseGitHubRepoUrl(repoUrl: string) {
  const match = repoUrl
    .trim()
    .replace(/\.git$/i, "")
    .match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i)
  if (!match) {
    throw new Error(
      "GitHub repo URL must look like https://github.com/<owner>/<repo>"
    )
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    normalizedRepoUrl: `https://github.com/${match[1]}/${match[2]}`,
  }
}

function normalizeImportRoot(path: string | undefined) {
  const value = (path || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "")
  return value === "." ? "" : value
}

function encodePathSegments(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function buildGitHubRawUrl(params: {
  owner: string
  repo: string
  resolvedRevision: string
  path: string
}) {
  return `https://raw.githubusercontent.com/${params.owner}/${params.repo}/${params.resolvedRevision}/${encodePathSegments(
    params.path
  )}`
}

function normalizeProxyPrefix(prefix: string) {
  const trimmed = prefix.trim()
  if (!trimmed) return null
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function normalizeOrigin(origin: string) {
  const trimmed = origin.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, "")
}

function createGitHubRawFetcher(params: {
  owner: string
  repo: string
  resolvedRevision: string
}) {
  let preferredCandidateIndex = 0
  let lastSuccessfulCandidate:
    | {
        label: string
        urlPrefix: string
      }
    | undefined

  return {
    async fetch(path: string) {
      const rawUrl = buildGitHubRawUrl({
        owner: params.owner,
        repo: params.repo,
        resolvedRevision: params.resolvedRevision,
        path,
      })
      const candidates = [
        {
          label: "github-raw",
          urlPrefix: "https://raw.githubusercontent.com/",
          url: rawUrl,
        },
        ...config.skills.import.githubRawProxyPrefixes
          .map(normalizeProxyPrefix)
          .filter((value): value is string => Boolean(value))
          .map((prefix) => ({
            label: prefix.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
            urlPrefix: prefix,
            url: `${prefix}${rawUrl}`,
          })),
      ]
      const orderedIndexes = [
        preferredCandidateIndex,
        ...candidates.map((_, index) => index),
      ].filter((value, index, array) => array.indexOf(value) === index)
      const failures: string[] = []

      for (const candidateIndex of orderedIndexes) {
        const candidate = candidates[candidateIndex]!
        try {
          const buffer = await fetchBuffer(
            candidate.url,
            undefined,
            GITHUB_RAW_FETCH_TIMEOUT_MS
          )
          preferredCandidateIndex = candidateIndex
          lastSuccessfulCandidate = {
            label: candidate.label,
            urlPrefix: candidate.urlPrefix,
          }
          return buffer
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${candidate.label}: ${message}`)
        }
      }

      throw new Error(
        `Failed to download GitHub file "${path}" after trying ${candidates.length} raw endpoints. ${failures
          .slice(0, 3)
          .join(" | ")}`
      )
    },
    getLastSuccessfulCandidate() {
      return lastSuccessfulCandidate
    },
  }
}

function buildClawhubDownloadUrl(
  origin: string,
  slug: string,
  version?: string
) {
  const params = new URLSearchParams({ slug })
  if (version?.trim()) {
    params.set("version", version.trim())
  }
  return `${origin}/api/v1/download?${params.toString()}`
}

async function fetchClawhubArchiveBuffer(input: {
  slug: string
  version?: string
}) {
  const candidateOrigins = [
    CLAWHUB_OFFICIAL_DOWNLOAD_ORIGIN,
    ...config.skills.import.clawhubDownloadProxyOrigins,
  ]
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, array) => array.indexOf(value) === index)
  const failures: string[] = []

  for (const origin of candidateOrigins) {
    const url = buildClawhubDownloadUrl(origin, input.slug, input.version)
    try {
      return {
        origin,
        buffer: await fetchBuffer(url, undefined, CLAWHUB_DOWNLOAD_TIMEOUT_MS),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${origin}: ${message}`)
    }
  }

  throw new Error(
    `Failed to download ClawHub archive for "${input.slug}" after trying ${candidateOrigins.length} endpoints. ${failures
      .slice(0, 3)
      .join(" | ")}`
  )
}

async function convertBufferToSkillFile(
  relativePath: string,
  buffer: Buffer,
  metadata: JsonObject
): Promise<SkillFileInput> {
  const mediaType = inferSkillMediaType(relativePath)
  if (isTextImportablePath(relativePath)) {
    return {
      path: relativePath,
      mediaType,
      contentBlocks: textBlocks(buffer.toString("utf8")),
    }
  }

  const stored = await storeFile({
    buffer,
    originalName: basename(relativePath),
    mimeType: mediaType,
    workspaceId: null,
    uploaderUserId: null,
    origin: buildPackageImportOrigin({
      system: FILE_ORIGIN_SYSTEMS.SKILL_MIRROR_IMPORT,
      details: metadata,
    }),
  })

  return {
    path: relativePath,
    mediaType: stored.mimeType,
    contentBlocks: [toCanonicalFileRefBlock(stored)],
  }
}

export function prepareSkillSnapshotFromFiles(
  options: PreparedSkillSnapshotOptions
): PreparedSkillSnapshot {
  const normalized = normalizeSkillFiles(options.files)
  const entry = normalized.find((file) => file.path === SKILL_ENTRY_PATH)
  if (!entry) {
    throw new Error(`Skill must include required path: ${SKILL_ENTRY_PATH}`)
  }

  const parsed = parseSkillMarkdown(
    renderCanonicalBlocksToText(entry.contentBlocks),
    options.fallbackName
  )
  const frontmatter = {
    ...parsed.frontmatter,
    name: options.frontmatterOverrides?.name?.trim() || parsed.frontmatter.name,
    description:
      options.frontmatterOverrides?.description?.trim() ||
      parsed.frontmatter.description,
  }
  const files = normalized.filter((file) => file.path !== SKILL_ENTRY_PATH)
  const contentHash = buildSkillContentHash({
    frontmatter,
    bodyBlocks: parsed.bodyBlocks,
    files,
  })

  return {
    frontmatter,
    bodyBlocks: parsed.bodyBlocks,
    files,
    contentHash,
    sourceWarnings: parsed.sourceWarnings,
  }
}

async function listLocalFiles(
  baseDir: string,
  currentDir = ""
): Promise<string[]> {
  const directory = currentDir ? resolve(baseDir, currentDir) : baseDir
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const result: string[] = []

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      if (relativePath === ".clawhub") {
        continue
      }
      result.push(...(await listLocalFiles(baseDir, relativePath)))
      continue
    }

    if (!entry.isFile() || isIgnoredClawhubPath(relativePath)) {
      continue
    }

    result.push(relativePath.replace(/\\/g, "/"))
  }

  return result
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
) {
  const results: TOutput[] = new Array(items.length)
  let cursor = 0

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await mapper(items[index]!, index)
      }
    })
  )

  return results
}

export async function importGitHubSkillPackage(input: {
  repoUrl: string
  path: string
  ref?: string
}): Promise<ImportedMirrorSkillPackage> {
  const repo = parseGitHubRepoUrl(input.repoUrl)
  const importRoot = normalizeImportRoot(input.path)
  const repoInfo = await fetchJson<{ default_branch: string }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}`
  )
  const requestedRef = input.ref?.trim() || repoInfo.default_branch
  const commit = await fetchJson<{ sha: string }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(
      requestedRef
    )}`
  )
  const resolvedRevision = commit.sha
  const tree = await fetchJson<{
    tree: Array<{ path: string; type: "tree" | "blob" }>
    truncated?: boolean
  }>(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${resolvedRevision}?recursive=1`
  )

  if (tree.truncated) {
    throw new Error("GitHub repository tree is too large to import recursively")
  }

  const prefix = importRoot ? `${importRoot}/` : ""
  const blobs = tree.tree.filter((entry) => {
    if (entry.type !== "blob") return false
    if (!importRoot) return true
    return entry.path === importRoot || entry.path.startsWith(prefix)
  })

  if (blobs.length === 0) {
    throw new Error(`No files found under GitHub path "${importRoot || "."}"`)
  }

  const rawFetcher = createGitHubRawFetcher({
    owner: repo.owner,
    repo: repo.repo,
    resolvedRevision,
  })
  const importedFiles = await mapWithConcurrency(blobs, 8, async (entry) => {
    const relativePath = importRoot
      ? entry.path === importRoot
        ? basename(entry.path)
        : entry.path.slice(prefix.length)
      : entry.path
    const buffer = await rawFetcher.fetch(entry.path)
    return convertBufferToSkillFile(relativePath, buffer, {
      sourceType: "github",
      repoUrl: repo.normalizedRepoUrl,
      path: entry.path,
      resolvedRevision,
    })
  })

  const prepared = prepareSkillSnapshotFromFiles({
    files: importedFiles,
    fallbackName: basename(importRoot || repo.repo),
  })
  const catalogSlug =
    normalizeSourceSlug(prepared.frontmatter.name) ||
    normalizeSourceSlug(basename(importRoot || repo.repo)) ||
    normalizeSourceSlug(repo.repo)
  const version =
    requestedRef === resolvedRevision
      ? shortenRevision(resolvedRevision)
      : `${requestedRef}@${shortenRevision(resolvedRevision)}`.slice(0, 80)
  const rawEndpoint = rawFetcher.getLastSuccessfulCandidate()

  return {
    ...prepared,
    catalogSlug,
    version,
    tags: deriveTags(
      prepared.frontmatter.name,
      basename(importRoot || repo.repo)
    ),
    changelog: `Imported from GitHub at ${resolvedRevision}`,
    mirrorSource: {
      sourceType: "github",
      locatorKey: buildGitHubLocatorKey(
        repo.normalizedRepoUrl,
        importRoot || "."
      ),
      locator: {
        repoUrl: repo.normalizedRepoUrl,
        path: importRoot || ".",
      },
      requestedRef,
      resolvedRevision,
      sourceWarnings: prepared.sourceWarnings,
      metadata: {
        owner: repo.owner,
        repo: repo.repo,
        rawEndpointLabel: rawEndpoint?.label || "github-raw",
        rawEndpointBase:
          rawEndpoint?.urlPrefix || "https://raw.githubusercontent.com/",
      },
    },
    itemMetadata: {
      sourceType: "github",
      repoUrl: repo.normalizedRepoUrl,
      path: importRoot || ".",
      rawEndpointLabel: rawEndpoint?.label || "github-raw",
    },
  }
}

async function readZipEntries(buffer: Buffer): Promise<string[]> {
  const archive = await unzipper.Open.buffer(buffer)
  return archive.files
    .filter((entry: any) => entry.type === "File")
    .map((entry: any) => String(entry.path).replace(/\\/g, "/"))
}

async function readZipEntryText(buffer: Buffer, path: string) {
  const archive = await unzipper.Open.buffer(buffer)
  const entry = archive.files.find((candidate: any) => candidate.path === path)
  if (!entry) {
    throw new Error(`Zip entry "${path}" not found`)
  }
  return (await entry.buffer()).toString("utf8")
}

async function importClawhubArchiveBuffer(params: {
  buffer: Buffer
  requestedSlug: string
  requestedOwnerId?: string
  requestedVersion?: string
}): Promise<ImportedMirrorSkillPackage> {
  const entryPaths = await readZipEntries(params.buffer)
  const metaText = await readZipEntryText(params.buffer, "_meta.json")
  const meta = parseClawhubMirrorMetaJson(metaText)

  if (!meta.slug) {
    throw new Error("Clawhub skill archive is missing _meta.json slug")
  }
  if (
    params.requestedOwnerId &&
    meta.ownerId?.trim() &&
    params.requestedOwnerId !== meta.ownerId.trim()
  ) {
    throw new Error(
      `Clawhub skill owner mismatch: expected ${params.requestedOwnerId}, got ${meta.ownerId}`
    )
  }
  const resolvedVersion =
    meta.version?.trim() ||
    meta.latest?.version?.trim() ||
    params.requestedVersion?.trim() ||
    "1.0.0"
  if (params.requestedVersion && params.requestedVersion !== resolvedVersion) {
    throw new Error(
      `Clawhub skill version mismatch: expected ${params.requestedVersion}, got ${resolvedVersion || "unknown"}`
    )
  }
  const ownerKey =
    meta.ownerId?.trim() ||
    meta.owner?.trim() ||
    params.requestedOwnerId?.trim() ||
    undefined
  const publishedAt = meta.publishedAt || meta.latest?.publishedAt || null
  const commitUrl = meta.latest?.commit || null

  const archive = await unzipper.Open.buffer(params.buffer)
  const skillFiles = await mapWithConcurrency(
    entryPaths.filter((path: string) => !isIgnoredClawhubPath(path)),
    8,
    async (path) => {
      const entry = archive.files.find(
        (candidate: any) => candidate.path === path
      )
      if (!entry) {
        throw new Error(`Archive entry "${path}" not found`)
      }
      const fileBuffer = Buffer.from(await entry.buffer())
      return convertBufferToSkillFile(path, fileBuffer, {
        sourceType: "clawhub",
        ownerId: meta.ownerId || params.requestedOwnerId || null,
        owner: meta.owner || null,
        slug: String(meta.slug),
        version: resolvedVersion,
      })
    }
  )

  const prepared = prepareSkillSnapshotFromFiles({
    files: skillFiles,
    fallbackName: meta.slug,
  })
  return {
    ...prepared,
    catalogSlug:
      normalizeSourceSlug(prepared.frontmatter.name) ||
      normalizeSourceSlug(meta.slug) ||
      normalizeSourceSlug(params.requestedSlug),
    version: resolvedVersion,
    tags: deriveTags(prepared.frontmatter.name, meta.slug),
    changelog: "Imported from Clawhub mirror",
    mirrorSource: {
      sourceType: "clawhub",
      locatorKey: buildClawhubLocatorKey(ownerKey, meta.slug),
      locator: {
        ownerId: meta.ownerId || params.requestedOwnerId,
        owner: meta.owner,
        slug: meta.slug,
      },
      requestedRef: params.requestedVersion,
      resolvedRevision: resolvedVersion,
      sourceWarnings: prepared.sourceWarnings,
      metadata: {
        ownerId: meta.ownerId || params.requestedOwnerId || null,
        owner: meta.owner || null,
        displayName: meta.displayName || null,
        publishedAt,
        commitUrl,
      },
    },
    itemMetadata: {
      sourceType: "clawhub",
      ownerId: meta.ownerId || params.requestedOwnerId || null,
      owner: meta.owner || null,
      slug: meta.slug,
      displayName: meta.displayName || null,
      publishedAt,
      commitUrl,
    },
  }
}

export async function importClawhubSkillPackage(input: {
  ownerId?: string
  slug: string
  version?: string
}): Promise<ImportedMirrorSkillPackage> {
  const downloaded = await fetchClawhubArchiveBuffer({
    slug: input.slug,
    version: input.version,
  })
  const imported = await importClawhubArchiveBuffer({
    buffer: downloaded.buffer,
    requestedSlug: input.slug,
    requestedOwnerId: input.ownerId,
    requestedVersion: input.version,
  })
  return {
    ...imported,
    mirrorSource: {
      ...imported.mirrorSource,
      metadata: {
        ...imported.mirrorSource.metadata,
        downloadOrigin: downloaded.origin,
      },
    },
    itemMetadata: {
      ...imported.itemMetadata,
      downloadOrigin: downloaded.origin,
    },
  }
}

export async function importClawhubSeedSkillPackage(input: {
  skillDir: string
}): Promise<ImportedMirrorSkillPackage> {
  const metaText = await fs.readFile(
    resolve(input.skillDir, "_meta.json"),
    "utf8"
  )
  const meta = parseClawhubMirrorMetaJson(
    metaText,
    `Clawhub seed metadata in ${input.skillDir}`
  )

  const ownerKey = meta.ownerId?.trim() || meta.owner?.trim()
  if (!ownerKey || !meta.slug) {
    throw new Error(`Invalid Clawhub seed metadata in ${input.skillDir}`)
  }

  const relativePaths = await listLocalFiles(input.skillDir)
  const files = await mapWithConcurrency(
    relativePaths,
    8,
    async (relativePath) => {
      const buffer = await fs.readFile(resolve(input.skillDir, relativePath))
      return convertBufferToSkillFile(relativePath, buffer, {
        sourceType: "clawhub",
        ownerId: meta.ownerId || null,
        owner: meta.owner || null,
        slug: meta.slug,
        version: meta.version,
        source: "seed",
      })
    }
  )

  const prepared = prepareSkillSnapshotFromFiles({
    files,
    fallbackName: meta.slug,
  })

  return {
    ...prepared,
    catalogSlug:
      normalizeSourceSlug(prepared.frontmatter.name) ||
      normalizeSourceSlug(meta.slug),
    version: meta.version?.trim() || "1.0.0",
    tags: deriveTags(prepared.frontmatter.name, meta.slug),
    changelog: "Imported from bundled Clawhub seed mirror",
    mirrorSource: {
      sourceType: "clawhub",
      locatorKey: buildClawhubLocatorKey(ownerKey, meta.slug),
      locator: {
        ownerId: meta.ownerId,
        owner: meta.owner,
        slug: meta.slug,
      },
      requestedRef: meta.version?.trim(),
      resolvedRevision: meta.version?.trim(),
      sourceWarnings: prepared.sourceWarnings,
      metadata: {
        ownerId: meta.ownerId || null,
        owner: meta.owner || null,
        publishedAt: meta.publishedAt || null,
        seedPath: input.skillDir,
      },
    },
    itemMetadata: {
      sourceType: "clawhub",
      ownerId: meta.ownerId || null,
      owner: meta.owner || null,
      slug: meta.slug,
      publishedAt: meta.publishedAt || null,
      seedPath: input.skillDir,
    },
  }
}

export function buildSyntheticSkillFilesFromSnapshot(params: {
  frontmatter: PreparedSkillSnapshot["frontmatter"]
  bodyBlocks: CanonicalContentBlock[]
  files: NormalizedSkillFile[]
}) {
  return [
    {
      path: SKILL_ENTRY_PATH,
      mediaType: "text/markdown",
      contentBlocks: textBlocks(
        buildSkillMarkdown(params.frontmatter, params.bodyBlocks)
      ),
    },
    ...params.files,
  ]
}

export function buildPreparedSnapshotFromExistingData(params: {
  fallbackName: string
  existingFiles: Array<{
    path: string
    mediaType?: string
    contentBlocks: CanonicalContentBlock[]
  }>
  frontmatterOverrides?: PreparedSkillSnapshotOptions["frontmatterOverrides"]
}) {
  return prepareSkillSnapshotFromFiles({
    files: params.existingFiles.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      contentBlocks: file.contentBlocks as CanonicalContentBlockInput[],
    })),
    fallbackName: params.fallbackName,
    frontmatterOverrides: params.frontmatterOverrides,
  })
}
