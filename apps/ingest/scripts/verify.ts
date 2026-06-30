/**
 * Verify: for each model, compare the distinct record count in raw_archive
 * against the live Spinta `select(count())`, and report match/mismatch.
 *
 *   DATABASE_URL=postgres://... pnpm ingest:verify
 *
 * This is the "counts match the API" acceptance check, runnable after a full
 * load. After a capped run (e.g. --limit 2000) it will report a mismatch by
 * design — that only proves the comparison itself works.
 */
import { getPool, endPool } from '../src/db';
import { countModel, MODELS } from '../src/spinta';

async function main() {
  let allMatch = true;
  for (const model of MODELS) {
    const [{ rows }, live] = await Promise.all([
      getPool().query<{ n: string }>(
        'SELECT count(DISTINCT record_id) AS n FROM raw_archive WHERE model = $1',
        [model],
      ),
      countModel(model).catch(() => NaN),
    ]);
    const archived = Number(rows[0]?.n ?? 0);
    const match = !Number.isNaN(live) && archived === live;
    if (!match) allMatch = false;
    const liveStr = Number.isNaN(live) ? '? (live query failed)' : String(live);
    console.log(`${model}: archived ${archived} vs live ${liveStr} -> ${match ? 'MATCH' : 'MISMATCH'}`);
  }
  await endPool();
  process.exit(allMatch ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
