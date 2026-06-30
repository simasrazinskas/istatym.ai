/**
 * Bulk corpus ingest: stream each Spinta model as JSONL, archive every record
 * verbatim into raw_archive, derive normalized work/expression/priedas rows, and
 * synthesize fallback expressions for works without a consolidation.
 *
 *   DATABASE_URL=postgres://... pnpm ingest:bulk                 # full corpus
 *   DATABASE_URL=postgres://... pnpm ingest:bulk --model Dokumentas --limit 2000
 *   DATABASE_URL=postgres://... pnpm ingest:bulk --no-synthesize
 *
 * Idempotent and resumable: re-running re-archives nothing (unique key) and
 * re-derives the same rows (upserts). `--limit` caps records per model for
 * bounded test runs; `--model` restricts to a single model.
 *
 * Run order matters when loading the full corpus: Dokumentas (creates works)
 * must precede Suvestine (attaches expressions to works by dokumento_id).
 */
import { runMigrations } from '../src/migrate';
import { getPool, endPool, withTransaction } from '../src/db';
import {
  countModel,
  latestCid,
  streamModel,
  MODELS,
  type Model,
  type SpintaRecord,
} from '../src/spinta';
import {
  archiveRecords,
  synthesizeExpressions,
  upsertExpressionFromSuvestine,
  upsertPriedas,
  upsertWorkFromDokumentas,
} from '../src/load';

interface Args {
  model?: Model;
  limit?: number;
  synthesize: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { synthesize: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--model') {
      const v = argv[(i += 1)];
      if (!MODELS.includes(v as Model)) throw new Error(`--model must be one of ${MODELS.join(', ')}`);
      args.model = v as Model;
    } else if (a === '--limit') {
      args.limit = Number(argv[(i += 1)]);
      if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('--limit must be a positive number');
    } else if (a === '--no-synthesize') {
      args.synthesize = false;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const BATCH_SIZE = 500;

async function deriveBatch(model: Model, batch: SpintaRecord[]): Promise<void> {
  await withTransaction(async (client) => {
    await archiveRecords(client, model, batch);
    for (const rec of batch) {
      if (model === 'Dokumentas') await upsertWorkFromDokumentas(client, rec);
      else if (model === 'Suvestine') await upsertExpressionFromSuvestine(client, rec);
      else await upsertPriedas(client, rec);
    }
  });
}

async function loadModel(model: Model, limit?: number): Promise<number> {
  // Record the baseline CDC watermark BEFORE streaming, so the first CDC run
  // resumes from this snapshot. ON CONFLICT DO NOTHING preserves any watermark a
  // prior CDC run already advanced past.
  const baseline = await latestCid(model);
  await getPool().query(
    'INSERT INTO sync_state (model, last_cid) VALUES ($1, $2) ON CONFLICT (model) DO NOTHING',
    [model, baseline],
  );

  let count = 0;
  let batch: SpintaRecord[] = [];
  for await (const record of streamModel(model, { limit })) {
    batch.push(record);
    if (batch.length >= BATCH_SIZE) {
      await deriveBatch(model, batch);
      count += batch.length;
      batch = [];
      process.stdout.write(`\r  ${model}: ${count} records archived`);
    }
  }
  if (batch.length > 0) {
    await deriveBatch(model, batch);
    count += batch.length;
  }
  process.stdout.write(`\r  ${model}: ${count} records archived\n`);
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runMigrations();

  const models = args.model ? [args.model] : MODELS;
  const totals: Record<string, number> = {};
  for (const model of models) {
    const live = await countModel(model).catch(() => NaN);
    console.log(`Loading ${model} (live count: ${Number.isNaN(live) ? '?' : live})...`);
    totals[model] = await loadModel(model, args.limit);
  }

  if (args.synthesize) {
    const synthesized = await withTransaction((client) => synthesizeExpressions(client));
    console.log(`Synthesized ${synthesized} fallback expression(s).`);
  }

  console.log('Bulk ingest complete:');
  for (const [model, n] of Object.entries(totals)) console.log(`  ${model}: ${n} archived`);
  await endPool();
}

main().catch(async (err) => {
  console.error('\n', err);
  await endPool();
  process.exit(1);
});
