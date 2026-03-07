import { query } from './index.js';
import bcryptjs from 'bcryptjs';
const { hash } = bcryptjs;
import { SECRETARY_DEFAULT_CHARTER, SECRETARY_DEFAULT_SYSTEM_PROMPT } from '@synapse/shared';

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
  const secResult = await query(
    `INSERT INTO actors (workspace_id, name, role, title, charter, system_prompt, capabilities)
     VALUES ($1, 'Secretary', 'secretary', 'Personal Secretary', $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      SECRETARY_DEFAULT_CHARTER,
      SECRETARY_DEFAULT_SYSTEM_PROMPT,
      ['delegation', 'reporting', 'organization'],
    ]
  );

  if (secResult.rows.length > 0) {
    const secretaryId = secResult.rows[0].id;
    console.log('Created secretary:', secretaryId);

    // Create a specialist subordinate
    const devResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, charter, system_prompt, parent_id, capabilities)
       VALUES ($1, 'Developer', 'specialist', 'Software Developer',
               'Responsible for coding tasks, code review, and technical implementation.',
               'You are a software developer. When given coding tasks, write clean, well-structured code. Report your progress and results clearly.',
               $2, $3)
       RETURNING id`,
      [workspaceId, secretaryId, ['code.write', 'code.review', 'code.debug']]
    );
    console.log('Created developer:', devResult.rows[0].id);

    // Create a researcher subordinate
    const resResult = await query(
      `INSERT INTO actors (workspace_id, name, role, title, charter, system_prompt, parent_id, capabilities)
       VALUES ($1, 'Researcher', 'specialist', 'Research Analyst',
               'Responsible for research tasks, information gathering, and analysis.',
               'You are a research analyst. When given research tasks, gather relevant information, analyze it, and present findings clearly.',
               $2, $3)
       RETURNING id`,
      [workspaceId, secretaryId, ['research', 'analysis', 'summarization']]
    );
    console.log('Created researcher:', resResult.rows[0].id);
  }

  console.log('Seed completed');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
