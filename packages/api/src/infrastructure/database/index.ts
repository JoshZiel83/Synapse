import pg from "pg"
import { config } from "../../config/index.js"
import { createLogger } from "../logger/index.js"
import type { DatabaseTable } from "./db-types.js"

const { Pool } = pg

const log = createLogger("database")

/**
 * @internal Connection pool. Owned by the database infrastructure layer only:
 * `kysely.ts` builds the `db`/`Executor` on top of it, and the schema-health
 * functions below run their bootstrap-time `information_schema` probes on it.
 * Business modules must NEVER import this — use `db`/`Executor` +
 * `sql<Row>`...`.execute(executor)` instead (enforced by guard-db-paradigm).
 */
export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
})

type RequiredSchemaSpec = {
  table: DatabaseTable
  requiredColumns: string[]
  reason: string
}

/**
 * Map a camelCase Kysely table/column identifier back to its physical
 * snake_case name. The Kysely surface is now fully camelCase
 * (`CamelCasePlugin`), but Postgres — and therefore `information_schema` — keeps
 * the snake_case names. This bootstrap probe runs raw SQL against
 * `information_schema`, so identifiers must be snake-ified at the boundary. This
 * matches Kysely's own default `createSnakeCaseMapper` for these identifiers
 * (insert `_` before each uppercase letter, lowercased).
 */
function toPhysicalName(identifier: string): string {
  return identifier.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
}

type RequiredSchemaIssue = {
  table: string
  missingColumns: string[]
  reason: string
}

const REQUIRED_SCHEMA_SPECS: RequiredSchemaSpec[] = [
  {
    table: "users",
    requiredColumns: ["id", "email", "email_verified"],
    reason: "auth and seed users (Better Auth user table)",
  },
  {
    table: "workspaces",
    requiredColumns: ["id", "owner_id", "slug"],
    reason: "workspace bootstrap and navigation",
  },
  {
    table: "workspaceMembers",
    requiredColumns: ["workspace_id", "user_id", "trust_level"],
    reason: "base workspace access",
  },
  {
    table: "workspaceRelationshipProfiles",
    requiredColumns: [
      "workspace_id",
      "subject_id",
      "identity_id",
      "identity_search_enabled",
      "approval_mode",
      "qr_token",
    ],
    reason: "workspace-scoped relationship identities and QR profiles",
  },
  {
    table: "workspaceFriendRequests",
    requiredColumns: [
      "requester_workspace_member_id",
      "target_subject_id",
      "status",
    ],
    reason: "workspace-scoped relationship requests",
  },
  {
    table: "workspaceFriendEntries",
    requiredColumns: [
      "workspace_id",
      "owner_workspace_member_id",
      "peer_subject_id",
    ],
    reason: "workspace-scoped relationship entries",
  },
  {
    table: "directConversationBindings",
    requiredColumns: [
      "conversation_id",
      "participant_one_subject_id",
      "participant_two_subject_id",
    ],
    reason: "authoritative direct-conversation uniqueness",
  },
  {
    table: "workspaceMemberPreferences",
    requiredColumns: ["workspace_member_id", "chief_actor_id"],
    reason: "workspace-level chief actor preferences",
  },
  {
    table: "transportAccounts",
    requiredColumns: [
      "workspace_id",
      "transport_kind",
      "account_key",
      "owner_scope",
      "owner_workspace_member_id",
    ],
    reason: "IM transport account ownership",
  },
  {
    table: "platformAccessBindings",
    requiredColumns: ["user_id", "access_key", "source"],
    reason: "platform access bindings",
  },
  {
    table: "workspaceAccessBindings",
    requiredColumns: ["workspace_member_id", "access_key"],
    reason: "workspace access bindings",
  },
  {
    table: "account",
    requiredColumns: ["id", "account_id", "provider_id", "user_id"],
    reason: "Better Auth account table (credentials + OAuth identities)",
  },
  {
    table: "session",
    requiredColumns: ["id", "user_id", "token", "expires_at"],
    reason: "Better Auth session table",
  },
  {
    table: "verification",
    requiredColumns: ["id", "identifier", "value", "expires_at"],
    reason: "Better Auth verification table",
  },
  {
    table: "deviceCode",
    requiredColumns: ["id", "device_code", "user_code", "status", "expires_at"],
    reason: "Better Auth deviceAuthorization (cross-device QR login)",
  },
  {
    table: "realtimeEventOutbox",
    requiredColumns: [
      "event_type",
      "workspace_id",
      "recipient_workspace_member_id",
      "payload",
      "event_timestamp",
      "available_at",
      "status",
    ],
    reason: "transactional realtime event outbox",
  },
  {
    table: "toolCallTasks",
    requiredColumns: [
      "session_id",
      "principal_subject_id",
      "source_tool_name",
      "executor_kind",
      "delivery_kind",
      "human_surface",
      "lifecycle_status",
      "revision",
      "request_key",
      "supports_cancel",
      "supports_output_tail",
    ],
    reason: "unified task governance and lifecycle persistence",
  },
  {
    table: "toolCallTaskOutputChunks",
    requiredColumns: ["task_id", "seq", "stream", "text_value"],
    reason: "task output tail persistence",
  },
  {
    table: "toolCallTaskRuntimeAuthorization",
    requiredColumns: [
      "task_id",
      "runtime_id",
      "runtime_capability_id",
      "runtime_exposure_id",
      "requested_tool_name",
      "runtime_tool_stable_key",
      "reason",
      "request_mode",
      "source_runtime_session_id",
      "source_retry_nonce",
      "source_request_args",
      "principal_subject_id",
      "requested_action",
      "grant_options",
      "available_presets",
      "dedupe_key",
    ],
    reason: "runtime authorization task detail (CTI)",
  },
  {
    table: "toolCallTaskResponseCommands",
    requiredColumns: [
      "task_id",
      "command_id",
      "base_revision",
      "outcome",
      "request_payload",
      "response_payload",
    ],
    reason: "task resolution command dedupe and replay",
  },
  {
    table: "runtimeAuthorizationGrants",
    requiredColumns: [
      "workspace_id",
      "runtime_id",
      "runtime_capability_id",
      "runtime_exposure_id",
      "subject_id",
      "scope_subject_id",
      "retention",
      "status",
      "policy",
      "source_request_args",
    ],
    reason: "server-authoritative runtime authorization grants",
  },
]

function summarizeParams(params?: any[]) {
  if (!params) return []
  return params.map((value) => {
    if (value === null || value === undefined) {
      return { type: String(value), value: null }
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: value.slice(0, 3),
      }
    }
    if (typeof value === "string") {
      return {
        type: "string",
        value: value.length > 160 ? `${value.slice(0, 160)}...` : value,
      }
    }
    if (typeof value === "object") {
      return {
        type: "object",
        value: JSON.stringify(value).slice(0, 160),
      }
    }
    return { type: typeof value, value }
  })
}

function logQueryFailure(
  text: string,
  params: any[] | undefined,
  err: unknown
) {
  const message = err instanceof Error ? err.message : String(err)
  log.error(
    {
      message,
      sql: text.replace(/\s+/g, " ").trim(),
      params: summarizeParams(params),
    },
    "[db.query] failed"
  )
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1")
    return true
  } catch {
    return false
  }
}

export async function inspectRequiredSchema(): Promise<RequiredSchemaIssue[]> {
  const tableNames = REQUIRED_SCHEMA_SPECS.map((spec) =>
    toPhysicalName(spec.table)
  )
  const sql = `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`
  let result: pg.QueryResult<{ table_name: string; column_name: string }>
  try {
    // Bootstrap-time schema probe: runs on the raw pool (this module owns it)
    // BEFORE the Kysely `db` is relied upon. Not a business query.
    result = await pool.query<{ table_name: string; column_name: string }>(
      sql,
      [tableNames]
    )
  } catch (err) {
    logQueryFailure(sql, [tableNames], err)
    throw err
  }

  const columnsByTable = new Map<string, Set<string>>()
  for (const row of result.rows) {
    const existing = columnsByTable.get(row.table_name) || new Set<string>()
    existing.add(row.column_name)
    columnsByTable.set(row.table_name, existing)
  }

  return REQUIRED_SCHEMA_SPECS.flatMap((spec) => {
    const physicalTable = toPhysicalName(spec.table)
    const existingColumns = columnsByTable.get(physicalTable)
    if (!existingColumns) {
      return [
        {
          table: physicalTable,
          missingColumns: [...spec.requiredColumns],
          reason: spec.reason,
        },
      ]
    }

    const missingColumns = spec.requiredColumns.filter(
      (column) => !existingColumns.has(column)
    )
    if (missingColumns.length === 0) {
      return []
    }

    return [
      {
        table: physicalTable,
        missingColumns,
        reason: spec.reason,
      },
    ]
  })
}

export async function testRequiredSchema(): Promise<boolean> {
  try {
    const issues = await inspectRequiredSchema()
    return issues.length === 0
  } catch {
    return false
  }
}

export async function assertRequiredSchema() {
  const issues = await inspectRequiredSchema()
  if (issues.length === 0) {
    return
  }

  const details = issues
    .map(
      (issue) =>
        `${issue.table} missing [${issue.missingColumns.join(", ")}] for ${issue.reason}`
    )
    .join("; ")

  throw new Error(
    `Database schema is not on the current access model. ${details}. Run \`npm run db:bootstrap\` to apply the current schema upgrade, or \`npm run db:rebuild\` to rebuild from scratch.`
  )
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end()
}
