import { closeDatabasePool, query } from "./index.js";

const BASE_TABLE = "interaction_requests";
const QUESTION_TABLE = "interaction_question_requests";
const RELAY_TABLE = "interaction_relay_authorization_requests";

async function tableExists(tableName: string) {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return Boolean(result.rows[0]?.exists);
}

async function columnExists(tableName: string, columnName: string) {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [tableName, columnName],
  );
  return Boolean(result.rows[0]?.exists);
}

async function ensureBaseTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${BASE_TABLE} (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      conversation_item_id UUID UNIQUE REFERENCES conversation_items(id) ON DELETE SET NULL,
      requester_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
      requester_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      requester_actor_id UUID REFERENCES actors(id) ON DELETE SET NULL,
      kind VARCHAR(40) NOT NULL
        CHECK (kind IN ('question_choice', 'relay_authorization')),
      status VARCHAR(40) NOT NULL DEFAULT 'pending'
        CHECK (
          status IN (
            'pending',
            'answered',
            'approved_pending_apply',
            'applied',
            'rejected',
            'expired',
            'apply_failed'
          )
        ),
      target_member_id UUID REFERENCES conversation_members(id) ON DELETE RESTRICT,
      target_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      resolved_by_member_id UUID REFERENCES conversation_members(id) ON DELETE SET NULL,
      resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      ADD COLUMN IF NOT EXISTS workspace_id UUID,
      ADD COLUMN IF NOT EXISTS conversation_id UUID,
      ADD COLUMN IF NOT EXISTS conversation_item_id UUID,
      ADD COLUMN IF NOT EXISTS requester_member_id UUID,
      ADD COLUMN IF NOT EXISTS requester_user_id UUID,
      ADD COLUMN IF NOT EXISTS requester_actor_id UUID,
      ADD COLUMN IF NOT EXISTS kind VARCHAR(40),
      ADD COLUMN IF NOT EXISTS status VARCHAR(40),
      ADD COLUMN IF NOT EXISTS target_member_id UUID,
      ADD COLUMN IF NOT EXISTS target_user_id UUID,
      ADD COLUMN IF NOT EXISTS resolved_by_member_id UUID,
      ADD COLUMN IF NOT EXISTS resolved_by_user_id UUID,
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      ALTER COLUMN status SET DEFAULT 'pending',
      ALTER COLUMN metadata SET DEFAULT '{}'::jsonb,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at SET DEFAULT NOW();
  `);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      ALTER COLUMN target_member_id DROP NOT NULL,
      ALTER COLUMN target_user_id DROP NOT NULL;
  `);

  await query(`
    UPDATE ${BASE_TABLE}
    SET target_member_id = NULL,
        target_user_id = NULL,
        updated_at = NOW()
    WHERE kind = 'relay_authorization';
  `);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      DROP CONSTRAINT IF EXISTS interaction_requests_target_requirement_chk;
  `);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      ADD CONSTRAINT interaction_requests_target_requirement_chk CHECK (
        (
          kind = 'question_choice'
          AND target_member_id IS NOT NULL
          AND target_user_id IS NOT NULL
        )
        OR (
          kind = 'relay_authorization'
          AND target_member_id IS NULL
          AND target_user_id IS NULL
        )
      );
  `);
}

async function ensureSubtypeTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS ${QUESTION_TABLE} (
      interaction_id UUID PRIMARY KEY REFERENCES ${BASE_TABLE}(id) ON DELETE CASCADE,
      prompt_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolution_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ${RELAY_TABLE} (
      interaction_id UUID PRIMARY KEY REFERENCES ${BASE_TABLE}(id) ON DELETE CASCADE,
      relay_device_id UUID NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
      relay_exposure_id UUID NOT NULL REFERENCES relay_exposures(id) ON DELETE CASCADE,
      requested_effect JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolution_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
}

async function backfillSubtypeRows() {
  const hasPromptPayload = await columnExists(BASE_TABLE, "prompt_payload");
  const hasRequestedEffect = await columnExists(BASE_TABLE, "requested_effect");
  const hasResolutionPayload = await columnExists(BASE_TABLE, "resolution_payload");
  const hasRelayDeviceId = await columnExists(BASE_TABLE, "relay_device_id");
  const hasRelayExposureId = await columnExists(BASE_TABLE, "relay_exposure_id");

  if (hasPromptPayload || hasResolutionPayload) {
    await query(`
      INSERT INTO ${QUESTION_TABLE} (
        interaction_id,
        prompt_payload,
        resolution_payload
      )
      SELECT id,
             COALESCE(prompt_payload, '{}'::jsonb),
             COALESCE(resolution_payload, '{}'::jsonb)
      FROM ${BASE_TABLE}
      WHERE kind = 'question_choice'
      ON CONFLICT (interaction_id) DO UPDATE
      SET prompt_payload = EXCLUDED.prompt_payload,
          resolution_payload = EXCLUDED.resolution_payload;
    `);
  }

  if (
    hasRequestedEffect &&
    hasResolutionPayload &&
    hasRelayDeviceId &&
    hasRelayExposureId
  ) {
    await query(`
      INSERT INTO ${RELAY_TABLE} (
        interaction_id,
        relay_device_id,
        relay_exposure_id,
        requested_effect,
        resolution_payload
      )
      SELECT id,
             relay_device_id,
             relay_exposure_id,
             COALESCE(requested_effect, '{}'::jsonb),
             COALESCE(resolution_payload, '{}'::jsonb)
      FROM ${BASE_TABLE}
      WHERE kind = 'relay_authorization'
        AND relay_device_id IS NOT NULL
        AND relay_exposure_id IS NOT NULL
      ON CONFLICT (interaction_id) DO UPDATE
      SET relay_device_id = EXCLUDED.relay_device_id,
          relay_exposure_id = EXCLUDED.relay_exposure_id,
          requested_effect = EXCLUDED.requested_effect,
          resolution_payload = EXCLUDED.resolution_payload;
    `);
  }
}

async function dropLegacyColumns() {
  await query(`DROP INDEX IF EXISTS idx_interaction_requests_device_pending;`);

  await query(`
    ALTER TABLE ${BASE_TABLE}
      DROP COLUMN IF EXISTS relay_device_id,
      DROP COLUMN IF EXISTS relay_exposure_id,
      DROP COLUMN IF EXISTS prompt_payload,
      DROP COLUMN IF EXISTS requested_effect,
      DROP COLUMN IF EXISTS resolution_payload;
  `);
}

async function ensureIndexes() {
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_interaction_requests_conversation_item_id
      ON ${BASE_TABLE}(conversation_item_id)
      WHERE conversation_item_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_interaction_requests_conversation
      ON ${BASE_TABLE}(conversation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interaction_requests_target
      ON ${BASE_TABLE}(target_user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_interaction_relay_authorization_requests_device
      ON ${RELAY_TABLE}(relay_device_id, interaction_id);
  `);
}

async function main() {
  console.log("Applying interactions database upgrade...");

  const hadBaseTable = await tableExists(BASE_TABLE);

  await ensureBaseTable();
  await ensureSubtypeTables();

  if (hadBaseTable) {
    await backfillSubtypeRows();
    await dropLegacyColumns();
  }

  await ensureIndexes();

  console.log("Interactions database upgrade completed successfully");
}

main()
  .catch((error) => {
    console.error("Interactions database upgrade failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });
