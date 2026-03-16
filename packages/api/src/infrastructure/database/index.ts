import pg from "pg";
import { config } from "../../config/index.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
});

type RequiredSchemaSpec = {
  table: string;
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
    `Database schema is not on the current access model. ${details}. Run \`npm run db:reset\` to rebuild the database.`,
  );
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
