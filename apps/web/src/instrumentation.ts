/**
 * Runs once when the Node server boots. Applies database migrations and, if the
 * in-scope work has no data yet, bootstraps it from Spinta. Both steps are
 * guarded so a transient failure never crashes the server.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.DATABASE_URL) {
    console.warn('[startup] DATABASE_URL not set; skipping migrations and bootstrap');
    return;
  }

  const { runMigrations } = await import('./lib/migrate');
  const { bootstrapIfEmpty } = await import('./lib/ingest');

  try {
    const applied = await runMigrations();
    if (applied.length > 0) console.log(`[startup] applied migrations: ${applied.join(', ')}`);
  } catch (err) {
    console.error('[startup] migrations failed:', err);
    return; // Without a schema there is nothing to bootstrap.
  }

  try {
    await bootstrapIfEmpty();
  } catch (err) {
    console.error('[startup] bootstrap ingest failed (non-fatal):', err);
  }
}
