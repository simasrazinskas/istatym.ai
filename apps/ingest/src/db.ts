import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Lazily-created Postgres connection pool, mirroring apps/web's db.ts so both
 * planes share the same connection conventions. Constructed on first query so
 * importing this module never requires a live database or `DATABASE_URL`.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    // A modest pool: the bulk loader is single-writer; the headroom covers the
    // occasional concurrent count/verify query.
    pool = new Pool({ connectionString, max: 8 });
  }
  return pool;
}

/** Run a parameterized query against the shared pool. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Run `fn` inside a single transaction, committing on success. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Close the shared pool (CLIs call this so the process exits promptly). */
export async function endPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
