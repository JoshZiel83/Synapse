import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  textBlocks,
  type AvailableSkillSummary,
  type CanonicalContentBlock,
  type CapabilityAccessTarget,
} from "@synapse/shared";
import { resolveRepoPath } from "../../config/repo-paths.js";
import {
  resolveRepoSubprojectPath,
  type RepoSubprojectName,
} from "../../config/subprojects.js";

type ManagedCapabilityManifestEntry = {
  slug: string;
  command: string;
  module?: string;
  skillPath?: string;
};

type ManagedSkillSourceManifest = {
  type: "children" | "single";
  basePath?: string;
  path?: string;
  skillSlug?: string;
  capabilitySlug: string;
};

type ManagedProviderManifest = {
  slug: string;
  displayName: string;
  subproject?: RepoSubprojectName;
  capabilities: ManagedCapabilityManifestEntry[];
  skillSource?: ManagedSkillSourceManifest;
};

type RelayAutoSkillDefinition = {
  providerSlug: string;
  capabilitySlug: string;
  skillKey: string;
  slug: string;
  name: string;
  description: string;
  skillsDir: string;
  skillPath: string;
  markdown: string;
};

const SKILL_DESCRIPTION_ASSET_PATH = "(description)";
const SKILL_FILE_NAME = "SKILL.md";
const RELAY_AUTO_SKILL_SOURCE = "relay_auto_loaded";
const relayAutoSkillManifestPath = resolveRepoPath(
  "relay",
  "managed-command-providers.json",
);

let relayAutoSkillIndexPromise: Promise<RelayAutoSkillDefinition[]> | null = null;
let relayAutoSkillManifestPathOverride: string | null = null;

function getRelayAutoSkillManifestPath() {
  return relayAutoSkillManifestPathOverride || relayAutoSkillManifestPath;
}

function resetRelayAutoSkillIndexCache() {
  relayAutoSkillIndexPromise = null;
}

export function __resetRelayAutoSkillIndexCacheForTests() {
  resetRelayAutoSkillIndexCache();
}

export function __setRelayAutoSkillManifestPathForTests(path?: string) {
  relayAutoSkillManifestPathOverride = path?.trim() || null;
  resetRelayAutoSkillIndexCache();
}

function parseManagedProviders(raw: unknown): ManagedProviderManifest[] {
  const providers = Array.isArray((raw as any)?.providers)
    ? (raw as any).providers
    : [];

  return providers
    .map((provider: any) => {
      const capabilities = Array.isArray(provider?.capabilities)
        ? provider.capabilities
            .map((capability: any) => ({
              slug:
                typeof capability?.slug === "string"
                  ? capability.slug.trim()
                  : "",
              command:
                typeof capability?.command === "string"
                  ? capability.command.trim()
                  : "",
              module:
                typeof capability?.module === "string"
                  ? capability.module.trim()
                  : "",
              skillPath:
                typeof capability?.skillPath === "string"
                  ? capability.skillPath.trim()
                  : "",
            }))
            .filter(
              (capability: ManagedCapabilityManifestEntry) =>
                capability.slug && capability.command,
            )
        : [];

      let skillSource: ManagedSkillSourceManifest | undefined;
      if (provider?.skillSource && typeof provider.skillSource === "object") {
        const sourceType =
          typeof provider.skillSource.type === "string"
            ? provider.skillSource.type.trim()
            : "";
        if (sourceType === "children" || sourceType === "single") {
          skillSource = {
            type: sourceType,
            basePath:
              typeof provider.skillSource.basePath === "string"
                ? provider.skillSource.basePath.trim()
                : "",
            path:
              typeof provider.skillSource.path === "string"
                ? provider.skillSource.path.trim()
                : "",
            skillSlug:
              typeof provider.skillSource.skillSlug === "string"
                ? provider.skillSource.skillSlug.trim()
                : "",
            capabilitySlug:
              typeof provider.skillSource.capabilitySlug === "string"
                ? provider.skillSource.capabilitySlug.trim()
                : "",
          };
        }
      }

      return {
        slug: typeof provider?.slug === "string" ? provider.slug.trim() : "",
        displayName:
          typeof provider?.displayName === "string"
            ? provider.displayName.trim()
            : "",
        subproject:
          typeof provider?.subproject === "string"
            ? (provider.subproject.trim() as RepoSubprojectName)
            : undefined,
        capabilities,
        skillSource,
      };
    })
    .filter(
      (provider: ManagedProviderManifest) =>
        provider.slug &&
        provider.displayName &&
        provider.capabilities.length > 0,
    );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex < 0) {
    return normalized;
  }
  return normalized.slice(endIndex + 5);
}

function extractHeading(markdown: string, fallback: string) {
  const stripped = stripFrontmatter(markdown);
  for (const line of stripped.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim() || fallback;
    }
  }
  return fallback;
}

function extractFirstParagraph(markdown: string, fallback: string) {
  const lines = stripFrontmatter(markdown).split("\n");
  let seenHeading = false;
  let inFence = false;
  const paragraph: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      if (paragraph.length > 0) break;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("#")) {
      seenHeading = true;
      if (paragraph.length > 0) break;
      continue;
    }
    if (!seenHeading && line === "") {
      continue;
    }
    if (line === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }

  return paragraph.join(" ").trim() || fallback;
}

function normalizeSkillAssetPath(assetPath: string) {
  const value = assetPath.replace(/\\/g, "/").trim();
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`Invalid skill file path: ${assetPath}`);
  }

  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid skill file path: ${assetPath}`);
  }

  return segments.join("/");
}

function resolveRelayAutoSkillVersion(versions?: Set<string>) {
  if (!versions || versions.size === 0) {
    return "relay-auto";
  }
  if (versions.size === 1) {
    return Array.from(versions)[0]!;
  }
  return "mixed";
}

function capabilityKey(providerSlug: string, capabilitySlug: string) {
  return `${providerSlug}:${capabilitySlug}`;
}

function normalizePublicSkillSlug(providerSlug: string, rawSkillSlug: string) {
  const normalized = rawSkillSlug.trim().toLowerCase();
  if (normalized.startsWith(providerSlug.toLowerCase())) {
    return normalized;
  }
  return `${providerSlug}-${normalized}`;
}

async function loadSkillDefinition(input: {
  providerSlug: string;
  capabilitySlug: string;
  rawSkillSlug: string;
  skillsDir: string;
  fallbackDescription: string;
}) {
  const skillPath = join(input.skillsDir, SKILL_FILE_NAME);
  const markdown = await readFile(skillPath, "utf8");
  const publicSlug = normalizePublicSkillSlug(
    input.providerSlug,
    input.rawSkillSlug,
  );
  const skillKey = capabilityKey(input.providerSlug, input.capabilitySlug) +
    `:${input.rawSkillSlug}`;

  return {
    providerSlug: input.providerSlug,
    capabilitySlug: input.capabilitySlug,
    skillKey,
    slug: publicSlug,
    name: extractHeading(markdown, publicSlug),
    description: extractFirstParagraph(markdown, input.fallbackDescription),
    skillsDir: input.skillsDir,
    skillPath,
    markdown,
  } satisfies RelayAutoSkillDefinition;
}

function summarizeRelayAutoSkillError(error: unknown) {
  if (!error) return "unknown error";
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

function logRelayAutoSkillWarning(
  providerSlug: string,
  context: string,
  error: unknown,
) {
  console.warn(
    `[relay-auto-skills] skipping ${providerSlug} ${context}: ${summarizeRelayAutoSkillError(error)}`,
  );
}

async function tryLoadSkillDefinition(
  provider: ManagedProviderManifest,
  input: {
    capabilitySlug: string;
    rawSkillSlug: string;
    skillsDir: string;
    fallbackDescription: string;
  },
) {
  try {
    return await loadSkillDefinition({
      providerSlug: provider.slug,
      capabilitySlug: input.capabilitySlug,
      rawSkillSlug: input.rawSkillSlug,
      skillsDir: input.skillsDir,
      fallbackDescription: input.fallbackDescription,
    });
  } catch (error) {
    logRelayAutoSkillWarning(
      provider.slug,
      `skill ${input.rawSkillSlug}`,
      error,
    );
    return null;
  }
}

async function loadProviderSkillDefinitions(provider: ManagedProviderManifest) {
  const definitions: RelayAutoSkillDefinition[] = [];

  for (const capability of provider.capabilities) {
    if (!capability.skillPath) {
      continue;
    }
    if (!provider.subproject) {
      continue;
    }
    const skillsDir = resolveRepoSubprojectPath(
      provider.subproject,
      ...capability.skillPath.split("/"),
    );
    const definition = await tryLoadSkillDefinition(provider, {
      capabilitySlug: capability.slug,
      rawSkillSlug: capability.slug,
      skillsDir,
      fallbackDescription: `Companion skill for ${capability.command} via relay bash.`,
    });
    if (definition) {
      definitions.push(definition);
    }
  }

  if (!provider.skillSource || !provider.subproject) {
    return definitions;
  }

  if (provider.skillSource.type === "children") {
    const basePath = provider.skillSource.basePath || ".";
    const baseDir = resolveRepoSubprojectPath(
      provider.subproject,
      ...basePath.split("/"),
    );
    let entries;
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch (error) {
      logRelayAutoSkillWarning(provider.slug, `skill directory ${basePath}`, error);
      return definitions;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillsDir = join(baseDir, entry.name);
      const definition = await tryLoadSkillDefinition(provider, {
        capabilitySlug: provider.skillSource.capabilitySlug,
        rawSkillSlug: entry.name,
        skillsDir,
        fallbackDescription: `Companion skill for ${provider.displayName} via relay bash.`,
      });
      if (definition) {
        definitions.push(definition);
      }
    }
    return definitions;
  }

  const singleSkillPath = provider.skillSource.path || ".";
  const skillsDir = resolveRepoSubprojectPath(
    provider.subproject,
    ...singleSkillPath.split("/"),
  );
  const rawSkillSlug =
    provider.skillSource.skillSlug ||
    basename(skillsDir) ||
    provider.skillSource.capabilitySlug;
  const definition = await tryLoadSkillDefinition(provider, {
    capabilitySlug: provider.skillSource.capabilitySlug,
    rawSkillSlug,
    skillsDir,
    fallbackDescription: `Companion skill for ${provider.displayName} via relay bash.`,
  });
  if (definition) {
    definitions.push(definition);
  }
  return definitions;
}

async function loadRelayAutoSkillIndex() {
  if (!relayAutoSkillIndexPromise) {
    const pending = (async () => {
      const manifest = JSON.parse(
        await readFile(getRelayAutoSkillManifestPath(), "utf8"),
      );
      const providers = parseManagedProviders(manifest);
      const definitions: RelayAutoSkillDefinition[] = [];

      for (const provider of providers) {
        definitions.push(...(await loadProviderSkillDefinitions(provider)));
      }

      return definitions.sort((left, right) => left.slug.localeCompare(right.slug));
    })();
    relayAutoSkillIndexPromise = pending.catch((error) => {
      resetRelayAutoSkillIndexCache();
      throw error;
    });
  }

  return relayAutoSkillIndexPromise;
}

function buildAccessTarget(input: {
  actorId?: string;
  conversationId?: string;
}): CapabilityAccessTarget {
  if (input.actorId && input.conversationId) {
    return {
      type: "actor_in_conversation",
      actorId: input.actorId,
      conversationId: input.conversationId,
    };
  }
  if (input.actorId) {
    return {
      type: "actor",
      actorId: input.actorId,
    };
  }
  return {
    type: "workspace",
  };
}

function buildAvailableSkillSummary(
  definition: RelayAutoSkillDefinition,
  input: {
    actorId?: string;
    conversationId?: string;
    version: string;
  },
): AvailableSkillSummary {
  return {
    instanceId: `relay-auto-skill:${definition.skillKey}`,
    packageId: `relay-auto-skill:${definition.skillKey}`,
    revisionId: `relay-auto-skill:${definition.skillKey}@${input.version}`,
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    version: input.version,
    accessTarget: buildAccessTarget(input),
    sourceKind: RELAY_AUTO_SKILL_SOURCE,
    entryPoint: `relay-auto-skill://${definition.providerSlug}/${definition.skillKey}`,
  };
}

function extractReadyCapabilities(metadata: Record<string, unknown>) {
  const rawCapabilities = Array.isArray(metadata?.managedCapabilities)
    ? metadata.managedCapabilities
    : [];
  const ready = new Map<string, string>();

  for (const item of rawCapabilities as any[]) {
    if (item?.ready !== true) continue;
    if (typeof item?.provider !== "string" || item.provider.trim() === "") {
      continue;
    }
    if (typeof item?.slug !== "string" || item.slug.trim() === "") continue;
    const key = capabilityKey(item.provider.trim(), item.slug.trim());
    const version =
      typeof item?.version === "string" && item.version.trim()
        ? item.version.trim()
        : "relay-auto";
    ready.set(key, version);
  }

  return ready;
}

function findRelayAutoSkillDefinition(
  definitions: RelayAutoSkillDefinition[],
  skillName: string,
) {
  const normalizedName = skillName.trim().toLowerCase();
  return (
    definitions.find(
      (definition) =>
        definition.slug.toLowerCase() === normalizedName ||
        definition.name.toLowerCase() === normalizedName,
    ) || null
  );
}

async function loadVisibleHealthyRelayCommandlineExposureMetadata(input: {
  workspaceId: string;
  actorId: string;
  sessionId: string;
  conversationId: string;
  conversationKind?: "private" | "group" | "virtual";
  conversationBoundary?: "internal" | "external";
}) {
  const { listVisibleHealthyRelayCommandlineExposureMetadata } = await import(
    "../mcp-plugins/tool-resolver.js"
  );
  return listVisibleHealthyRelayCommandlineExposureMetadata(input);
}

export async function listRelayAutoLoadedSkills(input: {
  workspaceId: string;
  actorId?: string;
  conversationId?: string;
  conversationKind?: "private" | "group" | "virtual";
  conversationBoundary?: "internal" | "external";
  sessionId?: string;
}) {
  if (!input.actorId || !input.sessionId) {
    return [] as AvailableSkillSummary[];
  }

  let definitions: RelayAutoSkillDefinition[];
  let exposureMetadata: Record<string, unknown>[];
  try {
    [definitions, exposureMetadata] = await Promise.all([
      loadRelayAutoSkillIndex(),
      loadVisibleHealthyRelayCommandlineExposureMetadata({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        conversationId: input.conversationId || "",
        conversationKind: input.conversationKind,
        conversationBoundary: input.conversationBoundary,
      }),
    ]);
  } catch (error) {
    console.error("[relay-auto-skills] failed to load relay auto skills:", error);
    return [] as AvailableSkillSummary[];
  }

  if (exposureMetadata.length === 0) {
    return [] as AvailableSkillSummary[];
  }

  const readyCapabilities = new Set<string>();
  const capabilityVersions = new Map<string, Set<string>>();

  for (const metadata of exposureMetadata) {
    const readyFromExposure = extractReadyCapabilities(metadata);
    for (const [key, version] of readyFromExposure.entries()) {
      readyCapabilities.add(key);
      const versions = capabilityVersions.get(key) || new Set<string>();
      versions.add(version);
      capabilityVersions.set(key, versions);
    }
  }

  const skills: AvailableSkillSummary[] = [];
  for (const definition of definitions) {
    const key = capabilityKey(definition.providerSlug, definition.capabilitySlug);
    if (!readyCapabilities.has(key)) {
      continue;
    }
    skills.push(
      buildAvailableSkillSummary(definition, {
        actorId: input.actorId,
        conversationId: input.conversationId,
        version: resolveRelayAutoSkillVersion(capabilityVersions.get(key)),
      }),
    );
  }

  return skills.sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function readRelayAutoLoadedSkill(input: {
  skillName: string;
  actorId?: string;
  conversationId?: string;
  assetPath?: string;
  skill?: AvailableSkillSummary;
}) {
  let definitions: RelayAutoSkillDefinition[];
  try {
    definitions = await loadRelayAutoSkillIndex();
  } catch (error) {
    console.error("[relay-auto-skills] failed to read relay auto skill index:", error);
    return null;
  }
  const definition = findRelayAutoSkillDefinition(definitions, input.skillName);
  if (!definition) {
    return null;
  }

  const skill =
    input.skill ||
    buildAvailableSkillSummary(definition, {
      actorId: input.actorId,
      conversationId: input.conversationId,
      version: "relay-auto",
    });

  if (!input.assetPath) {
    return {
      skill,
      asset: {
        path: SKILL_DESCRIPTION_ASSET_PATH,
        textContent: definition.markdown,
        contentBlocks: textBlocks(definition.markdown) as CanonicalContentBlock[],
      },
    };
  }

  const normalizedTarget = normalizeSkillAssetPath(input.assetPath);
  const loweredTarget = normalizedTarget.toLowerCase();
  if (loweredTarget === SKILL_DESCRIPTION_ASSET_PATH.toLowerCase()) {
    return {
      skill,
      asset: {
        path: SKILL_DESCRIPTION_ASSET_PATH,
        textContent: definition.markdown,
        contentBlocks: textBlocks(definition.markdown) as CanonicalContentBlock[],
      },
    };
  }

  const assetPath =
    loweredTarget === SKILL_FILE_NAME.toLowerCase() ||
    loweredTarget === "skill.md"
      ? definition.skillPath
      : join(definition.skillsDir, normalizedTarget);
  const textContent = await readFile(assetPath, "utf8");
  return {
    skill,
    asset: {
      path: normalizedTarget,
      textContent,
      contentBlocks: textBlocks(textContent) as CanonicalContentBlock[],
    },
  };
}
