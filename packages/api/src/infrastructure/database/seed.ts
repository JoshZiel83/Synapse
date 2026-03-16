import { query } from "./index.js";
import bcryptjs from "bcryptjs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  AUTHZ_PLATFORM_ID,
  enqueueAuthzRelationships,
  flushAuthzOutboxEntries,
  touchRelation,
} from "../authz/index.js";
import { ensureSeedPlatformAdminForUser } from "../../modules/platform/admin-service.js";
import { seedPlatformDefaultGroup } from "../../modules/model-groups/service.js";
const { hash } = bcryptjs;
import {
  normalizeActorDocs,
  SECRETARY_DEFAULT_DOCS,
  textBlocks,
} from "@synapse/shared";

const __filename = fileURLToPath(import.meta.url);

function buildSeedDocs(
  title: string,
  roleCharter: string,
  workDoctrine: string,
) {
  return normalizeActorDocs([
    {
      key: "identity_card",
      title: "Identity Card",
      content: textBlocks(`I am ${title}.`),
      visibility: "always",
      priority: 120,
    },
    {
      key: "role_charter",
      title: "Role Charter",
      content: textBlocks(roleCharter),
      visibility: "always",
      priority: 90,
    },
    {
      key: "work_doctrine",
      title: "Work Doctrine",
      content: textBlocks(workDoctrine),
      visibility: "always",
      priority: 86,
    },
  ]);
}

async function insertDefaultActorGrants(
  actorId: string,
  workspaceId: string,
  grantedBy?: string | null,
) {
  await query(
    `INSERT INTO actor_grants (
       actor_id,
       permission,
       grant_scope,
       workspace_id,
       status,
       granted_by,
       metadata
     )
     VALUES
       ($1, 'discover', 'workspace', $2, 'active', $3, '{}'::jsonb),
       ($1, 'invoke', 'workspace', $2, 'active', $3, '{}'::jsonb)`,
    [actorId, workspaceId, grantedBy ?? null],
  );
}

export async function seedDatabase() {
  console.log("Seeding database...");
  const authzEntries = [];

  // Create demo user
  const passwordHash = await hash("demo1234", 10);
  const userResult = await query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('demo@synapse.dev', 'Demo User', $1)
     ON CONFLICT (email) DO UPDATE SET name = 'Demo User'
     RETURNING id`,
    [passwordHash],
  );
  const userId = userResult.rows[0].id;
  console.log("Created demo user:", userId);
  await ensureSeedPlatformAdminForUser({
    id: userId,
    email: "demo@synapse.dev",
  });
  const platformGroupId = await seedPlatformDefaultGroup();
  console.log("Ensured platform default model group:", platformGroupId);

  // Create demo workspace
  const wsResult = await query(
    `INSERT INTO workspaces (name, slug, description, owner_id)
     VALUES ('Demo Workspace', 'demo-workspace', 'A demo workspace for testing', $1)
     ON CONFLICT (slug) DO UPDATE SET description = 'A demo workspace for testing'
     RETURNING id`,
    [userId],
  );
  const workspaceId = wsResult.rows[0].id;
  console.log("Created demo workspace:", workspaceId);

  // Add user as workspace owner
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [workspaceId, userId],
  );
  authzEntries.push(
    touchRelation(
      "platform",
      AUTHZ_PLATFORM_ID,
      "workspace",
      "workspace",
      workspaceId,
    ),
    touchRelation(
      "workspace",
      workspaceId,
      "platform",
      "platform",
      AUTHZ_PLATFORM_ID,
    ),
    touchRelation("workspace", workspaceId, "owner", "user", userId),
  );

  // Create secretary
  const secretaryDocs = SECRETARY_DEFAULT_DOCS;
  const secResult = await query(
    `INSERT INTO actors (workspace_id, name, role, title, docs, capabilities)
     VALUES ($1, 'Secretary', 'secretary', 'Personal Secretary', $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      JSON.stringify(secretaryDocs),
      ["delegation", "reporting", "organization"],
    ],
  );

  if (secResult.rows.length > 0) {
    const secretaryId = secResult.rows[0].id;
    console.log("Created secretary:", secretaryId);
    await insertDefaultActorGrants(secretaryId, workspaceId, userId);
    authzEntries.push(
      touchRelation("workspace", workspaceId, "actor", "actor", secretaryId),
      touchRelation(
        "actor",
        secretaryId,
        "workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        secretaryId,
        "discover_workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        secretaryId,
        "invoke_workspace",
        "workspace",
        workspaceId,
      ),
    );

    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Secretary', 'secretary', 'Personal Secretary', NULL, NULL, false, $2, '{}', $3)`,
      [
        secretaryId,
        JSON.stringify(secretaryDocs),
        ["delegation", "reporting", "organization"],
      ],
    );

    // Create a specialist subordinate
    const developerDocs = buildSeedDocs(
      "Software Developer",
      "Responsible for coding tasks, code review, and technical implementation.",
      "Write clean, well-structured code. Report progress and results clearly.",
    );
    const devResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, docs, parent_id, capabilities)
       VALUES ($1, 'Developer', 'specialist', 'Software Developer', $2, $3, $4)
       RETURNING id`,
      [
        workspaceId,
        JSON.stringify(developerDocs),
        secretaryId,
        ["code.write", "code.review", "code.debug"],
      ],
    );
    console.log("Created developer:", devResult.rows[0].id);
    await insertDefaultActorGrants(devResult.rows[0].id, workspaceId, userId);
    authzEntries.push(
      touchRelation(
        "workspace",
        workspaceId,
        "actor",
        "actor",
        devResult.rows[0].id,
      ),
      touchRelation(
        "actor",
        devResult.rows[0].id,
        "workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        devResult.rows[0].id,
        "discover_workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        devResult.rows[0].id,
        "invoke_workspace",
        "workspace",
        workspaceId,
      ),
    );
    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Developer', 'specialist', 'Software Developer', NULL, $2, false, $3, '{}', $4)`,
      [
        devResult.rows[0].id,
        secretaryId,
        JSON.stringify(developerDocs),
        ["code.write", "code.review", "code.debug"],
      ],
    );

    // Create a researcher subordinate
    const researcherDocs = buildSeedDocs(
      "Research Analyst",
      "Responsible for research tasks, information gathering, and analysis.",
      "Gather relevant information, analyze it, and present findings clearly.",
    );
    const resResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, docs, parent_id, capabilities)
       VALUES ($1, 'Researcher', 'specialist', 'Research Analyst', $2, $3, $4)
       RETURNING id`,
      [
        workspaceId,
        JSON.stringify(researcherDocs),
        secretaryId,
        ["research", "analysis", "summarization"],
      ],
    );
    console.log("Created researcher:", resResult.rows[0].id);
    await insertDefaultActorGrants(resResult.rows[0].id, workspaceId, userId);
    authzEntries.push(
      touchRelation(
        "workspace",
        workspaceId,
        "actor",
        "actor",
        resResult.rows[0].id,
      ),
      touchRelation(
        "actor",
        resResult.rows[0].id,
        "workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        resResult.rows[0].id,
        "discover_workspace",
        "workspace",
        workspaceId,
      ),
      touchRelation(
        "actor",
        resResult.rows[0].id,
        "invoke_workspace",
        "workspace",
        workspaceId,
      ),
    );
    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Researcher', 'specialist', 'Research Analyst', NULL, $2, false, $3, '{}', $4)`,
      [
        resResult.rows[0].id,
        secretaryId,
        JSON.stringify(researcherDocs),
        ["research", "analysis", "summarization"],
      ],
    );
  }

  const authzEntryIds = await enqueueAuthzRelationships(authzEntries, {
    source: "db.seed",
    workspaceId,
  });
  if (authzEntryIds.length > 0) {
    try {
      await flushAuthzOutboxEntries(authzEntryIds);
    } catch (error) {
      console.error(
        "[authz] Failed to flush db.seed relationship updates:",
        error,
      );
    }
  }

  console.log("Seed completed");
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
