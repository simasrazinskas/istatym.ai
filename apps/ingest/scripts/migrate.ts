/**
 * Apply pending migrations (001 from apps/web, 002 from here).
 *
 *   DATABASE_URL=postgres://... pnpm migrate
 */
import { runMigrations } from '../src/migrate';
import { endPool } from '../src/db';

async function main() {
  const applied = await runMigrations();
  if (applied.length === 0) console.log('No pending migrations.');
  else console.log(`Applied: ${applied.join(', ')}`);
  await endPool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
