/**
 * Manual ingest entry point: fetch the target work's current consolidation from
 * Spinta and (re)load it into Postgres. Idempotent.
 *
 *   DATABASE_URL=postgres://... pnpm ingest
 */
import { runMigrations } from '../src/lib/migrate';
import { ingestTargetWork, TARGET_WORK } from '../src/lib/ingest';

async function main() {
  await runMigrations();
  const { articleCount } = await ingestTargetWork();
  console.log(`Ingested ${TARGET_WORK.tar_kodas}: ${articleCount} articles.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
