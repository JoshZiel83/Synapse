import pg from "pg";
import { config } from "../../config/index.js";
import type { DatabaseTable } from "./db-types.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
});

type RequiredSchemaSpec = {
  table: DatabaseTable;
  requiredColumns: string[];
  reason: string;
};

type RequiredSchemaIssue = {
  table: string;
  missingColumns: string[];
  reason: string;
};

const REQUIRED_SCHEMA_SPECS: RequiredSchemaSpec[] = [
  {
    table: "users",
    requiredColumns: ["id", "email", "password_hash"],
    reason: "auth and seed users",
  },
  {
    table: "workspaces",
    requiredColumns: ["id", "owner_id", "slug"],
    reason: "workspace bootstrap and navigation",
  },
  {
    table: "workspace_members",
    requiredColumns: ["workspace_id", "user_id", "trust_level"],
    reason: "base workspace access",
  },
  {
    table: "workspace_contacts",
    requiredColumns: [
      "workspace_id",
      "scope",
      "owner_user_id",
      "target_type",
      "target_workspace_id",
    ],
    reason: "unified workspace and personal contacts",
  },
  {
    table: "workspace_user_preferences",
    requiredColumns: ["workspace_id", "user_id", "chief_actor_id"],
    reason: "workspace-level chief actor preferences",
  },
  {
    table: "transport_accounts",
    requiredColumns: [
      "workspace_id",
      "transport_kind",
      "account_key",
      "owner_scope",
      "owner_user_id",
    ],
    reason: "IM transport account ownership",
  },
  {
    table: "platform_access_bindings",
    requiredColumns: ["user_id", "access_key", "source"],
    reason: "platform access bindings",
  },
  {
    table: "workspace_access_bindings",
    requiredColumns: ["workspace_id", "user_id", "access_key"],
    reason: "workspace access bindings",
  },
  {
    table: "auth_qr_login_requests",
    requiredColumns: [
      "id",
      "scan_token_hash",
      "browser_token_hash",
      "status",
      "browser_label",
      "approved_session_persistence",
      "expires_at",
    ],
    reason: "web QR login requests",
  },
  {
    table: "authz_outbox",
    requiredColumns: [
      "resource_type",
      "resource_id",
      "relation",
      "subject_type",
      "subject_id",
      "status",
    ],
    reason: "SpiceDB relationship outbox",
  },
  {
    table: "realtime_event_outbox",
    requiredColumns: [
      "event_type",
      "workspace_id",
      "payload",
      "event_timestamp",
      "available_at",
      "status",
    ],
    reason: "transactional realtime event outbox",
  },
  {
    table: "session_engine_branches",
    requiredColumns: [
      "session_id",
      "engine_kind",
      "binding_key",
      "native_state",
    ],
    reason: "provider/session branch persistence",
  },
  {
    table: "engine_branch_checkpoints",
    requiredColumns: [
      "branch_id",
      "engine_kind",
      "binding_key",
      "native_state",
    ],
    reason: "branch checkpoints and recovery",
  },
  {
    table: "interaction_question_requests",
    requiredColumns: ["interaction_id", "prompt_payload", "resolution_payload"],
    reason: "question interaction subtype storage",
  },
  {
    table: "tool_call_tasks",
    requiredColumns: [
      "session_id",
      "source_tool_name",
      "executor_kind",
      "delivery_policy",
      "status",
      "dispatch_status",
      "supports_cancel",
      "supports_output_tail",
    ],
    reason: "tool-call task governance",
  },
  {
    table: "tool_call_task_output_chunks",
    requiredColumns: ["task_id", "seq", "stream", "text_value"],
    reason: "task output tail persistence",
  },
  {
    table: "interaction_requests",
    requiredColumns: ["task_id", "conversation_id", "kind", "status"],
    reason: "interaction requests linked to task governance",
  },
  {
    table: "interaction_relay_authorization_requests",
    requiredColumns: [
      "interaction_id",
      "relay_device_id",
      "relay_exposure_id",
      "requested_effect",
      "resolution_payload",
    ],
    reason: "relay authorization interaction subtype storage",
  },
  {
    table: "relay_operations",
    requiredColumns: [
      "task_id",
      "runtime_session_id",
      "delivery_policy",
      "operation_timeout_ms",
      "expires_at",
    ],
    reason: "relay task operation persistence",
  },
];

function summarizeParams(params?: any[]) {
  if (!params) return [];
  return params.map((value) => {
    if (value === null || value === undefined) {
      return { type: String(value), value: null };
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: value.slice(0, 3),
      };
    }
    if (typeof value === "string") {
      return {
        type: "string",
        value: value.length > 160 ? `${value.slice(0, 160)}...` : value,
      };
    }
    if (typeof value === "object") {
      return {
        type: "object",
        value: JSON.stringify(value).slice(0, 160),
      };
    }
    return { type: typeof value, value };
  });
}

function logQueryFailure(
  text: string,
  params: any[] | undefined,
  err: unknown,
) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[db.query] failed:", {
    message,
    sql: text.replace(/\s+/g, " ").trim(),
    params: summarizeParams(params),
  });
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  try {
    return await pool.query<T>(text, params);
  } catch (err) {
    logQueryFailure(text, params, err);
    throw err;
  }
}

export async function getClient() {
  return pool.connect();
}

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const originalQuery = client.query.bind(client);
    client.query = (async (...args: any[]) => {
      try {
        return await (originalQuery as any)(...args);
      } catch (err) {
        const [text, params] = args;
        if (typeof text === "string") {
          logQueryFailure(
            text,
            Array.isArray(params) ? params : undefined,
            err,
          );
        } else {
          console.error("[db.query] failed:", {
            message: err instanceof Error ? err.message : String(err),
            config: text,
          });
        }
        throw err;
      }
    }) as typeof client.query;
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function inspectRequiredSchema(): Promise<RequiredSchemaIssue[]> {
  const tableNames = REQUIRED_SCHEMA_SPECS.map((spec) => spec.table);
  const result = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [tableNames],
  );

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const existing = columnsByTable.get(row.table_name) || new Set<string>();
    existing.add(row.column_name);
    columnsByTable.set(row.table_name, existing);
  }

  return REQUIRED_SCHEMA_SPECS.flatMap((spec) => {
    const existingColumns = columnsByTable.get(spec.table);
    if (!existingColumns) {
      return [
        {
          table: spec.table,
          missingColumns: [...spec.requiredColumns],
          reason: spec.reason,
        },
      ];
    }

    const missingColumns = spec.requiredColumns.filter(
      (column) => !existingColumns.has(column),
    );
    if (missingColumns.length === 0) {
      return [];
    }

    return [
      {
        table: spec.table,
        missingColumns,
        reason: spec.reason,
      },
    ];
  });
}

export async function testRequiredSchema(): Promise<boolean> {
  try {
    const issues = await inspectRequiredSchema();
    return issues.length === 0;
  } catch {
    return false;
  }
}

export async function assertRequiredSchema() {
  const issues = await inspectRequiredSchema();
  if (issues.length === 0) {
    return;
  }

  const details = issues
    .map(
      (issue) =>
        `${issue.table} missing [${issue.missingColumns.join(", ")}] for ${issue.reason}`,
    )
    .join("; ");

  throw new Error(
    `Database schema is not on the current access model. ${details}. Run \`npm run db:bootstrap\` to apply the current schema upgrade, or \`npm run db:rebuild\` to rebuild from scratch.`,
  );
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
