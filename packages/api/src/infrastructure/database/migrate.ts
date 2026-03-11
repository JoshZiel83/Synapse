import { query } from './index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('Resetting database schema...');

  await query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

  try {
    await query(sql);
    console.log('Database reset and schema creation completed successfully');
  } catch (error) {
    console.error('Database reset failed:', error);
    throw error;
  }

  process.exit(0);
}

migrate();
