import { closeDatabasePool, query } from "./index.js";

const TABLE_NAME = "auth_qr_login_requests";

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      scan_token_hash VARCHAR(128) UNIQUE NOT NULL,
      browser_token_hash VARCHAR(128) UNIQUE NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending_scan',
      browser_ip_address VARCHAR(120),
      browser_user_agent TEXT,
      browser_label VARCHAR(160) NOT NULL,
      approved_session_persistence VARCHAR(20),
      resolver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      scanned_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

async function ensureColumns() {
  await query(`
    ALTER TABLE ${TABLE_NAME}
      ADD COLUMN IF NOT EXISTS scan_token_hash VARCHAR(128),
      ADD COLUMN IF NOT EXISTS browser_token_hash VARCHAR(128),
      ADD COLUMN IF NOT EXISTS status VARCHAR(32),
      ADD COLUMN IF NOT EXISTS browser_ip_address VARCHAR(120),
      ADD COLUMN IF NOT EXISTS browser_user_agent TEXT,
      ADD COLUMN IF NOT EXISTS browser_label VARCHAR(160),
      ADD COLUMN IF NOT EXISTS approved_session_persistence VARCHAR(20),
      ADD COLUMN IF NOT EXISTS resolver_user_id UUID,
      ADD COLUMN IF NOT EXISTS approved_by_user_id UUID,
      ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `);
}

async function ensureDefaults() {
  await query(`
    ALTER TABLE ${TABLE_NAME}
      ALTER COLUMN status SET DEFAULT 'pending_scan',
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at SET DEFAULT NOW();
  `);
}

async function ensureConstraints() {
  await query(`
    UPDATE ${TABLE_NAME}
       SET status = COALESCE(status, 'pending_scan'),
           browser_label = COALESCE(browser_label, 'This browser'),
           expires_at = COALESCE(expires_at, NOW() + INTERVAL '3 minutes')
     WHERE status IS NULL
        OR browser_label IS NULL
        OR expires_at IS NULL;
  `);

  await query(`
    ALTER TABLE ${TABLE_NAME}
      ALTER COLUMN scan_token_hash SET NOT NULL,
      ALTER COLUMN browser_token_hash SET NOT NULL,
      ALTER COLUMN status SET NOT NULL,
      ALTER COLUMN browser_label SET NOT NULL,
      ALTER COLUMN expires_at SET NOT NULL;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'auth_qr_login_requests_status_check'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT auth_qr_login_requests_status_check
          CHECK (status IN ('pending_scan', 'pending_confirm', 'approved', 'rejected', 'expired', 'consumed'));
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'auth_qr_login_requests_approved_session_persistence_check'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT auth_qr_login_requests_approved_session_persistence_check
          CHECK (approved_session_persistence IN ('persistent', 'temporary'));
      END IF;
    END $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'auth_qr_login_requests_resolver_user_id_fkey'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT auth_qr_login_requests_resolver_user_id_fkey
          FOREIGN KEY (resolver_user_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'auth_qr_login_requests_approved_by_user_id_fkey'
      ) THEN
        ALTER TABLE ${TABLE_NAME}
          ADD CONSTRAINT auth_qr_login_requests_approved_by_user_id_fkey
          FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
}

async function ensureIndexes() {
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_qr_login_requests_scan_token_hash
      ON ${TABLE_NAME}(scan_token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_qr_login_requests_browser_token_hash
      ON ${TABLE_NAME}(browser_token_hash);
    CREATE INDEX IF NOT EXISTS idx_auth_qr_login_requests_expires
      ON ${TABLE_NAME}(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_qr_login_requests_resolver
      ON ${TABLE_NAME}(resolver_user_id, created_at DESC);
  `);
}

async function main() {
  console.log("Applying auth QR login database upgrade...");

  await ensureTable();
  await ensureColumns();
  await ensureDefaults();
  await ensureConstraints();
  await ensureIndexes();

  console.log("Auth QR login database upgrade completed successfully");
}

main()
  .catch((error) => {
    console.error("Auth QR login database upgrade failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
