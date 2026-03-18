import crypto from "node:crypto";
import fs from "node:fs/promises";
import bcryptjs from "bcryptjs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "url";
import { textBlocks } from "@synapse/shared";
import { seedBuiltinMcpPlugins } from "../../modules/mcp-plugins/service.js";
import { seedPlatformDefaultGroup } from "../../modules/model-groups/service.js";
import { ensureSeedPlatformAdminForUser } from "../../modules/platform/admin-service.js";
import {
  AUTHZ_PLATFORM_ID,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchRelation,
} from "../authz/index.js";
import { ensureStorageDir } from "../storage/index.js";
import { query, transaction } from "./index.js";

const { hash } = bcryptjs;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLAWHUB_SKILLS_DIR = resolve(
  __dirname,
  "../../../../../.setup/skills/clawhub/skills",
);

const SYNAPSE_PUBLISHER_SLUG = "synapse-official";
const CLAWHUB_PUBLISHER_SLUG = "clawhub-official";

type CatalogFileRole =
  | "document"
  | "reference"
  | "script"
  | "image"
  | "json"
  | "binary";

type ActorCatalogRefs = {
  actorItemId: string;
  actorVersionId: string;
};

type RuntimeRefs = {
  actorId: string;
};

type ImportedSkillFile = {
  path: string;
  fileRole: CatalogFileRole;
  mediaType: string;
  textContent: string;
  contentBlocks: ReturnType<typeof textBlocks>;
  sha256: string;
  sizeBytes: number;
};

type ImportedSkillPackage = {
  slug: string;
  version: string;
  name: string;
  description: string;
  tags: string[];
  ownerId?: string;
  publishedAt?: number;
  files: ImportedSkillFile[];
};

async function seedDemoWorkspace(userId: string) {
  const result = await query<{ id: string }>(
    `INSERT INTO workspaces (name, slug, description, owner_id)
     VALUES ('Demo Workspace', 'demo-workspace', 'Refactored workspace seed', $1)
     ON CONFLICT (slug) DO UPDATE SET
       description = EXCLUDED.description,
       updated_at = NOW()
     RETURNING id`,
    [userId],
  );
  const workspaceId = result.rows[0]!.id;

  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET trust_level = 'owner'`,
    [workspaceId, userId],
  );

  return workspaceId;
}

async function ensurePublisher(
  client: { query: typeof query },
  input: {
    slug: string;
    displayName: string;
    description: string;
    ownerUserId?: string | null;
    isBuiltin?: boolean;
    isVerified?: boolean;
    metadata?: Record<string, unknown>;
  },
) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO publishers (
       slug, display_name, description, owner_user_id, workspace_id, is_builtin, is_verified, metadata
     )
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
       is_builtin = EXCLUDED.is_builtin,
       is_verified = EXCLUDED.is_verified,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id`,
    [
      input.slug,
      input.displayName,
      input.description,
      input.ownerUserId || null,
      input.isBuiltin === true,
      input.isVerified !== false,
      JSON.stringify(input.metadata || {}),
    ],
  );

  return result.rows[0]!.id;
}

async function seedActorCatalog(userId: string) {
  return transaction(async (client) => {
    const publisherId = await ensurePublisher(client, {
      slug: SYNAPSE_PUBLISHER_SLUG,
      displayName: "Synapse Official",
      description: "Official Synapse catalog publisher",
      ownerUserId: userId,
      isVerified: true,
    });

    const actorItem = await client.query<{ id: string }>(
      `INSERT INTO catalog_items (
         publisher_id, workspace_id, item_kind, slug, display_name, summary, long_description,
         source_kind, visibility, tags, metadata
       )
       VALUES ($1, NULL, 'actor_template', 'secretary-template', 'Secretary Template',
         'Official actor template.',
         'Baseline actor template for delegation and coordination.',
         'official', 'public', ARRAY['actor','secretary'], '{}'::jsonb)
       ON CONFLICT (publisher_id, item_kind, slug) WHERE workspace_id IS NULL
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         summary = EXCLUDED.summary,
         long_description = EXCLUDED.long_description,
         is_active = TRUE,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [publisherId],
    );
    const actorItemId = actorItem.rows[0]!.id;

    const actorVersion = await client.query<{ id: string }>(
      `INSERT INTO catalog_versions (
         catalog_item_id, version, status, changelog, metadata, created_by
       )
       VALUES ($1, '1.0.0', 'active', 'Initial seed version', '{}'::jsonb, $2)
       ON CONFLICT (catalog_item_id, version) DO UPDATE SET
         status = 'active',
         changelog = EXCLUDED.changelog,
         metadata = EXCLUDED.metadata
       RETURNING id`,
      [actorItemId, userId],
    );
    const actorVersionId = actorVersion.rows[0]!.id;

    await client.query(
      `UPDATE catalog_items
       SET latest_version_id = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [actorVersionId, actorItemId],
    );

    await client.query(
      `INSERT INTO actor_template_version_specs (
         catalog_version_id, role, title, can_represent_user, docs, specialties, config
       )
       VALUES (
         $1,
         'secretary',
         'Personal Secretary',
         FALSE,
         $2::jsonb,
         ARRAY['delegation','organization'],
         '{}'::jsonb
       )
       ON CONFLICT (catalog_version_id) DO UPDATE SET
         role = EXCLUDED.role,
         title = EXCLUDED.title,
         can_represent_user = EXCLUDED.can_represent_user,
         docs = EXCLUDED.docs,
         specialties = EXCLUDED.specialties,
         config = EXCLUDED.config`,
      [
        actorVersionId,
        JSON.stringify([
          {
            key: "identity_card",
            title: "Identity Card",
            visibility: "always",
            priority: 120,
            content: textBlocks("I am the workspace secretary."),
          },
        ]),
      ],
    );

    return {
      actorItemId,
      actorVersionId,
    } satisfies ActorCatalogRefs;
  });
}

function sha256Hex(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeForComparison(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeSlug(slug: string) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function trimWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSimpleFrontmatter(markdown: string) {
  if (!markdown.startsWith("---\n")) {
    return {
      attributes: {} as Record<string, string>,
      body: markdown,
    };
  }

  const endIndex = markdown.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return {
      attributes: {} as Record<string, string>,
      body: markdown,
    };
  }

  const rawFrontmatter = markdown.slice(4, endIndex);
  const body = markdown.slice(endIndex + 5);
  const attributes: Record<string, string> = {};

  for (const line of rawFrontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = trimWrappingQuotes(line.slice(separatorIndex + 1).trim());
    if (key && value) {
      attributes[key] = value;
    }
  }

  return { attributes, body };
}

function extractHeading(markdownBody: string) {
  for (const line of markdownBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^#\s+(.+)$/);
    if (!match) continue;
    return match[1]!.replace(/\s+skill$/i, "").trim();
  }
  return "";
}

function extractSummaryParagraph(markdownBody: string) {
  const lines = markdownBody.split("\n");
  let inCodeFence = false;
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length === 0) {
      return "";
    }
    const paragraph = currentParagraph.join(" ").trim();
    currentParagraph = [];
    return paragraph;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      const paragraph = flushParagraph();
      if (paragraph) return paragraph;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    if (!line) {
      const paragraph = flushParagraph();
      if (paragraph) return paragraph;
      continue;
    }
    if (
      line.startsWith("#") ||
      line.startsWith("|") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      /^\d+\.\s/.test(line)
    ) {
      const paragraph = flushParagraph();
      if (paragraph) return paragraph;
      continue;
    }
    currentParagraph.push(line);
  }

  return flushParagraph();
}

function deriveSkillName(
  slug: string,
  frontmatterName: string | undefined,
  heading: string,
) {
  const cleanedFrontmatterName = (frontmatterName || "").trim();
  if (
    heading &&
    normalizeForComparison(heading) !== normalizeForComparison(slug)
  ) {
    return heading;
  }
  if (
    cleanedFrontmatterName &&
    normalizeForComparison(cleanedFrontmatterName) !== normalizeForComparison(slug)
  ) {
    return cleanedFrontmatterName;
  }
  if (heading) {
    return normalizeForComparison(heading) === normalizeForComparison(slug)
      ? humanizeSlug(slug)
      : heading;
  }
  if (cleanedFrontmatterName) {
    return normalizeForComparison(cleanedFrontmatterName) === normalizeForComparison(slug)
      ? humanizeSlug(slug)
      : cleanedFrontmatterName;
  }
  return humanizeSlug(slug);
}

function deriveSkillDescription(
  name: string,
  frontmatterDescription: string | undefined,
  markdownBody: string,
) {
  const description = (frontmatterDescription || "").trim();
  if (description) {
    return description;
  }

  const paragraph = extractSummaryParagraph(markdownBody);
  if (paragraph) {
    return paragraph;
  }

  return `Official skill package for ${name}.`;
}

function deriveSkillTags(slug: string) {
  return Array.from(
    new Set(
      slug
        .split(/[-_]+/g)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

async function walkFiles(baseDir: string, currentDir = ""): Promise<string[]> {
  const directory = currentDir ? resolve(baseDir, currentDir) : baseDir;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = currentDir
      ? `${currentDir}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      result.push(...(await walkFiles(baseDir, relativePath)));
      continue;
    }

    if (!entry.isFile() || entry.name === "_meta.json") {
      continue;
    }

    result.push(relativePath.replace(/\\/g, "/"));
  }

  return result;
}

function inferCatalogFileRole(relativePath: string): CatalogFileRole {
  const normalized = relativePath.replace(/\\/g, "/");
  const fileName = basename(normalized).toLowerCase();
  const extension = extname(normalized).toLowerCase();

  if (fileName === "skill.md" || fileName === "readme.md") {
    return "document";
  }
  if (extension === ".json") {
    return "json";
  }
  if (
    [".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".mjs", ".cjs"].includes(
      extension,
    )
  ) {
    return "script";
  }
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
    return "image";
  }
  if (
    [".md", ".txt", ".yml", ".yaml", ".css", ".html", ".xml"].includes(extension)
  ) {
    return "reference";
  }
  return "binary";
}

function inferMediaType(relativePath: string) {
  const extension = extname(relativePath).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".ts":
      return "text/typescript";
    case ".tsx":
      return "text/tsx";
    case ".jsx":
      return "text/jsx";
    case ".py":
      return "text/x-python";
    case ".sh":
    case ".bash":
      return "text/x-shellscript";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/plain";
  }
}

function isTextImportableFile(relativePath: string) {
  const extension = extname(relativePath).toLowerCase();
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
  ].includes(extension);
}

async function readImportedSkillPackage(skillDirName: string): Promise<ImportedSkillPackage> {
  const skillDir = resolve(CLAWHUB_SKILLS_DIR, skillDirName);
  const metadataPath = resolve(skillDir, "_meta.json");
  const skillMarkdownPath = resolve(skillDir, "SKILL.md");

  const metadata = JSON.parse(
    await fs.readFile(metadataPath, "utf8"),
  ) as {
    ownerId?: string;
    slug?: string;
    version?: string;
    publishedAt?: number;
  };

  const markdown = await fs.readFile(skillMarkdownPath, "utf8");
  const { attributes, body } = parseSimpleFrontmatter(markdown);
  const heading = extractHeading(body);
  const slug = (metadata.slug || skillDirName).trim();
  const name = deriveSkillName(slug, attributes.name, heading);
  const description = deriveSkillDescription(name, attributes.description, body);

  const filePaths = await walkFiles(skillDir);
  const files: ImportedSkillFile[] = [];

  for (const relativePath of filePaths) {
    if (!isTextImportableFile(relativePath)) {
      console.warn(
        `[db.seed] Skipping unsupported binary skill asset ${slug}/${relativePath}`,
      );
      continue;
    }

    const absolutePath = resolve(skillDir, relativePath);
    const buffer = await fs.readFile(absolutePath);
    const textContent = buffer.toString("utf8");

    files.push({
      path: relativePath,
      fileRole: inferCatalogFileRole(relativePath),
      mediaType: inferMediaType(relativePath),
      textContent,
      contentBlocks: textBlocks(textContent),
      sha256: sha256Hex(buffer),
      sizeBytes: buffer.length,
    });
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
  };
}

async function loadClawHubSkillPackages() {
  const entries = await fs.readdir(CLAWHUB_SKILLS_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const skills: ImportedSkillPackage[] = [];
  for (const directory of directories) {
    skills.push(await readImportedSkillPackage(directory));
  }
  return skills;
}

async function seedOfficialSkills(userId: string) {
  const skills = await loadClawHubSkillPackages();

  await transaction(async (client) => {
    const publisherId = await ensurePublisher(client, {
      slug: CLAWHUB_PUBLISHER_SLUG,
      displayName: "ClawHub Official",
      description: "Official ClawHub skill marketplace publisher",
      ownerUserId: userId,
      isVerified: true,
      metadata: {
        sourceCatalog: "clawhub",
      },
    });

    for (const skill of skills) {
      const itemMetadata = {
        sourceCatalog: "clawhub",
        sourceOwnerId: skill.ownerId || null,
        sourcePublishedAt: skill.publishedAt || null,
      };

      const insertedItem = await client.query<{ id: string }>(
        `INSERT INTO catalog_items (
           publisher_id,
           workspace_id,
           item_kind,
           slug,
           display_name,
           summary,
           long_description,
           source_kind,
           visibility,
           tags,
           is_active,
           metadata
         )
         VALUES (
           $1,
           NULL,
           'skill_package',
           $2,
           $3,
           $4,
           $4,
           'official',
           'public',
           $5,
           TRUE,
           $6::jsonb
         )
         ON CONFLICT (publisher_id, item_kind, slug) WHERE workspace_id IS NULL
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           summary = EXCLUDED.summary,
           long_description = EXCLUDED.long_description,
           tags = EXCLUDED.tags,
           is_active = TRUE,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        [
          publisherId,
          skill.slug,
          skill.name,
          skill.description,
          skill.tags,
          JSON.stringify(itemMetadata),
        ],
      );
      const itemId = insertedItem.rows[0]!.id;

      const versionMetadata = {
        sourceCatalog: "clawhub",
        sourceOwnerId: skill.ownerId || null,
        sourcePublishedAt: skill.publishedAt || null,
        importedFileCount: skill.files.length,
      };

      const upsertedVersion = await client.query<{ id: string }>(
        `INSERT INTO catalog_versions (
           catalog_item_id,
           version,
           status,
           changelog,
           metadata,
           created_by
         )
         VALUES ($1, $2, 'active', 'Imported from ClawHub official seed', $3::jsonb, $4)
         ON CONFLICT (catalog_item_id, version) DO UPDATE SET
           status = 'active',
           changelog = EXCLUDED.changelog,
           metadata = EXCLUDED.metadata
         RETURNING id`,
        [
          itemId,
          skill.version,
          JSON.stringify(versionMetadata),
          userId,
        ],
      );
      const versionId = upsertedVersion.rows[0]!.id;

      await client.query(
        `INSERT INTO skill_package_version_specs (
           catalog_version_id,
           canonical_slug,
           name,
           description_blocks,
           summary_text,
           metadata
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
         ON CONFLICT (catalog_version_id) DO UPDATE SET
           canonical_slug = EXCLUDED.canonical_slug,
           name = EXCLUDED.name,
           description_blocks = EXCLUDED.description_blocks,
           summary_text = EXCLUDED.summary_text,
           metadata = EXCLUDED.metadata`,
        [
          versionId,
          skill.slug,
          skill.name,
          JSON.stringify(textBlocks(skill.description)),
          skill.description,
          JSON.stringify(versionMetadata),
        ],
      );

      await client.query(
        `DELETE FROM catalog_version_files
         WHERE catalog_version_id = $1`,
        [versionId],
      );

      for (const file of skill.files) {
        await client.query(
          `INSERT INTO catalog_version_files (
             catalog_version_id,
             path,
             file_role,
             media_type,
             text_content,
             content_blocks,
             sha256,
             size_bytes,
             metadata
           )
           VALUES (
             $1,
             $2,
             $3,
             $4,
             $5,
             $6::jsonb,
             $7,
             $8,
             $9::jsonb
           )`,
          [
            versionId,
            file.path,
            file.fileRole,
            file.mediaType,
            file.textContent,
            JSON.stringify(file.contentBlocks),
            file.sha256,
            file.sizeBytes,
            JSON.stringify({
              sourceCatalog: "clawhub",
            }),
          ],
        );
      }

      await client.query(
        `UPDATE catalog_items
         SET latest_version_id = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [itemId, versionId],
      );
    }
  });

  return skills.length;
}

async function seedRuntime(
  workspaceId: string,
  userId: string,
  refs: ActorCatalogRefs,
) {
  return transaction(async (client) => {
    const actor = await client.query<{ id: string }>(
      `INSERT INTO actors (
         workspace_id, name, role, title, can_represent_user, specialties, config, created_by
       )
       VALUES (
         $1,
         'Secretary',
         'secretary',
         'Personal Secretary',
         FALSE,
         ARRAY['delegation','organization'],
         '{}'::jsonb,
         $2
       )
       RETURNING id`,
      [workspaceId, userId],
    );
    const actorId = actor.rows[0]!.id;

    const actorVersion = await client.query<{ id: string }>(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, can_represent_user, specialties, config, created_by
       )
       VALUES (
         $1,
         1,
         'Secretary',
         'secretary',
         'Personal Secretary',
         FALSE,
         ARRAY['delegation','organization'],
         '{}'::jsonb,
         $2
       )
       RETURNING id`,
      [actorId, userId],
    );
    const actorVersionId = actorVersion.rows[0]!.id;

    await client.query(
      `INSERT INTO actor_version_docs (
         actor_version_id, doc_key, title, visibility, priority, content_blocks
       )
       VALUES ($1, 'identity_card', 'Identity Card', 'always', 120, $2::jsonb)`,
      [actorVersionId, JSON.stringify(textBlocks("I am the workspace secretary."))],
    );

    await client.query(
      `INSERT INTO actor_source_refs (
         actor_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         baseline_actor_version,
         metadata
       )
       VALUES ($1, $2, $3, 'notify', 1, '{}'::jsonb)`,
      [actorId, refs.actorItemId, refs.actorVersionId],
    );

    return {
      actorId,
    } satisfies RuntimeRefs;
  });
}

async function countCatalogItems(itemKind: "skill_package" | "plugin_package") {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM catalog_items
     WHERE item_kind = $1
       AND workspace_id IS NULL
       AND is_active = TRUE`,
    [itemKind],
  );
  return Number(result.rows[0]?.count || 0);
}

export async function seedDatabase() {
  console.log("Seeding refactored database...");
  await ensureStorageDir();

  const passwordHash = await hash("demo1234", 10);
  const userResult = await query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('demo@synapse.dev', 'Demo User', $1)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()
     RETURNING id`,
    [passwordHash],
  );
  const userId = userResult.rows[0]!.id;

  await ensureSeedPlatformAdminForUser({
    id: userId,
    email: "demo@synapse.dev",
  });
  await seedPlatformDefaultGroup();

  const workspaceId = await seedDemoWorkspace(userId);
  const actorCatalogRefs = await seedActorCatalog(userId);
  const importedSkillCount = await seedOfficialSkills(userId);
  await seedBuiltinMcpPlugins();
  const runtimeRefs = await seedRuntime(workspaceId, userId, actorCatalogRefs);
  const [skillMarketplaceCount, pluginMarketplaceCount] = await Promise.all([
    countCatalogItems("skill_package"),
    countCatalogItems("plugin_package"),
  ]);

  const authzEntryIds = await enqueueAuthzRelationships(
    [
      touchRelation("platform", AUTHZ_PLATFORM_ID, "workspace", "workspace", workspaceId),
      touchRelation("workspace", workspaceId, "platform", "platform", AUTHZ_PLATFORM_ID),
      touchRelation("workspace", workspaceId, "owner", "user", userId),
      touchRelation("workspace", workspaceId, "member", "user", userId),
      touchRelation("workspace", workspaceId, "actor", "actor", runtimeRefs.actorId),
      touchRelation("actor", runtimeRefs.actorId, "workspace", "workspace", workspaceId),
      touchRelation("actor", runtimeRefs.actorId, "discover_workspace", "workspace", workspaceId),
      touchRelation("actor", runtimeRefs.actorId, "invoke_workspace", "workspace", workspaceId),
      touchRelation("actor", runtimeRefs.actorId, "receive_workspace", "workspace", workspaceId),
      touchRelation("actor", runtimeRefs.actorId, "owner", "user", userId),
    ],
    {
      source: "db.seed.v2",
      workspaceId,
    },
  );

  if (authzEntryIds.length > 0) {
    try {
      await flushAuthzOutboxEntries(authzEntryIds);
    } catch (error) {
      console.error("[authz] Failed to flush v2 seed relationships:", error);
    }
  }

  console.log("Seed completed", {
    userId,
    workspaceId,
    actorId: runtimeRefs.actorId,
    importedSkillCount,
    skillMarketplaceCount,
    pluginMarketplaceCount,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  seedDatabase()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
