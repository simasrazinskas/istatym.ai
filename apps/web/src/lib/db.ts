import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/**
 * Lazily-created Postgres connection pool. The pool is only constructed on the
 * first query so that importing this module (e.g. during `next build`) never
 * requires a live database or `DATABASE_URL`.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString, max: 5 });
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
