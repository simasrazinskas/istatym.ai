import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, withTransaction } from './db';

/**
 * Forward-only migration runner, a sibling of apps/web's runner. It applies
 * every `*.sql` file across the migration directories below exactly once,
 * tracked in `schema_migrations`. Idempotent: safe to run on every boot.
 *
 * Migration 001 lives in apps/web (the single source of truth for the base
 * schema) and 002 lives here. Reading both directories keeps 001 un-duplicated
 * while letting the ingest plane stand up a complete schema on a fresh database.
 * Files are merged and applied in lexicographic order, so 001 precedes 002.
 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIGRATION_DIRS = [
  path.resolve(PKG_ROOT, '..', 'web', 'db', 'migrations'),
  path.resolve(PKG_ROOT, 'db', 'migrations'),
];

export async function runMigrations(): Promise<string[]> {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  // Collect (filename -> absolute path) across every directory, then sort by
  // filename. Duplicate filenames across dirs would collide on the PK, so the
  // 001/002 split keeps names distinct.
  const files: { filename: string; fullPath: string }[] = [];
  for (const dir of MIGRATION_DIRS) {
    const names = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    for (const name of names) {
      files.push({ filename: name, fullPath: path.join(dir, name) });
    }
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));

  const { rows } = await getPool().query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file.filename)) continue;
    const sql = await readFile(file.fullPath, 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file.filename]);
    });
    newlyApplied.push(file.filename);
  }
  return newlyApplied;
}
