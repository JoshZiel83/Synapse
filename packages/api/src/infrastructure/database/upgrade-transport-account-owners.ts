import { closeDatabasePool, query } from "./index.js";

const TABLE_NAME = "transport_accounts";

async function ensureColumns() {
  await query(`
    ALTER TABLE ${TABLE_NAME}
      ADD COLUMN IF NOT EXISTS owner_scope VARCHAR(30),
      ADD COLUMN IF NOT EXISTS owner_user_id UUID;
  `);
}

async function ensureDefaults() {
  await query(`
    UPDATE ${TABLE_NAME}
       SET owner_scope = COALESCE(owner_scope, 'workspace')
     WHERE owner_scope IS NULL;
  `);

  await query(`
    ALTER TABLE ${TABLE_NAME}
      ALTER COLUMN owner_scope SET DEFAULT 'workspace',
      ALTER COLUMN owner_scope SET NOT NULL;
  `);
}

async function ensureConstraints() {
  await query(`
    UPDATE ${TABLE_NAME}
       SET owner_scope = 'workspace'
     WHERE owner_scope = 'workspace_user'
       AND owner_user_id IS NULL;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'transport_accounts_owner_scope_check'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT transport_accounts_owner_scope_check
          CHECK (owner_scope IN ('workspace', 'workspace_user'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'transport_accounts_owner_consistency_check'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT transport_accounts_owner_consistency_check
          CHECK (
            (owner_scope = 'workspace' AND owner_user_id IS NULL) OR
            (owner_scope = 'workspace_user' AND owner_user_id IS NOT NULL)
          );
      END IF;
    END $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'transport_accounts_owner_user_id_fkey'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT transport_accounts_owner_user_id_fkey
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
}

async function ensureIndexes() {
  await query(`
    CREATE INDEX IF NOT EXISTS idx_transport_accounts_owner_user
      ON ${TABLE_NAME}(owner_user_id, created_at DESC)
      WHERE owner_user_id IS NOT NULL;
  `);
}

async function main() {
  console.log("Applying transport account owner upgrade...");

  await ensureColumns();
  await ensureDefaults();
  await ensureConstraints();
  await ensureIndexes();

  console.log("Transport account owner upgrade completed successfully");
}

main()
  .catch((error) => {
    console.error("Transport account owner upgrade failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
