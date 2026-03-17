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
import { createActor } from "../../modules/organization/service.js";
import {
  installMarketplaceSkill,
  publishMarketplaceSkill,
} from "../../modules/skills/service.js";
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
  const secretary = await createActor({
    workspaceId,
    createdBy: userId,
    name: "Secretary",
    role: "secretary",
    title: "Personal Secretary",
    docs: secretaryDocs,
    capabilities: ["delegation", "reporting", "organization"],
  });
  console.log("Created secretary:", secretary.id);

  const developerDocs = buildSeedDocs(
    "Software Developer",
    "Responsible for coding tasks, code review, and technical implementation.",
    "Write clean, well-structured code. Report progress and results clearly.",
  );
  const developer = await createActor({
    workspaceId,
    createdBy: userId,
    name: "Developer",
    role: "specialist",
    title: "Software Developer",
    docs: developerDocs,
    parentId: secretary.id,
    capabilities: ["code.write", "code.review", "code.debug"],
  });
  console.log("Created developer:", developer.id);

  const researcherDocs = buildSeedDocs(
    "Research Analyst",
    "Responsible for research tasks, information gathering, and analysis.",
    "Gather relevant information, analyze it, and present findings clearly.",
  );
  const researcher = await createActor({
    workspaceId,
    createdBy: userId,
    name: "Researcher",
    role: "specialist",
    title: "Research Analyst",
    docs: researcherDocs,
    parentId: secretary.id,
    capabilities: ["research", "analysis", "summarization"],
  });
  console.log("Created researcher:", researcher.id);

  const meetingBrief = await publishMarketplaceSkill({
    slug: "meeting-brief",
    name: "Meeting Brief",
    description: {
      type: "text",
      text: "Turn messy meeting notes into a tight action-oriented brief.",
    },
    tags: ["meetings", "summary"],
    version: "1.0.0",
    changelog: "Initial release",
    authorUserId: userId,
    attachmentFiles: [
      {
        path: "references/brief-format.md",
        contentBlocks: textBlocks(
          [
            "# Meeting Brief",
            "",
            "You turn raw meeting notes into a concise brief with decisions, action items, owners, blockers, and follow-ups.",
            "",
            "Use a direct tone. Collapse repetition. Preserve concrete commitments and deadlines.",
          ].join("\n"),
        ),
      },
      {
        path: "references/checklist.md",
        contentBlocks: textBlocks(
          [
            "# Checklist",
            "",
            "- Capture decisions",
            "- Extract owners",
            "- Flag missing owners",
            "- Separate facts from open questions",
          ].join("\n"),
        ),
      },
    ],
  });

  await publishMarketplaceSkill({
    slug: "spec-review",
    name: "Spec Review",
    description: {
      type: "text",
      text: "Review a product or engineering spec for ambiguity, risk, and missing decisions.",
    },
    tags: ["product", "review"],
    version: "1.0.0",
    changelog: "Initial release",
    authorUserId: userId,
    attachmentFiles: [
      {
        path: "references/review-brief.md",
        contentBlocks: textBlocks(
          [
            "# Spec Review",
            "",
            "Review the spec for ambiguity, hidden scope, missing constraints, ownership gaps, rollout risk, and metrics blind spots.",
            "",
            "Return: strengths, risks, unclear areas, and decisions the team still needs to make.",
          ].join("\n"),
        ),
      },
      {
        path: "references/risk-lenses.md",
        contentBlocks: textBlocks(
          [
            "# Risk Lenses",
            "",
            "- Product ambiguity",
            "- Operational risk",
            "- Data and analytics gaps",
            "- Rollback and failure handling",
          ].join("\n"),
        ),
      },
    ],
  });

  await installMarketplaceSkill({
    workspaceId,
    marketSkillId: meetingBrief.id,
    useScope: "workspace",
    installedBy: userId,
  });

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
