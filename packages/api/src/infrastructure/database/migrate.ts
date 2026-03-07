import { query } from './index.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('Running migrations...');

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

  try {
    await query(sql);
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }

  process.exit(0);
}

migrate();
