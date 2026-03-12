import pg from 'pg';
import { config } from '../../config/index.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
});

function summarizeParams(params?: any[]) {
  if (!params) return [];
  return params.map((value) => {
    if (value === null || value === undefined) {
      return { type: String(value), value: null };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        length: value.length,
        sample: value.slice(0, 3),
      };
    }
    if (typeof value === 'string') {
      return {
        type: 'string',
        value: value.length > 160 ? `${value.slice(0, 160)}...` : value,
      };
    }
    if (typeof value === 'object') {
      return {
        type: 'object',
        value: JSON.stringify(value).slice(0, 160),
      };
    }
    return { type: typeof value, value };
  });
}

function logQueryFailure(text: string, params: any[] | undefined, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[db.query] failed:', {
    message,
    sql: text.replace(/\s+/g, ' ').trim(),
    params: summarizeParams(params),
  });
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
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
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const originalQuery = client.query.bind(client);
    client.query = (async (...args: any[]) => {
      try {
        return await (originalQuery as any)(...args);
      } catch (err) {
        const [text, params] = args;
        if (typeof text === 'string') {
          logQueryFailure(text, Array.isArray(params) ? params : undefined, err);
        } else {
          console.error('[db.query] failed:', {
            message: err instanceof Error ? err.message : String(err),
            config: text,
          });
        }
        throw err;
      }
    }) as typeof client.query;
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
