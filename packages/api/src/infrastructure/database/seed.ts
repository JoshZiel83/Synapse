import { query } from './index.js';
import bcryptjs from 'bcryptjs';
const { hash } = bcryptjs;
import { normalizeActorDocs, SECRETARY_DEFAULT_DOCS, textBlocks } from '@synapse/shared';

function buildSeedDocs(title: string, roleCharter: string, workDoctrine: string) {
  return normalizeActorDocs([
    {
      key: 'identity_card',
      title: 'Identity Card',
      content: textBlocks(`I am ${title}.`),
      visibility: 'always',
      priority: 120,
    },
    {
      key: 'role_charter',
      title: 'Role Charter',
      content: textBlocks(roleCharter),
      visibility: 'always',
      priority: 90,
    },
    {
      key: 'work_doctrine',
      title: 'Work Doctrine',
      content: textBlocks(workDoctrine),
      visibility: 'always',
      priority: 86,
    },
  ]);
}

async function seed() {
  console.log('Seeding database...');

  // Create demo user
  const passwordHash = await hash('demo1234', 10);
  const userResult = await query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('demo@synapse.dev', 'Demo User', $1)
     ON CONFLICT (email) DO UPDATE SET name = 'Demo User'
     RETURNING id`,
    [passwordHash]
  );
  const userId = userResult.rows[0].id;
  console.log('Created demo user:', userId);

  // Create demo workspace
  const wsResult = await query(
    `INSERT INTO workspaces (name, slug, description, owner_id)
     VALUES ('Demo Workspace', 'demo-workspace', 'A demo workspace for testing', $1)
     ON CONFLICT (slug) DO UPDATE SET description = 'A demo workspace for testing'
     RETURNING id`,
    [userId]
  );
  const workspaceId = wsResult.rows[0].id;
  console.log('Created demo workspace:', workspaceId);

  // Add user as workspace owner
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, trust_level)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [workspaceId, userId]
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
      ['delegation', 'reporting', 'organization'],
    ]
  );

  if (secResult.rows.length > 0) {
    const secretaryId = secResult.rows[0].id;
    console.log('Created secretary:', secretaryId);

    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Secretary', 'secretary', 'Personal Secretary', NULL, NULL, false, $2, '{}', $3)`,
      [secretaryId, JSON.stringify(secretaryDocs), ['delegation', 'reporting', 'organization']]
    );

    // Create a specialist subordinate
    const developerDocs = buildSeedDocs(
      'Software Developer',
      'Responsible for coding tasks, code review, and technical implementation.',
      'Write clean, well-structured code. Report progress and results clearly.',
    );
    const devResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, docs, parent_id, capabilities)
       VALUES ($1, 'Developer', 'specialist', 'Software Developer', $2, $3, $4)
       RETURNING id`,
      [workspaceId, JSON.stringify(developerDocs), secretaryId, ['code.write', 'code.review', 'code.debug']]
    );
    console.log('Created developer:', devResult.rows[0].id);
    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Developer', 'specialist', 'Software Developer', NULL, $2, false, $3, '{}', $4)`,
      [devResult.rows[0].id, secretaryId, JSON.stringify(developerDocs), ['code.write', 'code.review', 'code.debug']]
    );

    // Create a researcher subordinate
    const researcherDocs = buildSeedDocs(
      'Research Analyst',
      'Responsible for research tasks, information gathering, and analysis.',
      'Gather relevant information, analyze it, and present findings clearly.',
    );
    const resResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, docs, parent_id, capabilities)
       VALUES ($1, 'Researcher', 'specialist', 'Research Analyst', $2, $3, $4)
       RETURNING id`,
      [workspaceId, JSON.stringify(researcherDocs), secretaryId, ['research', 'analysis', 'summarization']]
    );
    console.log('Created researcher:', resResult.rows[0].id);
    await query(
      `INSERT INTO actor_versions (
         actor_id, version, name, role, title, avatar_file_id, parent_id, can_represent_user, docs, config, capabilities
       )
       VALUES ($1, 1, 'Researcher', 'specialist', 'Research Analyst', NULL, $2, false, $3, '{}', $4)`,
      [resResult.rows[0].id, secretaryId, JSON.stringify(researcherDocs), ['research', 'analysis', 'summarization']]
    );
  }

  console.log('Seed completed');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
