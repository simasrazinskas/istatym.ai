/**
 * Incremental CDC sync: read each model's `/:changes` feed after its stored
 * watermark, dedupe + apply, and re-process only the touched works.
 *
 *   DATABASE_URL=postgres://... pnpm ingest:cdc                 # all models
 *   DATABASE_URL=postgres://... pnpm ingest:cdc --model Suvestine
 *
 * Per page: archive the upserts (with their _cid/_op), re-derive the touched
 * rows, apply deletes, advance the watermark only past applied changes, then
 * re-synthesize fallback expressions and re-classify the touched works. The
 * dedupe (planDelta) guards the Spinta pagination-boundary bug.
 *
 * Validity rollover (decision D2) needs no work here: "current law" is the
 * query-time date predicate (see the current_expression view), so an expression
 * whose window closes overnight is excluded automatically with no data change.
 */
import { runMigrations } from '../src/migrate';
import { getPool, endPool, withTransaction } from '../src/db';
import { fetchChanges, MODELS, type Model } from '../src/spinta';
import { planDelta } from '../src/cdc';
import {
  applyDelete,
  archiveRecords,
  classifyAllWorks,
  synthesizeExpressions,
  upsertExpressionFromSuvestine,
  upsertWorkFromDokumentas,
  upsertPriedas,
} from '../src/load';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 1000; // safety bound against a runaway boundary loop

async function getWatermark(model: Model): Promise<number> {
  const { rows } = await getPool().query<{ last_cid: string }>(
    'SELECT last_cid FROM sync_state WHERE model = $1',
    [model],
  );
  return rows[0] ? Number(rows[0].last_cid) : 0;
}

async function syncModel(model: Model): Promise<{ applied: number; watermark: number }> {
  let watermark = await getWatermark(model);
  let totalApplied = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const changes = await fetchChanges(model, watermark + 1, PAGE_LIMIT);
    if (changes.length === 0) break;

    const plan = planDelta(changes, watermark);
    if (plan.newWatermark <= watermark && plan.upserts.length === 0 && plan.deletes.length === 0) {
      // Nothing new survived the dedupe; advance past the page to avoid looping.
      const maxCid = Math.max(...changes.map((c) => c._cid));
      if (maxCid <= watermark) break;
      watermark = maxCid;
      continue;
    }

    const touched = new Set<string>();
    await withTransaction(async (client) => {
      if (plan.upserts.length > 0) {
        await archiveRecords(client, model, plan.upserts);
        for (const change of plan.upserts) {
          if (model === 'Dokumentas') {
            const id = await upsertWorkFromDokumentas(client, change);
            if (id) touched.add(id);
          } else if (model === 'Suvestine') {
            const { workId } = await upsertExpressionFromSuvestine(client, change);
            if (workId) touched.add(workId);
          } else {
            await upsertPriedas(client, change);
          }
        }
      }
      for (const change of plan.deletes) {
        await archiveRecords(client, model, [change]);
        await applyDelete(client, model, change);
      }
      // Re-derive + re-classify only the touched works.
      await synthesizeExpressions(client);
      if (touched.size > 0) await classifyAllWorks(client, [...touched]);

      await client.query(
        `INSERT INTO sync_state (model, last_cid, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (model) DO UPDATE SET last_cid = EXCLUDED.last_cid, updated_at = now()`,
        [model, plan.newWatermark],
      );
    });

    totalApplied += plan.upserts.length + plan.deletes.length;
    watermark = plan.newWatermark;
    if (changes.length < PAGE_LIMIT) break; // drained
  }

  return { applied: totalApplied, watermark };
}

async function main() {
  await runMigrations();
  const argv = process.argv.slice(2);
  let only: Model | undefined;
  if (argv[0] === '--model') {
    if (!MODELS.includes(argv[1] as Model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`);
    only = argv[1] as Model;
  }

  for (const model of only ? [only] : MODELS) {
    const { applied, watermark } = await syncModel(model);
    console.log(`${model}: applied ${applied} change(s), watermark now ${watermark}`);
  }

  await endPool();
}

main().catch(async (err) => {
  console.error(err);
  await endPool();
  process.exit(1);
});
