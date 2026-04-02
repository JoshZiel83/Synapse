import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  textBlocks,
  type AvailableSkillSummary,
  type CanonicalContentBlock,
  type CapabilityAccessTarget,
} from "@synapse/shared";
import { resolveRepoSubprojectPath } from "../../config/subprojects.js";
import { listVisibleHealthyRelayCommandlineExposureMetadata } from "../mcp-plugins/tool-resolver.js";

type RelayAutoSkillManifestEntry = {
  slug: string;
  repoDir: string;
  module: string;
  command: string;
};

type RelayAutoSkillDefinition = {
  capabilitySlug: string;
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
const relayRoot = resolve(process.cwd(), "relay");
const relayAutoSkillManifestPath = join(relayRoot, "cli-anything-wave1.json");

let relayAutoSkillIndexPromise:
  | Promise<Map<string, RelayAutoSkillDefinition>>
  | null = null;

function parseManifestEntries(raw: unknown): RelayAutoSkillManifestEntry[] {
  const capabilities = Array.isArray((raw as any)?.capabilities)
    ? (raw as any).capabilities
    : [];

  return capabilities
    .map((entry: any) => ({
      slug: typeof entry?.slug === "string" ? entry.slug.trim() : "",
      repoDir: typeof entry?.repoDir === "string" ? entry.repoDir.trim() : "",
      module: typeof entry?.module === "string" ? entry.module.trim() : "",
      command: typeof entry?.command === "string" ? entry.command.trim() : "",
    }))
    .filter(
      (entry: RelayAutoSkillManifestEntry) =>
        entry.slug && entry.repoDir && entry.module && entry.command,
    );
}

function extractHeading(markdown: string, fallback: string) {
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim() || fallback;
    }
  }
  return fallback;
}

function extractFirstParagraph(markdown: string, fallback: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
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

async function loadRelayAutoSkillIndex() {
  if (!relayAutoSkillIndexPromise) {
    relayAutoSkillIndexPromise = (async () => {
      const manifest = JSON.parse(
        await readFile(relayAutoSkillManifestPath, "utf8"),
      );
      const entries = parseManifestEntries(manifest);
      const index = new Map<string, RelayAutoSkillDefinition>();

      for (const entry of entries) {
        const skillsDir = resolveRepoSubprojectPath(
          "cli-anything",
          entry.repoDir,
          "agent-harness",
          "cli_anything",
          entry.module,
          "skills",
        );
        const skillPath = join(skillsDir, SKILL_FILE_NAME);
        const markdown = await readFile(skillPath, "utf8");

        const slug = `cli-anything-${entry.slug}`;
        const fallbackName = slug;
        const fallbackDescription = `Companion skill for ${entry.command} via relay bash.`;
        index.set(entry.slug, {
          capabilitySlug: entry.slug,
          slug,
          name: extractHeading(markdown, fallbackName),
          description: extractFirstParagraph(markdown, fallbackDescription),
          skillsDir,
          skillPath,
          markdown,
        });
      }

      return index;
    })();
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
    instanceId: `relay-auto-skill:${definition.capabilitySlug}`,
    packageId: `relay-auto-skill:${definition.capabilitySlug}`,
    revisionId: `relay-auto-skill:${definition.capabilitySlug}@${input.version}`,
    slug: definition.slug,
    name: definition.name,
    description: definition.description,
    version: input.version,
    accessTarget: buildAccessTarget(input),
    sourceKind: RELAY_AUTO_SKILL_SOURCE,
    entryPoint: `relay-auto-skill://cli-anything/${definition.capabilitySlug}`,
  };
}

function extractReadyCapabilities(metadata: Record<string, unknown>) {
  const rawCapabilities = Array.isArray(metadata?.cliAnythingCapabilities)
    ? metadata.cliAnythingCapabilities
    : [];
  const ready = new Map<string, string>();

  for (const item of rawCapabilities as any[]) {
    if (item?.ready !== true) continue;
    if (typeof item?.slug !== "string" || item.slug.trim() === "") continue;
    const slug = item.slug.trim();
    const version =
      typeof item?.version === "string" && item.version.trim()
        ? item.version.trim()
        : "relay-auto";
    ready.set(slug, version);
  }

  return ready;
}

function findRelayAutoSkillDefinition(
  definitions: Map<string, RelayAutoSkillDefinition>,
  skillName: string,
) {
  const normalizedName = skillName.trim().toLowerCase();
  for (const definition of definitions.values()) {
    if (
      definition.slug.toLowerCase() === normalizedName ||
      definition.name.toLowerCase() === normalizedName
    ) {
      return definition;
    }
  }
  return null;
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

  let definitions: Map<string, RelayAutoSkillDefinition>;
  let exposureMetadata: Record<string, unknown>[];
  try {
    [definitions, exposureMetadata] = await Promise.all([
      loadRelayAutoSkillIndex(),
      listVisibleHealthyRelayCommandlineExposureMetadata({
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
    for (const [slug, version] of readyFromExposure.entries()) {
      readyCapabilities.add(slug);
      const versions = capabilityVersions.get(slug) || new Set<string>();
      versions.add(version);
      capabilityVersions.set(slug, versions);
    }
  }

  const skills: AvailableSkillSummary[] = [];
  for (const [capabilitySlug, definition] of definitions.entries()) {
    if (!readyCapabilities.has(capabilitySlug)) {
      continue;
    }
    skills.push(
      buildAvailableSkillSummary(definition, {
        actorId: input.actorId,
        conversationId: input.conversationId,
        version: resolveRelayAutoSkillVersion(
          capabilityVersions.get(capabilitySlug),
        ),
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
  let definitions: Map<string, RelayAutoSkillDefinition>;
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
