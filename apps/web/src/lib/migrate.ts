import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, withTransaction } from './db';

/**
 * Minimal forward-only migration runner. Applies every `*.sql` file in
 * `db/migrations` (lexicographically ordered) exactly once, tracked in a
 * `schema_migrations` table. Idempotent: safe to run on every boot.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

export async function runMigrations(): Promise<string[]> {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await getPool().query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
